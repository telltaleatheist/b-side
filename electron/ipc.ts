/**
 * ipc — the few things only the desktop window can ask for.
 *
 * Everything else is the hub's HTTP API (electron/hub/hub.ts), which the desktop
 * window uses like every other client. These are the acts that need this
 * computer: its folder dialog, its save dialog, its file manager — and the hub's
 * address and key, which a browser tab gets from its link instead.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { app, dialog, ipcMain, shell } from 'electron';

import type { Hub } from './hub/hub';
import { answer } from './refusal';
import { appWindow } from './window';

export function registerIpc(hub: Hub): void {
  ipcMain.on('hub:address', (event) => {
    event.returnValue = hub.localAddress();
  });

  ipcMain.handle('desktop:chooseLibraryDir', () =>
    answer(async () => {
      const window = appWindow();
      const options = {
        title: 'Choose the B-Side library folder',
        defaultPath: hub.settings.view().libraryDir,
        properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
      };
      const choice = window === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
      const dir = choice.filePaths[0];
      if (choice.canceled || dir === undefined) return null;
      return hub.setLibraryDir(dir);
    }));
  ipcMain.handle('desktop:resetLibraryDir', () => answer(() => hub.setLibraryDir(null)));

  ipcMain.handle('desktop:saveCopy', (_e, id: string) =>
    answer(async () => {
      const song = await hub.songFile(id);
      const extension = path.extname(song.file);
      const safeTitle = song.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || id;
      const window = appWindow();
      const options = {
        title: 'Save a copy of this song',
        defaultPath: path.join(app.getPath('downloads'), `${safeTitle}${extension}`),
        filters: [{ name: 'Audio', extensions: [extension.slice(1)] }],
      };
      const choice = window === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(window, options);
      if (choice.canceled || choice.filePath === undefined) return null;
      await fsp.copyFile(song.file, choice.filePath);
      return choice.filePath;
    }));
  ipcMain.handle('desktop:reveal', (_e, id: string) =>
    answer(async () => {
      shell.showItemInFolder((await hub.songFile(id)).file);
      return null;
    }));
}
