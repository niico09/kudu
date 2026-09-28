import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────

const handleMap = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleMap.set(channel, handler)
    })
  }
}))

vi.mock('../../shared/channels', () => ({
  IPC: {
    SOFTWARE_UPDATE_CHECK: 'software-update:check',
    SOFTWARE_UPDATE_RUN: 'software-update:run',
    SOFTWARE_UPDATE_INSTALL_MANAGER: 'software-update:install-manager',
    SOFTWARE_UPDATE_PROGRESS: 'software-update:progress'
  }
}))

const mockCheckForUpdates = vi.fn()
const mockRunUpdates = vi.fn()
const mockInstallPackageManager = vi.fn()

vi.mock('../services/software-updater', () => ({
  checkForUpdates: (...args: unknown[]) => mockCheckForUpdates(...args),
  runUpdates: (...args: unknown[]) => mockRunUpdates(...args)
}))

// Only the install itself is faked: the allow-list that guards it stays real,
// because that check is the boundary between a renderer-supplied name and a
// shell.
vi.mock('../services/package-manager-install', async () => {
  const actual = await vi.importActual<typeof import('../services/package-manager-install')>(
    '../services/package-manager-install'
  )
  return {
    ...actual,
    installPackageManager: (...args: unknown[]) => mockInstallPackageManager(...args)
  }
})

import { registerSoftwareUpdaterIpc } from './software-updater.ipc'
import type { BrowserWindow } from 'electron'

// ── Helpers ──────────────────────────────────────────────────

