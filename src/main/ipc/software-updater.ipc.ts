import { ipcMain } from 'electron'
import { IPC } from '../../shared/channels'
import { checkForUpdates, runUpdates } from '../services/software-updater'
import {
  installPackageManager,
  isSelfInstallableManager
} from '../services/package-manager-install'
import { trackMainWork } from '../services/main-work'
import type { WindowGetter } from './index'
import type {
  ManagerInstallOutcome,
  UpdateCheckResult,
  UpdateProgress,
  UpdateRequestItem,
  UpdateResult
} from '../../shared/types'

export function registerSoftwareUpdaterIpc(getWindow: WindowGetter): void {
  const sendProgress = (data: UpdateProgress): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(IPC.SOFTWARE_UPDATE_PROGRESS, data)
  }

  ipcMain.handle(IPC.SOFTWARE_UPDATE_CHECK, async (): Promise<UpdateCheckResult> => {
    return checkForUpdates()
  })

  ipcMain.handle(
    IPC.SOFTWARE_UPDATE_RUN,
    async (_event, items: UpdateRequestItem[]): Promise<UpdateResult> => {
      if (!Array.isArray(items) || items.length === 0) {
        return { succeeded: 0, failed: 0, errors: [] }
      }
      // Per-manager upgrade functions each validate the id against a strict
      // pattern; here we only enforce basic shape and bounds.
      const safeItems: UpdateRequestItem[] = items
        .filter(
          (it): it is UpdateRequestItem =>
            !!it &&
            typeof it.id === 'string' &&
            it.id.length > 0 &&
            it.id.length < 200 &&
            typeof it.source === 'string' &&
            it.source.length < 40
        )
        .map((it) => ({ id: it.id, source: it.source }))
      if (safeItems.length === 0) return { succeeded: 0, failed: 0, errors: [] }
      return trackMainWork(runUpdates(safeItems, sendProgress))
    }
  )

  ipcMain.handle(
    IPC.SOFTWARE_UPDATE_INSTALL_MANAGER,
    async (_event, manager: unknown): Promise<ManagerInstallOutcome> => {
      // Allow-list: the name selects one of Kudu's hard-coded vendor
      // bootstraps, so anything else must never reach a shell.
      if (!isSelfInstallableManager(manager)) {
        return { success: false, command: '', error: 'Unsupported package manager' }
      }
      return trackMainWork(installPackageManager(manager))
    }
  )
}
