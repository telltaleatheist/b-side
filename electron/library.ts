/**
 * library — the songs on disk, which is what makes B-Side an app and not a page.
 *
 * Every finished song is two files in the library folder (default
 * `<Music>/B-Side`, changeable in Settings):
 *
 *   <id>.flac   the audio, exactly as the server made it
 *   <id>.json   the sidecar: title, params, server, Crucible job id, created
 *               time, duration, batch place — and `effective`, the server's own
 *               record of every parameter it used (the `done` event's `audio`),
 *               kept verbatim so a song can be made again
 *
 * The sidecar is written first, then the audio, both atomically — so a song
 * whose audio exists always has its sidecar, and a half-written FLAC never sits
 * under a real name. The id is the file stem and never changes: renaming a song
 * changes its `title` only.
 *
 * Like `ServerRegistry`, this takes its folder rather than asking Electron, so it
 * runs under a test without an Electron process.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { writeAtomically } from './atomic';
import { Refusal } from './refusal';
import type { LibraryView, Song } from '../shared/types';

/** Marks a sidecar as B-Side's, and its shape's version. */
const SIDECAR_VERSION = 1;

interface Sidecar extends Song {
  readonly bside: number;
  /** The server's effective params and measurements, verbatim. */
  readonly effective: unknown;
}

export interface NewSong {
  readonly title: string;
  readonly extension: string;
  readonly bytes: Uint8Array;
  readonly model: string;
  readonly params: Song['params'];
  readonly server: Song['server'];
  readonly jobId: string;
  readonly durationS: number | null;
  readonly batch: Song['batch'];
  readonly effective: unknown;
  readonly createdAt: Date;
}

function stamp(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/** An id is a bare file stem: nothing that could climb out of the library folder. */
function checkId(id: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith('.')) {
    throw new Refusal('song_id_invalid', `${id} is not a song in the library.`);
  }
  return id;
}

function songOf(sidecar: Sidecar): Song {
  return {
    id: sidecar.id,
    title: sidecar.title,
    file: sidecar.file,
    model: sidecar.model,
    params: sidecar.params,
    server: sidecar.server,
    jobId: sidecar.jobId,
    createdAt: sidecar.createdAt,
    durationS: sidecar.durationS,
    batch: sidecar.batch,
    album: sidecar.album,
  };
}

export class Library {
  constructor(readonly dir: string) {}

  private sidecarPath(id: string): string {
    return path.join(this.dir, `${checkId(id)}.json`);
  }

  /** The audio file a song's sidecar names, or a refusal when it is not a library file. */
  audioPath(file: string): string {
    const name = path.basename(file);
    if (name !== file || !/\.(flac|wav)$/i.test(name)) {
      throw new Refusal('song_file_invalid', `${file} is not a library audio file.`);
    }
    return path.join(this.dir, name);
  }

  private async readSidecar(id: string): Promise<Sidecar> {
    let text: string;
    try {
      text = await fsp.readFile(this.sidecarPath(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Refusal('song_missing', `The song ${id} is no longer in ${this.dir}.`);
      }
      throw err;
    }
    const parsed = JSON.parse(text) as Sidecar;
    if (parsed.bside !== SIDECAR_VERSION || parsed.id !== id) {
      throw new Refusal('song_unreadable', `${id}.json is not a B-Side song sidecar.`);
    }
    return parsed;
  }

  /** Every song in the folder, oldest first. A sidecar that will not read is listed as a problem, never removed. */
  async list(): Promise<LibraryView> {
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { dir: this.dir, songs: [], problems: [] };
      throw err;
    }
    const songs: Song[] = [];
    const problems: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      let sidecar: Sidecar;
      try {
        const parsed = JSON.parse(await fsp.readFile(path.join(this.dir, name), 'utf8')) as Partial<Sidecar>;
        // Not ours (some other app's .json in the same folder): not a problem, just not a song.
        if (parsed.bside === undefined) continue;
        sidecar = await this.readSidecar(id);
      } catch (err) {
        problems.push(`${name}: ${(err as Error).message}`);
        continue;
      }
      try {
        await fsp.access(this.audioPath(sidecar.file));
      } catch {
        problems.push(`${name}: its audio file ${sidecar.file} is missing`);
        continue;
      }
      songs.push(songOf(sidecar));
    }
    songs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { dir: this.dir, songs, problems };
  }

  /** File a finished song: the sidecar first, then the audio, each atomically. */
  async add(song: NewSong): Promise<Song> {
    await fsp.mkdir(this.dir, { recursive: true });
    const extension = song.extension.toLowerCase();
    if (extension !== 'flac' && extension !== 'wav') {
      throw new Refusal('song_format', `B-Side keeps flac or wav audio, not .${song.extension}.`);
    }
    // Unique, sortable, readable: when it was made and which take it was.
    const base = `${stamp(song.createdAt)}-${song.params.seed ?? 'noseed'}`;
    let id = base;
    for (let n = 2; await exists(path.join(this.dir, `${id}.json`)); n += 1) id = `${base}-${n}`;
    const sidecar: Sidecar = {
      bside: SIDECAR_VERSION,
      id,
      title: song.title,
      file: `${id}.${extension}`,
      model: song.model,
      params: song.params,
      server: song.server,
      jobId: song.jobId,
      createdAt: song.createdAt.toISOString(),
      durationS: song.durationS,
      batch: song.batch,
      album: null,
      effective: song.effective,
    };
    await writeAtomically(this.sidecarPath(id), `${JSON.stringify(sidecar, null, 2)}\n`);
    await writeAtomically(this.audioPath(sidecar.file), song.bytes);
    return songOf(sidecar);
  }

  async rename(id: string, title: string): Promise<Song> {
    const trimmed = title.trim();
    if (trimmed === '') throw new Refusal('song_title_missing', 'A song needs a title.');
    const sidecar = { ...(await this.readSidecar(id)), title: trimmed };
    await writeAtomically(this.sidecarPath(id), `${JSON.stringify(sidecar, null, 2)}\n`);
    return songOf(sidecar);
  }

  /** Delete the audio, then the sidecar — so a crash between leaves a listed problem, not an orphaned file. */
  async remove(id: string): Promise<void> {
    const sidecar = await this.readSidecar(id);
    await fsp.rm(this.audioPath(sidecar.file), { force: true });
    await fsp.rm(this.sidecarPath(id));
  }

  async song(id: string): Promise<Song> {
    return songOf(await this.readSidecar(id));
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}
