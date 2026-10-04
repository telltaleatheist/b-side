/**
 * ipc — every channel the preload bridge calls, and what main holds behind them.
 *
 * Main owns the server registry (tokens never leave it), the library on disk and
 * the job runner. The renderer asks; main answers an `Outcome` so a refusal keeps
 * its code; changes are pushed on `servers:changed`, `jobs:changed`,
 * `library:added` and `library:changed`.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { app, clipboard, dialog, ipcMain, shell } from 'electron';

import { deletePreset, listPresets, probe, savePreset, songPage } from './crucible';
import { JobRunner, type Landed } from './jobs';
import { Library } from './library';
import { answer, Refusal } from './refusal';
import { ServerRegistry } from './servers';
import { AppSettings } from './settings';
import { appWindow, sendToRenderer } from './window';
import {
  SONG_MODEL,
  type GenerateRequest,
  type ServerInput,
  type ServerView,
  type Song,
  type SongForm,
} from '../shared/types';

/** A song's first title: its first sung line, or what kind of instrumental it is. Renamable. */
export function defaultTitle(params: Landed['job']['params'], seed: number): string {
  const sung = (params.lyrics ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '' && !/^\[[^\[\]]+\]$/.test(line));
  if (sung !== undefined && !params.instrumental) return sung.length > 60 ? `${sung.slice(0, 57)}...` : sung;
  const style = (params.tags ?? '').split(',').map((t) => t.trim()).filter((t) => t !== '').slice(0, 3).join(', ');
  return `${params.instrumental ? 'Instrumental' : 'Song'}${style === '' ? '' : ` — ${style}`} (seed ${seed})`;
}

export function registerIpc(): JobRunner {
  const userData = app.getPath('userData');
  const registry = new ServerRegistry(path.join(userData, 'servers.json'));
  const settings = new AppSettings(path.join(userData, 'settings.json'), path.join(app.getPath('music'), 'B-Side'));
  let library = new Library(settings.view().libraryDir);

  const serversChanged = (views: ServerView[]): ServerView[] => {
    sendToRenderer('servers:changed', views);
    return views;
  };
  const libraryChanged = async (): Promise<void> => {
    sendToRenderer('library:changed', await library.list());
  };

  const jobs = new JobRunner(
    {
      publish: (job) => sendToRenderer('jobs:changed', job),
      server: (name) => registry.get(name),
      land: async (landed) => {
        const params = landed.job.params;
        const song = await library.add({
          title: defaultTitle(params, landed.seed),
          extension: landed.extension,
          bytes: landed.bytes,
          model: SONG_MODEL,
          params: {
            tags: params.tags ?? null,
            lyrics: params.lyrics ?? null,
            instrumental: params.instrumental === true,
            cfg: params.cfg ?? null,
            seed: landed.seed,
          },
          server: { name: landed.server.name, url: landed.server.url },
          jobId: landed.job.jobId as string,
          durationS: landed.durationS,
          batch: landed.job.batch > 1 ? { index: landed.job.index, of: landed.job.batch } : null,
          effective: landed.effective,
          createdAt: new Date(),
        });
        sendToRenderer('library:added', song);
        return song;
      },
    },
    path.join(userData, 'pending.json'),
  );

  // ── servers ────────────────────────────────────────────────────────────────
  ipcMain.handle('servers:list', () => registry.views());
  ipcMain.handle('servers:addPairing', (_e, line: string) =>
    answer(async () => serversChanged(await registry.addPairing(line))));
  ipcMain.handle('servers:add', (_e, input: ServerInput) =>
    answer(async () => serversChanged(await registry.add(input))));
  ipcMain.handle('servers:update', (_e, name: string, input: ServerInput) =>
    answer(async () => serversChanged(await registry.update(name, input))));
  ipcMain.handle('servers:remove', (_e, name: string) =>
    answer(async () => serversChanged(await registry.remove(name))));
  ipcMain.handle('servers:setActive', (_e, name: string) =>
    answer(async () => serversChanged(await registry.setActive(name))));
  ipcMain.handle('servers:test', (_e, name: string) => answer(() => probe(registry.get(name))));

  // ── the song page and its presets ──────────────────────────────────────────
  ipcMain.handle('song:page', () => answer(() => songPage(registry.active())));
  ipcMain.handle('presets:list', () => answer(() => listPresets(registry.active())));
  ipcMain.handle('presets:save', (_e, name: string, form: SongForm) =>
    answer(() => savePreset(registry.active(), name, form)));
  ipcMain.handle('presets:remove', (_e, name: string) => answer(() => deletePreset(registry.active(), name)));

  // ── jobs ───────────────────────────────────────────────────────────────────
  ipcMain.handle('jobs:list', () => jobs.list());
  ipcMain.handle('jobs:generate', (_e, request: GenerateRequest) =>
    answer(() => jobs.generate(registry.active(), request)));
  ipcMain.handle('jobs:cancel', (_e, key: string) => answer(() => jobs.cancel(key)));
  ipcMain.handle('jobs:dismiss', (_e, key: string) => jobs.dismiss(key));

  // ── library ────────────────────────────────────────────────────────────────
  ipcMain.handle('library:list', () => library.list());
  ipcMain.handle('library:rename', (_e, id: string, title: string) =>
    answer(async () => {
      const song = await library.rename(id, title);
      await libraryChanged();
      return song;
    }));
  ipcMain.handle('library:remove', (_e, id: string) =>
    answer(async () => {
      await library.remove(id);
      await libraryChanged();
      return null;
    }));
  ipcMain.handle('library:saveCopy', (_e, id: string) =>
    answer(async () => {
      const song: Song = await library.song(id);
      const source = library.audioPath(song.file);
      const extension = path.extname(song.file);
      const safeTitle = song.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || song.id;
      const window = appWindow();
      const options = {
        title: 'Save a copy of this song',
        defaultPath: path.join(app.getPath('downloads'), `${safeTitle}${extension}`),
        filters: [{ name: 'Audio', extensions: [extension.slice(1)] }],
      };
      const choice = window === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(window, options);
      if (choice.canceled || choice.filePath === undefined) return null;
      await fsp.copyFile(source, choice.filePath);
      return choice.filePath;
    }));
  ipcMain.handle('library:reveal', async (_e, id: string) => {
    const song = await library.song(id);
    shell.showItemInFolder(library.audioPath(song.file));
  });

  // ── settings ───────────────────────────────────────────────────────────────
  const moveLibrary = async (dir: string | null) => {
    const view = await settings.setLibraryDir(dir);
    library = new Library(view.libraryDir);
    await libraryChanged();
    return view;
  };
  ipcMain.handle('settings:get', () => settings.view());
  ipcMain.handle('settings:chooseLibraryDir', () =>
    answer(async () => {
      const window = appWindow();
      const options = {
        title: 'Choose the B-Side library folder',
        defaultPath: settings.view().libraryDir,
        properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
      };
      const choice = window === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
      const dir = choice.filePaths[0];
      if (choice.canceled || dir === undefined) return null;
      return moveLibrary(dir);
    }));
  ipcMain.handle('settings:resetLibraryDir', () => answer(() => moveLibrary(null)));

  ipcMain.handle('clipboard:write', (_e, text: string) => {
    if (typeof text !== 'string') throw new Refusal('clipboard', 'Only text is copied.');
    clipboard.writeText(text);
  });

  // For the song protocol: always the current folder.
  currentLibrary = () => library;
  return jobs;
}

let currentLibrary: (() => Library) | null = null;

export function libraryNow(): Library {
  if (currentLibrary === null) throw new Error('registerIpc() has not run yet');
  return currentLibrary();
}
