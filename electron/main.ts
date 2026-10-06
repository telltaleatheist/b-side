/**
 * main — B-Sides' lifecycle: ready → the hub → the desktop bridge → window; all
 * windows closed → quit (except on macOS, where the app stays until Cmd+Q).
 *
 * Everything with a lifetime lives in the hub, in main — the job runner, because
 * a renderer reload must not lose a song that is generating; the take cache and
 * the library, because no client is allowed to touch the disk; the server
 * registry, because no client is allowed a Crucible token.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';

import { Hub } from './hub/hub';
import { registerIpc } from './ipc';
import { ICONS, isDev, openWindow } from './window';

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(isDev ? [{ role: 'toggleDevTools' as const }] : []),
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * The app was called B-Side until 2026-10-05; its folders were named after it. On the first start
 * as B-Sides, the old settings folder (servers, tokens, the take cache) and the default library
 * folder take the new name, so nothing is left behind. A rename on the same disk, done once: when
 * the new folder already exists, nothing is touched.
 */
function adoptOldFolders(): void {
  const moves = [
    [path.join(app.getPath('appData'), 'B-Side'), app.getPath('userData')],
    [path.join(app.getPath('music'), 'B-Side'), path.join(app.getPath('music'), 'B-Sides')],
  ] as const;
  for (const [from, to] of moves) {
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
    } catch (err) {
      console.error(`[main] could not rename ${from} to ${to}; using it where it is:`, err);
    }
  }
}

adoptOldFolders();
const single = app.requestSingleInstanceLock();
if (!single) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window !== undefined) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  const hub = new Hub({
    userData: app.getPath('userData'),
    // The old folder only when the rename above could not happen: never an empty library in its place.
    defaultLibraryDir: [path.join(app.getPath('music'), 'B-Sides'), path.join(app.getPath('music'), 'B-Side')]
      .find((dir) => fs.existsSync(dir)) ?? path.join(app.getPath('music'), 'B-Sides'),
    appRoot: path.join(__dirname, '..', 'renderer', 'browser'),
    version: app.getVersion(),
  });

  void app.whenReady().then(async () => {
    buildMenu();
    // Unpackaged, the Dock would show Electron's own icon.
    if (process.platform === 'darwin') app.dock?.setIcon(path.join(ICONS, 'icon-mac.png'));
    try {
      await hub.start();
    } catch (err) {
      dialog.showErrorBox('B-Sides could not start', (err as Error).message);
      app.quit();
      return;
    }
    registerIpc(hub);
    openWindow(hub.localAddress().url);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openWindow(hub.localAddress().url);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // An album being written holds its Crucible server in a queue session: closed before quitting (at
  // most two seconds), so the server is free now rather than when the session idles out. A crash
  // skips this; the album closes its old session when it carries on at the next start.
  let sessionsClosed = false;
  app.on('before-quit', (event) => {
    if (sessionsClosed) return;
    event.preventDefault();
    sessionsClosed = true;
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 2000));
    void Promise.race([hub.closeSessions(), deadline]).finally(() => app.quit());
  });
  app.on('will-quit', () => {
    void hub.stop();
  });
}
