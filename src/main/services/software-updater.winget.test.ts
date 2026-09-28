import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Regression tests for #462: the winget scan must never turn a failure (CLI
// not found, timeout, crash) or a localised table into "everything is up to
// date". Every scenario runs the real checkForUpdates() over a mocked winget.
// The runUpdates() block at the end covers the upgrade path, which must decide
// success from winget's exit code rather than its localised console text.

const mockExecFile = vi.fn()
vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  // Mirror the real execFile's promisify shape: resolve { stdout, stderr }
  // and attach stdout/stderr to rejections.
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
vi.mock('./settings-store', () => ({
  getSettings: () => ({ windowsPackageManagers: ['winget'] })
}))

import {
  checkForUpdates,
  manualRemedies,
  resetWingetCache,
  runUpdates,
  wingetRemedies
} from './software-updater'

type ExecCb = (err: unknown, stdout: string, stderr: string) => void

interface Scripted {
  stdout?: string
  /** Reject with this error (its stdout is attached like execFile does). */
  error?: Record<string, unknown>
}

/** Route each winget invocation to a scripted response keyed by subcommand. */
function scriptWinget(responses: Record<string, Scripted>): void {
  mockExecFile.mockImplementation((file: string, args: string[], _opts: unknown, cb: ExecCb) => {
    const key = args[0]
    const scripted = responses[key]
    if (!scripted) {
      cb(Object.assign(new Error(`unexpected ${file} ${key}`), { code: 'ENOENT' }), '', '')
      return
    }
    if (scripted.error) {
      const err = Object.assign(new Error(String(scripted.error.message ?? 'failed')), {
        stdout: scripted.stdout ?? '',
        stderr: '',
        ...scripted.error
      })
      cb(err, scripted.stdout ?? '', '')
      return
    }
    cb(null, scripted.stdout ?? '', '')
  })
}

const UPGRADE_TABLE = [
  'Name                Id                       Version        Available       Source',
  '------------------------------------------------------------------------------------',
  'Adobe Acrobat DC    XPDP273C0XHQH2           20.006.20042   26.001.21691    msstore',
  'GitHub CLI          GitHub.cli               2.100.0        2.101.0         winget',
  '2 upgrades available.',
  ''
].join('\r\n')

const originalPlatform = process.platform

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  resetWingetCache()
  mockExecFile.mockReset()
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

