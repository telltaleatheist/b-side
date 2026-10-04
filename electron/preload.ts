/**
 * preload — `window.bside`, what only the desktop window has.
 *
 * No Node, no filesystem, no Crucible tokens in the renderer: it talks to the
 * hub over HTTP like every other client, and asks main only for the hub's
 * address and this computer's dialogs. The interface lives in shared/api.ts so
 * the renderer is typed against the same declaration this implements.
 */
import { contextBridge, ipcRenderer } from 'electron';

import type { DesktopBridge } from '../shared/api';

const bridge: DesktopBridge = {
  // Synchronous on purpose: the app needs the hub before its first request, and it is one small read.
  hub: ipcRenderer.sendSync('hub:address') as DesktopBridge['hub'],
  chooseLibraryDir: () => ipcRenderer.invoke('desktop:chooseLibraryDir'),
  resetLibraryDir: () => ipcRenderer.invoke('desktop:resetLibraryDir'),
  saveCopy: (id) => ipcRenderer.invoke('desktop:saveCopy', id),
  reveal: (id) => ipcRenderer.invoke('desktop:reveal', id),
};

contextBridge.exposeInMainWorld('bside', bridge);
