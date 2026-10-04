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
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

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