function makeWindow(destroyed = false) {
  return {
    isDestroyed: () => destroyed,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

function invoke(channel: string, ...args: unknown[]) {
  const handler = handleMap.get(channel)
  if (!handler) throw new Error(`No handler registered for ${channel}`)
  return handler({} /* _event */, ...args)
}

// ── Tests ────────────────────────────────────────────────────

describe('software-updater IPC', () => {
  beforeEach(() => {
    handleMap.clear()
    vi.clearAllMocks()
  })

  it('registers every IPC handler', () => {
    const win = makeWindow()
    registerSoftwareUpdaterIpc(() => win)
    expect(handleMap.has('software-update:check')).toBe(true)
    expect(handleMap.has('software-update:run')).toBe(true)
    expect(handleMap.has('software-update:install-manager')).toBe(true)
  })

  // ── SOFTWARE_UPDATE_CHECK ──────────────────────────────────

  describe('SOFTWARE_UPDATE_CHECK', () => {
    it('delegates to checkForUpdates and returns its result', async () => {
      const expected = {
        apps: [],
        upToDate: [],
        totalCount: 0,
        majorCount: 0,
        minorCount: 0,
        patchCount: 0,
        packageManagerAvailable: true,
        packageManagerName: 'winget'
      }
      mockCheckForUpdates.mockResolvedValue(expected)

      registerSoftwareUpdaterIpc(() => makeWindow())
      const result = await invoke('software-update:check')
      expect(result).toEqual(expected)
      expect(mockCheckForUpdates).toHaveBeenCalledOnce()
    })

    it('propagates errors from checkForUpdates', async () => {
      mockCheckForUpdates.mockRejectedValue(new Error('network failure'))

      registerSoftwareUpdaterIpc(() => makeWindow())
      await expect(invoke('software-update:check')).rejects.toThrow('network failure')
    })
  })

  // ── SOFTWARE_UPDATE_RUN ────────────────────────────────────

  describe('SOFTWARE_UPDATE_RUN', () => {
    const item = (id: string, source = 'winget') => ({ id, source })

    it('passes safe items and sendProgress callback to runUpdates', async () => {
      const expected = { succeeded: 2, failed: 0, errors: [] }
      mockRunUpdates.mockResolvedValue(expected)

      const win = makeWindow()
      registerSoftwareUpdaterIpc(() => win)

      const result = await invoke('software-update:run', [
        item('app1', 'winget'),
        item('app2', 'choco')
      ])
      expect(result).toEqual(expected)
      expect(mockRunUpdates).toHaveBeenCalledOnce()
      // First arg: filtered {id, source} items
      expect(mockRunUpdates.mock.calls[0][0]).toEqual([
        item('app1', 'winget'),
        item('app2', 'choco')
      ])
      // Second arg: sendProgress function
      expect(typeof mockRunUpdates.mock.calls[0][1]).toBe('function')
    })

    it('returns empty result when items is not an array', async () => {
      registerSoftwareUpdaterIpc(() => makeWindow())
      const result = await invoke('software-update:run', 'not-an-array')
      expect(result).toEqual({ succeeded: 0, failed: 0, errors: [] })
      expect(mockRunUpdates).not.toHaveBeenCalled()
    })

    it('returns empty result when items is an empty array', async () => {
      registerSoftwareUpdaterIpc(() => makeWindow())
      const result = await invoke('software-update:run', [])
      expect(result).toEqual({ succeeded: 0, failed: 0, errors: [] })
      expect(mockRunUpdates).not.toHaveBeenCalled()
    })

    it('returns empty result when items is null', async () => {
      registerSoftwareUpdaterIpc(() => makeWindow())
      const result = await invoke('software-update:run', null)
      expect(result).toEqual({ succeeded: 0, failed: 0, errors: [] })
      expect(mockRunUpdates).not.toHaveBeenCalled()
    })

    it('filters out malformed items (bad id or missing source)', async () => {
      mockRunUpdates.mockResolvedValue({ succeeded: 1, failed: 0, errors: [] })
      registerSoftwareUpdaterIpc(() => makeWindow())

      await invoke('software-update:run', [
        item('valid-id', 'winget'),
        { id: 42, source: 'winget' },
        { id: '', source: 'winget' },
        { id: 'no-source' },
        null,
        item('another-valid', 'npm')
      ])
      expect(mockRunUpdates.mock.calls[0][0]).toEqual([
        item('valid-id', 'winget'),
        item('another-valid', 'npm')
      ])
    })

    it('filters out ids that are >= 200 characters', async () => {
      mockRunUpdates.mockResolvedValue({ succeeded: 1, failed: 0, errors: [] })
      registerSoftwareUpdaterIpc(() => makeWindow())

      const longId = 'a'.repeat(200)
      const okId = 'a'.repeat(199)
      await invoke('software-update:run', [item(longId), item(okId)])
      expect(mockRunUpdates.mock.calls[0][0]).toEqual([item(okId)])
    })

    it('sendProgress sends data to window via IPC', async () => {
      mockRunUpdates.mockImplementation(
        async (_items: unknown[], sendProgress: (data: unknown) => void) => {
          sendProgress({
            phase: 'updating',
            current: 1,
            total: 2,
            currentApp: 'App1',
            percent: 50,
            status: 'in-progress'
          })
          return { succeeded: 1, failed: 0, errors: [] }
        }
      )

      const win = makeWindow()
      registerSoftwareUpdaterIpc(() => win)
      await invoke('software-update:run', [item('app1')])

      expect(win.webContents.send).toHaveBeenCalledWith('software-update:progress', {
        phase: 'updating',
        current: 1,
        total: 2,
        currentApp: 'App1',
        percent: 50,
        status: 'in-progress'
      })
    })

    it('sendProgress does not throw when window is null', async () => {
      mockRunUpdates.mockImplementation(
        async (_items: unknown[], sendProgress: (data: unknown) => void) => {
          sendProgress({
            phase: 'updating',
            current: 1,
            total: 1,
            currentApp: 'X',
            percent: 100,
            status: 'done'
          })
          return { succeeded: 1, failed: 0, errors: [] }
        }
      )

      registerSoftwareUpdaterIpc(() => null)
      // Should not throw
      await expect(invoke('software-update:run', [item('x')])).resolves.toBeDefined()
    })

    it('sendProgress does not throw when window is destroyed', async () => {
      mockRunUpdates.mockImplementation(
        async (_items: unknown[], sendProgress: (data: unknown) => void) => {
          sendProgress({
            phase: 'updating',
            current: 1,
            total: 1,
            currentApp: 'X',
            percent: 100,
            status: 'done'
          })
          return { succeeded: 1, failed: 0, errors: [] }
        }
      )

      const win = makeWindow(true) // destroyed
      registerSoftwareUpdaterIpc(() => win)
      await expect(invoke('software-update:run', [item('x')])).resolves.toBeDefined()
      expect(win.webContents.send).not.toHaveBeenCalled()
    })

    it('propagates errors from runUpdates', async () => {
      mockRunUpdates.mockRejectedValue(new Error('update failed'))

      registerSoftwareUpdaterIpc(() => makeWindow())
      await expect(invoke('software-update:run', [item('app1')])).rejects.toThrow('update failed')
    })
  })

  // ── SOFTWARE_UPDATE_INSTALL_MANAGER ────────────────────────

  describe('SOFTWARE_UPDATE_INSTALL_MANAGER', () => {
    it('installs an allow-listed manager and returns the outcome', async () => {
      const outcome = { success: true, command: 'irm get.scoop.sh | iex' }
      mockInstallPackageManager.mockResolvedValue(outcome)

      registerSoftwareUpdaterIpc(() => makeWindow())
      const result = await invoke('software-update:install-manager', 'scoop')

      expect(result).toEqual(outcome)
      expect(mockInstallPackageManager).toHaveBeenCalledWith('scoop')
    })

    it('refuses names outside the allow-list without touching the service', async () => {
      registerSoftwareUpdaterIpc(() => makeWindow())

      for (const value of [
        'winget',
        'npm',
        '',
        'choco; Remove-Item -Recurse -Force C:\\',
        'choco ',
        'constructor',
        42,
        null,
        { toString: () => 'choco' }
      ]) {
        const result = await invoke('software-update:install-manager', value)
        expect(result).toEqual({
          success: false,
          command: '',
          error: 'Unsupported package manager'
        })
      }
      expect(mockInstallPackageManager).not.toHaveBeenCalled()
    })

    it('propagates errors from the installer', async () => {
      mockInstallPackageManager.mockRejectedValue(new Error('the user declined UAC'))

      registerSoftwareUpdaterIpc(() => makeWindow())
      await expect(invoke('software-update:install-manager', 'choco')).rejects.toThrow(
        'the user declined UAC'
      )
    })
  })
})
