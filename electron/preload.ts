/**
 * preload — `window.bside`, what only the desktop window has.
 *
 * No Node, no filesystem, no Crucible tokens in the renderer: it talks to the
 * hub over HTTP like every other client, and asks main only for the hub's
 * address, this computer's dialogs, and the Crucible on this computer. The
 * interface lives in shared/api.ts so the renderer is typed against the same
 * declaration this implements.
 */
import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopBridge } from '../shared/api';
import type { CrucibleInstallEvent } from '../shared/crucible-install-wire';

const bridge: DesktopBridge = {
  // Synchronous on purpose: the app needs the hub before its first request, and it is one small read.
  hub: ipcRenderer.sendSync('hub:address') as DesktopBridge['hub'],
  chooseLibraryDir: () => ipcRenderer.invoke('desktop:chooseLibraryDir'),
  resetLibraryDir: () => ipcRenderer.invoke('desktop:resetLibraryDir'),
  saveCopy: (id) => ipcRenderer.invoke('desktop:saveCopy', id),
  reveal: (id) => ipcRenderer.invoke('desktop:reveal', id),
  crucible: {
    local: () => ipcRenderer.invoke('crucible:local'),
    installPlan: () => ipcRenderer.invoke('crucible:install-plan'),
    installStatus: () => ipcRenderer.invoke('crucible:install-status'),
    install: () => ipcRenderer.invoke('crucible:install'),
    installRetry: () => ipcRenderer.invoke('crucible:install-retry'),
    onInstallEvent: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, event: CrucibleInstallEvent): void => listener(event);
      ipcRenderer.on('crucible:install-event', handler);
      return () => {
        ipcRenderer.removeListener('crucible:install-event', handler);
      };
    },
    onInstallSettled: (listener) => {
      const handler = (): void => listener();
      ipcRenderer.on('crucible:install-settled', handler);
      return () => {
        ipcRenderer.removeListener('crucible:install-settled', handler);
      };
    },
    start: () => ipcRenderer.invoke('crucible:start'),
    useLocal: () => ipcRenderer.invoke('crucible:use-local'),
    restartWindows: () => ipcRenderer.invoke('crucible:restart-windows'),
    uninstallAvailability: () => ipcRenderer.invoke('crucible:uninstall-availability'),
    uninstallDryRun: (flags) => ipcRenderer.invoke('crucible:uninstall-dry-run', flags),
    uninstall: (flags) => ipcRenderer.invoke('crucible:uninstall', flags),
  },
};

contextBridge.exposeInMainWorld('bside', bridge);