describe('checkForUpdates (winget)', () => {
  it('reports outdated packages from the upgrade table', async () => {
    scriptWinget({ '--version': { stdout: 'v1.9.0' }, upgrade: { stdout: UPGRADE_TABLE } })

    const result = await checkForUpdates()
    expect(result.apps.map((a) => a.id)).toEqual(['XPDP273C0XHQH2', 'GitHub.cli'])
    expect(result.managers).toEqual([{ name: 'winget', available: true, outdatedCount: 2 }])
  })

  it('flags winget as errored when it cannot be started', async () => {
    scriptWinget({})

    const result = await checkForUpdates()
    expect(result.apps).toEqual([])
    expect(result.packageManagerAvailable).toBe(false)
    expect(result.managers[0]).toMatchObject({
      name: 'winget',
      available: false,
      error: expect.stringContaining('not found')
    })
  })

  it('falls back to a known install path when winget is not on PATH', async () => {
    const calls: string[] = []
    mockExecFile.mockImplementation((file: string, args: string[], _o: unknown, cb: ExecCb) => {
      calls.push(file)
      if (file === 'winget') {
        cb(Object.assign(new Error('spawn winget ENOENT'), { code: 'ENOENT' }), '', '')
      } else if (args[0] === '--version') {
        cb(null, 'v1.9.0', '')
      } else {
        cb(null, args[0] === 'upgrade' ? UPGRADE_TABLE : '', '')
      }
    })
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\me\\AppData\\Local')
    mockExistsSync.mockReturnValue(true)

    const result = await checkForUpdates()
    expect(result.apps).toHaveLength(2)
    expect(calls.some((f) => /WindowsApps[\\/]winget\.exe$/.test(f))).toBe(true)

    mockExistsSync.mockReturnValue(false)
    vi.unstubAllEnvs()
  })

  it('reports a timeout instead of "up to date"', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.9.0' },
      upgrade: { stdout: '   -\r   \\r', error: { killed: true, signal: 'SIGTERM' } }
    })

    const result = await checkForUpdates()
    expect(result.apps).toEqual([])
    expect(result.packageManagerAvailable).toBe(true)
    expect(result.managers[0]).toMatchObject({ name: 'winget', error: 'timed out' })
  })

  it('surfaces the last output line when winget exits with an unknown error', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.9.0' },
      upgrade: {
        stdout:
          'Failed in attempting to update the source: winget\r\nAn unexpected error occurred while executing the command:\r\n0x8a15000f : Data required by the source is missing\r\n',
        error: { code: 0x8a15000f }
      }
    })

    const result = await checkForUpdates()
    expect(result.apps).toEqual([])
    expect(result.managers[0].error).toContain('0x8a15000f')
  })

  it('treats the "no applications found" exit code as nothing outdated', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.9.0' },
      upgrade: {
        stdout: 'No installed package found matching input criteria.\r\n',
        error: { code: 0x8a150014 }
      },
      list: { stdout: '' }
    })

    const result = await checkForUpdates()
    expect(result.apps).toEqual([])
    expect(result.managers[0]).toEqual({ name: 'winget', available: true, outdatedCount: 0 })
  })

  it('keeps partial rows but flags the scan when winget is killed mid-table', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.9.0' },
      upgrade: { stdout: UPGRADE_TABLE, error: { killed: true, signal: 'SIGTERM' } }
    })

    const result = await checkForUpdates()
    expect(result.apps).toHaveLength(2)
    expect(result.managers[0]).toMatchObject({ outdatedCount: 2, error: 'timed out' })
  })

  it('flags a source failure even when a table was printed', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.9.0' },
      upgrade: {
        stdout: 'Failed in attempting to update the source: msstore\r\n' + UPGRADE_TABLE,
        error: { code: 0x8a15000f }
      }
    })

    const result = await checkForUpdates()
    expect(result.apps).toHaveLength(2)
    expect(result.managers[0].error).toBeDefined()
  })

  it('still parses the table when winget exits non-zero after printing it', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.9.0' },
      upgrade: { stdout: UPGRADE_TABLE, error: { code: 0x8a150014 } }
    })

    const result = await checkForUpdates()
    expect(result.apps).toHaveLength(2)
    expect(result.managers[0].error).toBeUndefined()
  })
})

// ─── runUpdates: the upgrade path ───────────────────────────
//
// winget localises its console output to the Windows display language, so a
// completed upgrade on a non-English Windows contains nothing an English
// pattern can match. Only the exit code is language-independent.

// Verbatim final line of a real upgrade on a Spanish Windows install.
const LOCALISED_UPGRADE_SUCCESS = 'Instalado correctamente\r\n'
const LOCALISED_NO_APPLICABLE =
  'No se encontró ningún paquete que coincida con los criterios de entrada.\r\n'
// Verbatim winget message for a package whose installer technology changed.
const LOCALISED_TECH_CHANGED =
  'Se encontró una versión más reciente, pero la tecnología de instalación es diferente de la versión actual instalada. Desinstale el paquete e instale la versión más reciente.\r\n'

