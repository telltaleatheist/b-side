/**
 * window — the one B-Side window.
 *
 * `--dev` on the command line loads the renderer from `ng serve` on port 4270
 * (Foundry's is 4260); otherwise the built renderer beside this file.
 */
import * as path from 'node:path';

import { BrowserWindow, shell } from 'electron';

export const isDev = process.argv.includes('--dev');

const DEV_SERVER = 'http://localhost:4270';

let mainWindow: BrowserWindow | null = null;

export function appWindow(): BrowserWindow | null {
  return mainWindow;
}

/** Send to the renderer if there is one; a message with no window has nobody to tell. */
export function sendToRenderer(channel: string, value: unknown): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value);
}

export function openWindow(): BrowserWindow {
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

  if (isDev) {
    void mainWindow.loadURL(DEV_SERVER);
  } else {
    const index = path.join(__dirname, '..', 'renderer', 'browser', 'index.html');
    mainWindow.loadFile(index).catch((err: Error) => {
      console.error(`[window] could not load ${index}: ${err.message}. Run "npm run build" first.`);
    });
  }
  return mainWindow;
}
