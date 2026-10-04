/**
 * preload — `window.bside`, the whole surface the renderer may touch.
 *
 * No Node, no filesystem, no tokens in the renderer: it names a song or a server
 * and main decides. The interface lives in shared/api.ts so the renderer is
 * typed against the same declaration this implements.
 */
import { contextBridge, ipcRenderer } from 'electron';

import type { BSideApi } from '../shared/api';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: unknown, value: T): void => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const api: BSideApi = {
  servers: {
    list: () => ipcRenderer.invoke('servers:list'),
    addPairing: (line) => ipcRenderer.invoke('servers:addPairing', line),
    add: (input) => ipcRenderer.invoke('servers:add', input),
    update: (name, input) => ipcRenderer.invoke('servers:update', name, input),
    remove: (name) => ipcRenderer.invoke('servers:remove', name),
    setActive: (name) => ipcRenderer.invoke('servers:setActive', name),
    test: (name) => ipcRenderer.invoke('servers:test', name),
    onChanged: (listener) => subscribe('servers:changed', listener),
  },
  song: {
    page: () => ipcRenderer.invoke('song:page'),
  },
  presets: {
    list: () => ipcRenderer.invoke('presets:list'),
    save: (name, form) => ipcRenderer.invoke('presets:save', name, form),
    remove: (name) => ipcRenderer.invoke('presets:remove', name),
  },
  jobs: {
    list: () => ipcRenderer.invoke('jobs:list'),
    generate: (request) => ipcRenderer.invoke('jobs:generate', request),
    cancel: (key) => ipcRenderer.invoke('jobs:cancel', key),
    dismiss: (key) => ipcRenderer.invoke('jobs:dismiss', key),
    onChanged: (listener) => subscribe('jobs:changed', listener),
  },
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    rename: (id, title) => ipcRenderer.invoke('library:rename', id, title),
    remove: (id) => ipcRenderer.invoke('library:remove', id),
    saveCopy: (id) => ipcRenderer.invoke('library:saveCopy', id),
    reveal: (id) => ipcRenderer.invoke('library:reveal', id),
    onAdded: (listener) => subscribe('library:added', listener),
    onChanged: (listener) => subscribe('library:changed', listener),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    chooseLibraryDir: () => ipcRenderer.invoke('settings:chooseLibraryDir'),
    resetLibraryDir: () => ipcRenderer.invoke('settings:resetLibraryDir'),
  },
  clipboard: {
    write: (text) => ipcRenderer.invoke('clipboard:write', text),
  },
};

contextBridge.exposeInMainWorld('bside', api);
