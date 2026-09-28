import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The scan is what tells the UI which missing managers Kudu can install: it
// attaches the vendor bootstrap to exactly the managers that are enabled but
// absent, and to nothing else. The UI keys its "Install" offer off this field,
// so a manager that should not be offered must not carry it.

const mockExecFile = vi.fn()
vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  const execFile = (...args: unknown[]): unknown => mockExecFile(...args)
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: string[], opts: unknown) =>
      new Promise((resolve, reject) => {
        mockExecFile(file, args, opts, (err: unknown, stdout: string, stderr: string) => {
          if (err) reject(err)
          else resolve({ stdout, stderr })
        })
      })
  })
  return { execFile }
})

const mockExistsSync = vi.fn(() => false)
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readdirSync: () => []
}))
vi.mock('./elevation', () => ({ isAdmin: () => false }))

let enabledManagers: string[] = ['choco', 'scoop']
vi.mock('./settings-store', () => ({
  getSettings: () => ({ windowsPackageManagers: enabledManagers })
}))

import { join } from 'path'
import { checkForUpdates, resetManagerCliCache, resetWingetCache } from './software-updater'

type ExecCb = (err: unknown, stdout: string, stderr: string) => void

const originalPlatform = process.platform

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  resetWingetCache()
  resetManagerCliCache()
  mockExecFile.mockReset()
  mockExistsSync.mockReturnValue(false)
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

/** No manager CLI can be started. */
function scriptNoManagers(): void {
  mockExecFile.mockImplementation((file: string, _args: string[], _o: unknown, cb: ExecCb) => {
    cb(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }), '', '')
  })
}

describe('checkForUpdates — how to get a missing manager', () => {
  it('offers the vendor bootstrap for each enabled manager that is absent', async () => {
    enabledManagers = ['choco', 'scoop']
    scriptNoManagers()

    const result = await checkForUpdates()

    expect(result.managers).toMatchObject([
      {
        name: 'choco',
        available: false,
        installCommand: expect.stringContaining('community.chocolatey.org/install.ps1')
      },
      { name: 'scoop', available: false, installCommand: 'irm get.scoop.sh | iex' }
    ])
  })

  it('offers nothing for managers Kudu cannot install by itself', async () => {
    // winget is an MSIX Store app and npm only ships with Node.js.
    enabledManagers = ['winget', 'npm']
    scriptNoManagers()

    const result = await checkForUpdates()

    const named = result.managers.map((m) => m.name)
    expect(named).toEqual(['winget', 'npm'])
    for (const manager of result.managers) {
      expect(manager.installCommand).toBeUndefined()
    }
  })
})

// An installer writes PATH to the registry, so a Kudu that was running before
// the install still holds the old value. Resolving the manager from its install
// location is what stops a freshly installed manager from looking absent — both
// for one Kudu installed itself and for one the user installed while it ran.
describe('checkForUpdates — a manager installed but not on PATH', () => {
  const CHOCO_OUTDATED = 'git|2.40.0|2.45.0|false\r\n'

  it('finds Chocolatey at its install location and drives it from there', async () => {
    enabledManagers = ['choco']
    const chocoPath = join(
      process.env.ProgramData || 'C:\\ProgramData',
      'chocolatey',
      'bin',
      'choco.exe'
    )
    const calls: string[] = []
    mockExecFile.mockImplementation((file: string, args: string[], _o: unknown, cb: ExecCb) => {
      calls.push(`${file} ${args[0]}`)
      if (file === chocoPath && args[0] === '--version') return cb(null, '2.4.1', '')
      if (file === chocoPath && args[0] === 'outdated') return cb(null, CHOCO_OUTDATED, '')
      if (file === chocoPath && args[0] === 'list') return cb(null, '', '')
      // Everything else fails — including the bare `choco`, which this
      // process cannot resolve.
      return cb(Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }), '', '')
    })

    const result = await checkForUpdates()

    expect(result.managers[0]).toMatchObject({ name: 'choco', available: true })
    expect(result.apps.map((a) => a.id)).toEqual(['git'])
    // PATH is still tried first, and every real call goes to the resolved path.
    expect(calls[0]).toBe('choco --version')
    expect(calls).toContain(`${chocoPath} outdated`)
  })
})
