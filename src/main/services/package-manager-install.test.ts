import { describe, it, expect, vi, beforeEach } from 'vitest'

// Kudu installing a package manager means running a vendor bootstrap on the
// user's machine, so these tests pin the two things that make that safe and
// honest: only allow-listed manager names reach a shell, and success is decided
// by the manager existing on disk — never by the installer's exit code or by
// its console output, which arrives in the user's display language (and which
// the elevated Chocolatey path cannot even be read).

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
const mockWriteFile = vi.fn(async () => {})
const mockRm = vi.fn(async () => {})
vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  promises: {
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    rm: (...args: unknown[]) => mockRm(...args)
  }
}))

const mockIsAdmin = vi.fn(() => false)
vi.mock('./elevation', () => ({ isAdmin: () => mockIsAdmin() }))

import {
  SELF_INSTALLABLE_MANAGERS,
  installPackageManager,
  isSelfInstallableManager,
  managerInstallCommand
} from './package-manager-install'

type ExecCb = (err: unknown, stdout: string, stderr: string) => void

/** Script the only process this service starts: the bootstrap itself. */
function scriptBootstrap(
  scripted: { error?: Record<string, unknown>; stdout?: string } = {}
): void {
  mockExecFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb: ExecCb) => {
    if (scripted.error) {
      cb(Object.assign(new Error('failed'), scripted.error), scripted.stdout ?? '', '')
    } else {
      cb(null, scripted.stdout ?? '', '')
    }
  })
}

/** The argv of the first powershell.exe invocation. */
function firstPowerShellArgs(): string[] {
  const call = mockExecFile.mock.calls.find((c) => c[0] === 'powershell.exe')
  return (call?.[1] ?? []) as string[]
}

describe('managerInstallCommand', () => {
  it('hands out the vendors own bootstraps', () => {
    expect(managerInstallCommand('choco')).toContain('community.chocolatey.org/install.ps1')
    expect(managerInstallCommand('scoop')).toBe('irm get.scoop.sh | iex')
  })

  it('has nothing to offer for the managers it cannot install', () => {
    // winget ships as a Store app and npm only arrives with Node.js, so both
    // need a manual step rather than a script Kudu runs.
    expect(managerInstallCommand('winget')).toBeNull()
    expect(managerInstallCommand('npm')).toBeNull()
  })
})

describe('isSelfInstallableManager', () => {
  it('accepts exactly the managers in the installer table', () => {
    for (const manager of SELF_INSTALLABLE_MANAGERS) {
      expect(isSelfInstallableManager(manager)).toBe(true)
    }
  })

  it('rejects anything else, including inherited property names', () => {
    for (const value of ['winget', 'npm', '', 'choco ', 'constructor', 'toString', 42, null]) {
      expect(isSelfInstallableManager(value)).toBe(false)
    }
  })
})

describe('installPackageManager', () => {
  beforeEach(() => {
    mockExecFile.mockReset()
    mockWriteFile.mockClear()
    mockRm.mockClear()
    mockIsAdmin.mockReturnValue(false)
    mockExistsSync.mockReturnValue(false)
  })

  it('refuses a manager it has no bootstrap for, without running anything', async () => {
    const outcome = await installPackageManager('winget')

    expect(outcome.success).toBe(false)
    expect(outcome.error).toMatch(/cannot install/i)
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('installs Chocolatey through an elevated, waited-for shell', async () => {
    mockExistsSync.mockReturnValue(true)
    scriptBootstrap()

    const outcome = await installPackageManager('choco')

    expect(outcome.success).toBe(true)

    // The vendor command is written verbatim, so the file that runs is the
    // same string the UI showed. The file goes to a temp path.
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('kudu-install-manager-'),
      managerInstallCommand('choco'),
      'utf8'
    )

    // Elevation is what makes machine-wide Chocolatey install possible, and
    // -Wait is what makes the outcome observable at all.
    expect(firstPowerShellArgs().join(' ')).toContain('-Verb RunAs -Wait')

    // The temp script never outlives the attempt.
    expect(mockRm).toHaveBeenCalledTimes(1)
  })

  it('does not claim success when the bootstrap exits without installing', async () => {
    mockExistsSync.mockReturnValue(false)
    scriptBootstrap()

    const outcome = await installPackageManager('choco')

    expect(outcome.success).toBe(false)
    expect(outcome.error).toMatch(/without leaving/i)
    expect(outcome.command).toBe(managerInstallCommand('choco'))
  })

  it('surfaces the last output line when the bootstrap fails', async () => {
    scriptBootstrap({ error: { stderr: 'iex : acceso denegado\r\nAborted.\r\n' } })

    const outcome = await installPackageManager('choco')

    expect(outcome.success).toBe(false)
    expect(outcome.error).toBe('Aborted.')
    // A failed attempt must still clean up its script.
    expect(mockRm).toHaveBeenCalled()
  })

  it('installs Scoop unelevated, as its installer demands', async () => {
    mockExistsSync.mockReturnValue(true)
    scriptBootstrap()

    const outcome = await installPackageManager('scoop')

    expect(outcome.success).toBe(true)
    expect(firstPowerShellArgs()).toEqual([
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      expect.stringContaining('kudu-install-manager-')
    ])
  })

  it('hands over the command instead of failing when Kudu is elevated', async () => {
    // Scoop's installer aborts when it is elevated, so running it would only
    // produce a confusing error.
    mockIsAdmin.mockReturnValue(true)

    const outcome = await installPackageManager('scoop')

    expect(outcome.success).toBe(false)
    expect(outcome.command).toBe(managerInstallCommand('scoop'))
    expect(outcome.error).toMatch(/elevated/i)
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})
