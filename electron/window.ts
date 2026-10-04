/**
 * window — the one B-Side window.
 *
 * `--dev` on the command line loads the renderer from `ng serve` on port 4270
 * (Foundry's is 4260); otherwise the app the hub serves — the same page a
 * browser on the network opens. Either way it talks to the hub over HTTP.
 */
import * as path from 'node:path';

import { BrowserWindow, shell } from 'electron';

export const isDev = process.argv.includes('--dev');

const DEV_SERVER = 'http://localhost:4270';

/** The repo's `public/` (from `dist/electron/`), where `tools/make-icons.py` writes the icons. */
export const ICONS = path.join(__dirname, '..', '..', 'public');

let mainWindow: BrowserWindow | null = null;

export function appWindow(): BrowserWindow | null {
  return mainWindow;
}

export function openWindow(hubUrl: string): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 620,
    // --bg-base in src/styles.scss, so the window does not flash another colour first.
    backgroundColor: '#181715',
    title: 'B-Side',
    // macOS takes the Dock icon instead (main.ts); this is the taskbar's on Windows and Linux.
    icon: path.join(ICONS, 'icon.png'),
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Settings' Output list names your audio devices; Chromium only shows their
  // names to a page allowed `media`. Allowed for B-Side's own window (the hub
  // it loads, or the dev server), and only that one permission is touched.
  const ours = new Set([new URL(hubUrl).origin, DEV_SERVER]);
  mainWindow.webContents.session.setPermissionCheckHandler((_contents, permission, origin) =>
    permission === 'media' ? ours.has(origin) : true);

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Links open in the browser, never inside the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const page = isDev ? DEV_SERVER : `${hubUrl}/`;
  mainWindow.loadURL(page).catch((err: Error) => {
    console.error(`[window] could not load ${page}: ${err.message}`);
  });
  return mainWindow;
}
