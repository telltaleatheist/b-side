/**
 * main — B-Side's lifecycle: ready → IPC + song scheme → window; all windows
 * closed → quit (except on macOS, where the app stays until Cmd+Q).
 *
 * Everything with a lifetime lives in main — the job runner, because a renderer
 * reload must not lose a song that is generating; the library and the server
 * registry, because the renderer is not allowed to touch the disk or a token.
 */
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';

import { libraryNow, registerIpc } from './ipc';
import { registerSongScheme, serveSongs } from './song-protocol';
import { isDev, openWindow } from './window';

registerSongScheme();

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

  void app.whenReady().then(async () => {
    buildMenu();
    const jobs = registerIpc();
    serveSongs(libraryNow);
    openWindow();
    await jobs.resume();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) openWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
