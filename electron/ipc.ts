/**
 * ipc — the few things only the desktop window can ask for.
 *
 * Everything else is the hub's HTTP API (electron/hub/hub.ts), which the desktop
 * window uses like every other client. These are the acts that need this
 * computer: its folder dialog, its save dialog, its file manager, the Crucible
 * installed on it — and the hub's address and key, which a browser tab gets from
 * its link instead.
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

import { crucibleInstallPlan } from './crucible-install';
import { crucibleInstallDoor } from './crucible-install-door';
import { localView, refreshPublished, startAndUse, useLocal } from './crucible-local';
import { uninstallAvailability, uninstallDryRun, uninstallPerform } from './crucible-uninstall';
import type { Hub } from './hub/hub';
import { answer, Refusal } from './refusal';
import { appWindow } from './window';
import type { CrucibleUninstallFlags } from '../shared/uninstall-wire';

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

  registerCrucibleSetup(hub);
}

/**
 * The Crucible on this computer (Phase 4: "install crucible on the computer
 * through the electron app setup page, or pick/add a crucible server").
 *
 * Here and not on the hub on purpose: installing or removing software is an act
 * of the computer B-Side runs on, and the hub serves phones and browser tabs
 * too. Adding or picking an existing server stays on the hub (any device may do
 * that); every act here that changes the server list tells every device through
 * `hub.serversChanged()`.
 */
function registerCrucibleSetup(hub: Hub): void {
  const door = crucibleInstallDoor(hub.registry);
  // Broadcast, not sent to the window that pressed: an install outlives a
  // window, and every window open on this computer is looking at the same one.
  door.watch((event) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('crucible:install-event', event);
  });
  door.onSettled(() => {
    void refreshPublished(hub.registry)
      .then((changed) => {
        if (changed) hub.serversChanged();
      })
      .catch((error: unknown) => console.error(`[crucible] could not re-read the published connection: ${String(error)}`))
      .finally(() => {
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('crucible:install-settled');
      });
  });

  ipcMain.handle('crucible:local', () => answer(() => localView(hub.registry)));
  ipcMain.handle('crucible:install-plan', () => answer(() => crucibleInstallPlan()));
  // Asking where a move got to and joining its stream are one question: a move
  // the tray started by itself has events this process was never being sent.
  ipcMain.handle('crucible:install-status', () =>
    answer(async () => {
      const status = await door.status();
      if (status.running) door.attach();
      return status;
    }));
  ipcMain.handle('crucible:install', () =>
    answer(async () => {
      try {
        await door.install();
      } finally {
        // A run that refused late may still have registered the server.
        hub.serversChanged();
      }
      return null;
    }));
  ipcMain.handle('crucible:install-retry', () =>
    answer(async () => {
      try {
        await door.retry();
      } finally {
        hub.serversChanged();
      }
      return null;
    }));
  ipcMain.handle('crucible:start', () =>
    answer(async () => {
      const result = await startAndUse(hub.registry);
      if (result.servers !== null) hub.serversChanged(result.servers);
      return { started: result.started, detail: result.detail };
    }));
  ipcMain.handle('crucible:use-local', () =>
    answer(async () => hub.serversChanged((await useLocal(hub.registry)).servers)));
  /*
   * Restart now — only ever on a press, never as a consequence of reading an
   * outcome (crucible PHASE19 §2.3: "the reboot is never taken by Crucible").
   * As the signed-in user, so no elevation; five seconds so the window can say
   * it heard the press; detached because Electron is about to be ended by it.
   */
  ipcMain.handle('crucible:restart-windows', () =>
    answer(() => {
      if (process.platform !== 'win32') {
        throw new Refusal('restart_not_windows', 'Only Windows asks for a restart to finish setting up Crucible.');
      }
      spawn('shutdown.exe', ['/r', '/t', '5'], { detached: true, stdio: 'ignore' }).unref();
      return null;
    }));
  ipcMain.handle('crucible:uninstall-availability', () => answer(() => uninstallAvailability(hub.registry)));
  ipcMain.handle('crucible:uninstall-dry-run', (_e, flags: CrucibleUninstallFlags) =>
    answer(() => uninstallDryRun(hub.registry, flags)));
  ipcMain.handle('crucible:uninstall', (_e, flags: CrucibleUninstallFlags) =>
    answer(async () => {
      const run = await uninstallPerform(hub.registry, flags);
      if (run.unregistered !== null) hub.serversChanged();
      return run;
    }));
}
