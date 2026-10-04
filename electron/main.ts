/**
 * main — B-Side's lifecycle: ready → the hub → the desktop bridge → window; all
 * windows closed → quit (except on macOS, where the app stays until Cmd+Q).
 *
 * Everything with a lifetime lives in the hub, in main — the job runner, because
 * a renderer reload must not lose a song that is generating; the take cache and
 * the library, because no client is allowed to touch the disk; the server
 * registry, because no client is allowed a Crucible token.
 */
import * as path from 'node:path';

import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions } from 'electron';

import { Hub } from './hub/hub';
import { registerIpc } from './ipc';
import { isDev, openWindow } from './window';

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
    defaultLibraryDir: path.join(app.getPath('music'), 'B-Side'),
    appRoot: path.join(__dirname, '..', 'renderer', 'browser'),
    version: app.getVersion(),
  });

  void app.whenReady().then(async () => {
    buildMenu();
    try {
      await hub.start();
    } catch (err) {
      dialog.showErrorBox('B-Side could not start', (err as Error).message);
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

  app.on('will-quit', () => {
    void hub.stop();
  });
}