describe('runUpdates (winget)', () => {
  it('reports a localised upgrade as success when winget exits 0', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.29.380' },
      upgrade: { stdout: LOCALISED_UPGRADE_SUCCESS }
    })

    const result = await runUpdates([{ id: 'Stockfish.Stockfish', source: 'winget' }], () => {})

    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(0)
    expect(result.errors).toEqual([])
  })

  it('attempts ids containing + instead of rejecting them as malformed', async () => {
    const upgradeArgs: string[][] = []
    mockExecFile.mockImplementation((file: string, args: string[], _o: unknown, cb: ExecCb) => {
      if (args[0] === 'upgrade') upgradeArgs.push(args)
      cb(null, args[0] === '--version' ? 'v1.29.380' : LOCALISED_UPGRADE_SUCCESS, '')
    })

    const result = await runUpdates([{ id: 'Notepad++.Notepad++', source: 'winget' }], () => {})

    expect(result.succeeded).toBe(1)
    expect(result.errors).toEqual([])
    expect(upgradeArgs[0]).toContain('Notepad++.Notepad++')
  })

  it('still reports a failure when winget exits non-zero', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.29.380' },
      upgrade: { stdout: LOCALISED_NO_APPLICABLE, error: { code: 0x8a15002b } }
    })

    const result = await runUpdates([{ id: 'Anki.Anki', source: 'winget' }], () => {})

    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.errors[0]).toMatchObject({ appId: 'Anki.Anki', source: 'winget' })
  })

  it('refuses ids that would be parsed as a flag, without invoking winget', async () => {
    const calls: string[] = []
    mockExecFile.mockImplementation((file: string, args: string[], _o: unknown, cb: ExecCb) => {
      calls.push(args[0])
      cb(null, 'v1.29.380', '')
    })

    const result = await runUpdates([{ id: '--source', source: 'winget' }], () => {})

    expect(result.failed).toBe(1)
    expect(result.errors[0].reason).toBe('Invalid app ID format')
    // Nothing reached winget, so there is no command to suggest
    expect(result.errors[0].suggestedCommands).toBeUndefined()
    expect(calls).not.toContain('upgrade')
  })

  it('suggests the remedy matching the exit code that failed', async () => {
    scriptWinget({
      '--version': { stdout: 'v1.29.380' },
      upgrade: { stdout: LOCALISED_NO_APPLICABLE, error: { code: 0x8a15002b } }
    })

    const result = await runUpdates([{ id: 'Docker.DockerDesktop', source: 'winget' }], () => {})

    expect(result.errors[0].suggestedCommands).toEqual([
      'winget install --id "Docker.DockerDesktop" --exact --force'
    ])
  })

  it('skips the --force retry when the installer technology changed', async () => {
    const upgrades: string[][] = []
    mockExecFile.mockImplementation((file: string, args: string[], _o: unknown, cb: ExecCb) => {
      if (args[0] !== 'upgrade') {
        cb(null, 'v1.29.380', '')
        return
      }
      upgrades.push(args)
      cb(
        Object.assign(new Error('failed'), {
          code: 0x8a15008e,
          stdout: LOCALISED_TECH_CHANGED
        }),
        LOCALISED_TECH_CHANGED,
        ''
      )
    })

    const result = await runUpdates([{ id: 'LLVM.LLVM', source: 'winget' }], () => {})

    // Neither elevation nor --force can cross an installer-technology change
    expect(upgrades).toHaveLength(1)
    expect(result.errors[0].suggestedCommands).toEqual([
      'winget uninstall --id "LLVM.LLVM" --exact',
      'winget install --id "LLVM.LLVM" --exact'
    ])
  })
})

// ─── Suggested commands ─────────────────────────────────────

describe('wingetRemedies', () => {
  it('suggests install --force for packages winget refuses to upgrade', () => {
    // 0x8a15002b — "a newer version is available but does not apply" (Anki)
    expect(wingetRemedies('Anki.Anki', 0x8a15002b)).toEqual([
      'winget install --id "Anki.Anki" --exact --force'
    ])
    // 0x8a150014 — the id matched no installed package (FFmpeg)
    expect(wingetRemedies('Gyan.FFmpeg', 0x8a150014)).toEqual([
      'winget install --id "Gyan.FFmpeg" --exact --force'
    ])
  })

  it('suggests uninstall + install when the installer technology changed', () => {
    expect(wingetRemedies('LLVM.LLVM', 0x8a15008e)).toEqual([
      'winget uninstall --id "LLVM.LLVM" --exact',
      'winget install --id "LLVM.LLVM" --exact'
    ])
  })

  it('falls back to the same upgrade run by hand when the code is unknown', () => {
    expect(wingetRemedies('Foo.Bar')).toEqual(['winget upgrade --id "Foo.Bar" --exact'])
  })
})

describe('manualRemedies', () => {
  it('names the owning manager command', () => {
    expect(manualRemedies('choco', 'git')).toEqual(['choco upgrade git -y'])
    expect(manualRemedies('scoop', '7zip')).toEqual(['scoop update 7zip'])
    expect(manualRemedies('npm', '@angular/cli')).toEqual(['npm install -g @angular/cli@latest'])
  })

  it('leaves winget to wingetRemedies', () => {
    expect(manualRemedies('winget', 'Anki.Anki')).toBeUndefined()
  })
})
