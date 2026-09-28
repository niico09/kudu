import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { promises as fs } from 'fs'
import { randomUUID } from 'crypto'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { isAdmin } from './elevation'
import { psUtf8 } from './exec-utf8'
import type { ManagerInstallOutcome, WindowsPackageManager } from '../../shared/types'

const execFileAsync = promisify(execFile)

/** A package manager's bootstrap downloads its own installer, so allow for that. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Managers Kudu can install by itself. winget and npm are absent on purpose:
 * winget ships as an MSIX from the Store, and npm only ever arrives together
 * with Node.js, so for both the honest answer is a manual step rather than a
 * script we run on the user's behalf.
 */
export const SELF_INSTALLABLE_MANAGERS = ['choco', 'scoop'] as const
export type SelfInstallableManager = (typeof SELF_INSTALLABLE_MANAGERS)[number]

interface ManagerInstaller {
  /**
   * The vendor's own documented bootstrap, byte-for-byte. The UI shows this
   * string exactly as it is run, so what the user copies is what Kudu executed.
   */
  command: string
  /**
   * Whether the bootstrap needs an elevated shell at run time. This mirrors the
   * vendors rather than a preference: Chocolatey installs machine-wide, while
   * Scoop's installer *refuses* to run at all when it is elevated
   * (github.com/ScoopInstaller/Install#for-admin).
   */
  requiresAdmin: boolean
  /**
   * A path that exists only after a successful install. This — never a PATH
   * lookup — is what proves success: the installer writes the new PATH to the
   * registry, so a process that was already running cannot see the command
   * until it restarts.
   *
   * These are the same locations the updater falls back to when a lookup
   * fails, so an install Kudu verifies here is immediately usable by Kudu.
   */
  installedAt: () => string
}

const MANAGER_INSTALLERS: Record<SelfInstallableManager, ManagerInstaller> = {
  choco: {
    command:
      "Set-ExecutionPolicy Bypass -Scope Process -Force; [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072; iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))",
    requiresAdmin: true,
    installedAt: () =>
      join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', 'choco.exe')
  },
  scoop: {
    command: 'irm get.scoop.sh | iex',
    requiresAdmin: false,
    // The installer honours $env:SCOOP when the user relocated the install.
    installedAt: () => join(process.env.SCOOP || join(homedir(), 'scoop'), 'shims', 'scoop.cmd')
  }
}

/** Whether `value` names a manager Kudu can install by itself. */
export function isSelfInstallableManager(value: unknown): value is SelfInstallableManager {
  return (
    typeof value === 'string' && (SELF_INSTALLABLE_MANAGERS as readonly string[]).includes(value)
  )
}

/** The command Kudu would run to install `manager`, or null when it cannot. */
export function managerInstallCommand(manager: WindowsPackageManager): string | null {
  return isSelfInstallableManager(manager) ? MANAGER_INSTALLERS[manager].command : null
}

/**
 * Install a package manager with its vendor's own bootstrap and report whether
 * it actually landed.
 *
 * Success is decided by looking for the manager on disk, not by the installer's
 * exit code or console output — the Chocolatey path runs elevated, where Kudu
 * cannot read the output at all, and both installers write progress messages in
 * the user's display language.
 */
export async function installPackageManager(
  manager: WindowsPackageManager
): Promise<ManagerInstallOutcome> {
  if (!isSelfInstallableManager(manager)) {
    return { success: false, command: '', error: 'Kudu cannot install this package manager' }
  }

  const installer = MANAGER_INSTALLERS[manager]
  const { command } = installer

  // Scoop's installer aborts when it is elevated, so an elevated Kudu can only
  // hand the command over rather than produce a confusing failure.
  if (!installer.requiresAdmin && isAdmin()) {
    return {
      success: false,
      command,
      error: 'Scoop refuses to install from an elevated process — run this in a normal terminal'
    }
  }

  try {
    await runBootstrap(command, installer.requiresAdmin)
  } catch (err) {
    return { success: false, command, error: describeBootstrapFailure(err) }
  }

  if (!existsSync(installer.installedAt())) {
    return {
      success: false,
      command,
      error: 'the bootstrap finished without leaving the command on disk'
    }
  }

  return { success: true, command }
}

/**
 * Run a bootstrap script, elevated when the vendor requires it.
 *
 * The command goes through a temp script file so it stays byte-for-byte what
 * the UI showed: threading it through `-Command` would mean re-quoting it
 * through two shells. The file is removed afterwards either way.
 */
async function runBootstrap(command: string, elevated: boolean): Promise<void> {
  const scriptPath = join(tmpdir(), `kudu-install-manager-${randomUUID()}.ps1`)
  await fs.writeFile(scriptPath, command, 'utf8')

  try {
    const scriptArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]

    if (!elevated) {
      await execFileAsync('powershell.exe', scriptArgs, {
        timeout: INSTALL_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024
      })
      return
    }

    // Blocks until the user answers the UAC prompt, and rejects if they decline.
    const elevatedArgs = scriptArgs.map((arg) => `'${arg.replace(/'/g, "''")}'`).join(',')
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        psUtf8(
          `Start-Process -FilePath 'powershell.exe' -ArgumentList @(${elevatedArgs}) -Verb RunAs -Wait`
        )
      ],
      { timeout: INSTALL_TIMEOUT_MS, windowsHide: true }
    )
  } finally {
    await fs.rm(scriptPath, { force: true }).catch(() => {})
  }
}

/** One line from a failed bootstrap, for the UI to show under the command. */
function describeBootstrapFailure(err: any): string {
  if (err?.killed || err?.signal) return 'timed out'
  if (err?.code === 'ENOENT') return 'command not found'
  // stderr first, then stdout, and Node's synthetic "Command failed: ..."
  // message only as a last resort — it would otherwise always win the last
  // line and bury the installer's own diagnosis.
  const raw = err?.stderr || err?.stdout || err?.message || ''
  const line = raw
    .split(/\r?\n/)
    .map((l: string) => l.trim())
    .filter(Boolean)
    .pop()
  if (!line) return 'the installer failed'
  return line.length > 200 ? `${line.slice(0, 200)}...` : line
}
