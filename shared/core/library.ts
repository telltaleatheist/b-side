/**
 * library — the songs somebody saved, and the playlists they were saved to.
 *
 * Owen, 2026-10-04: "Saved playlist songs on electron live in a dedicated
 * library folder ... Things only save long term if the user saves them to a
 * playlist." So the library folder (default `<Music>/B-Sides`, changeable in
 * Settings) holds:
 *
 *   <id>.flac        a saved song's audio, exactly as the server made it
 *   <id>.json        its sidecar: title, params, server, Crucible job id,
 *                    created time, duration, batch place — and `effective`, the
 *                    server's own record of every parameter it used (the `done`
 *                    event's `audio`), kept verbatim so a song can be made again
 *   playlists.json   the named playlists, each an ordered list of song ids
 *
 * A song lives exactly as long as some playlist holds it: one that leaves its
 * last playlist is deleted (the UI says so first). Songs a v1 B-Sides saved
 * before there were playlists are adopted, once, into "Saved before playlists".
 *
 * Writes are atomic and run one at a time. A song's sidecar is written before its
 * audio, so a song whose audio exists always has its sidecar. The id is the file
 * stem and never changes: renaming a song changes its `title` only.
 *
 * Like `TakeStore`, this takes its folder and its `Disk`, so it runs on the
 * desktop (the library folder) and on the phone (the app's own storage) alike.
 */
import { basename, join, type Disk } from './disk';
import { Refusal } from './refusal';
import { AUDIO_FILE, checkId, stamp } from './takes';
import type { AlbumMeta, LibraryView, Playlist, Song, SongFacts } from '../types';

/** Marks a sidecar as B-Sides', and its shape's version. */
const SIDECAR_VERSION = 1;
const PLAYLISTS_FILE = 'playlists.json';
const PLAYLISTS_VERSION = 1;
export const ADOPTED_PLAYLIST = 'Saved before playlists';

interface Sidecar extends Song {
  readonly bside: number;
  /** The server's effective params and measurements, verbatim. */
  readonly effective: unknown;
}

interface PlaylistsDocument {
  readonly bsidePlaylists: number;
  readonly playlists: Playlist[];
}

/** An album as another B-Sides sends it: the playlist, its details, and each song's sidecar. */
export interface ImportedAlbum {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly album: AlbumMeta;
  readonly songs: readonly (Song & { readonly effective: unknown })[];
}

/** A song to file: its facts, and the audio file to copy in (a take's). */
export interface NewSong extends Omit<SongFacts, 'id' | 'file'> {
  readonly audioFrom: string;
  readonly bytes: number | null;
  readonly effective: unknown;
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
    bytes: typeof sidecar.bytes === 'number' ? sidecar.bytes : null,
  };
}

function cleanName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '') throw new Refusal('playlist_name_missing', 'A playlist needs a name.');
  if (trimmed.length > 120) throw new Refusal('playlist_name_long', 'A playlist name is at most 120 characters.');
  return trimmed;
}

export class Library {
  /** Writes, one at a time: a playlist edit reads what the last one wrote. */
  private line: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly disk: Disk,
    readonly dir: string,
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.line.then(work);
    this.line = next.catch(() => undefined);
    return next;
  }

  private sidecarPath(id: string): string {
    return join(this.dir, `${checkId(id, 'song')}.json`);
  }

  /** The audio file a song's sidecar names, or a refusal when it is not a library file. */
  audioPath(file: string): string {
    const name = basename(file);
    if (name !== file || !AUDIO_FILE.test(name)) {
      throw new Refusal('song_file_invalid', `${file} is not a library audio file.`);
    }
    return join(this.dir, name);
  }

  private async readSidecar(id: string): Promise<Sidecar> {
    const text = await this.disk.readText(this.sidecarPath(id));
    if (text === null) throw new Refusal('song_missing', `The song ${id} is no longer in ${this.dir}.`, 404);
    const parsed = JSON.parse(text) as Sidecar;
    if (parsed.bside !== SIDECAR_VERSION || parsed.id !== id) {
      throw new Refusal('song_unreadable', `${id}.json is not a B-Sides song sidecar.`);
    }
    return parsed;
  }

  private async readPlaylists(): Promise<Playlist[]> {
    const text = await this.disk.readText(join(this.dir, PLAYLISTS_FILE));
    if (text === null) return [];
    const parsed = JSON.parse(text) as Partial<PlaylistsDocument>;
    if (parsed.bsidePlaylists !== PLAYLISTS_VERSION || !Array.isArray(parsed.playlists)) {
      throw new Refusal(
        'playlists_unreadable',
        `${join(this.dir, PLAYLISTS_FILE)} is not a B-Sides playlist file; move it aside to start over.`,
      );
    }
    return parsed.playlists;
  }

  private async writePlaylists(playlists: Playlist[]): Promise<void> {
    const document: PlaylistsDocument = { bsidePlaylists: PLAYLISTS_VERSION, playlists };
    await this.disk.writeText(join(this.dir, PLAYLISTS_FILE), `${JSON.stringify(document, null, 2)}\n`);
  }

  /** Every saved song (oldest first) and every playlist. A sidecar that will not read is listed as a problem, never removed. */
  async list(): Promise<LibraryView> {
    const playlists = await this.readPlaylists();
    const names = await this.disk.list(this.dir);
    if (names === null) return { dir: this.dir, songs: [], playlists, problems: [] };
    const songs: Song[] = [];
    const problems: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name === PLAYLISTS_FILE) continue;
      const id = name.slice(0, -'.json'.length);
      let sidecar: Sidecar;
      try {
        const parsed = JSON.parse((await this.disk.readText(join(this.dir, name))) ?? '') as Partial<Sidecar>;
        // Not ours (some other app's .json in the same folder): not a problem, just not a song.
        if (parsed.bside === undefined) continue;
        sidecar = await this.readSidecar(id);
      } catch (err) {
        problems.push(`${name}: ${(err as Error).message}`);
        continue;
      }
      if (!(await this.disk.exists(this.audioPath(sidecar.file)))) {
        problems.push(`${name}: its audio file ${sidecar.file} is missing`);
        continue;
      }
      songs.push(songOf(sidecar));
    }
    songs.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { dir: this.dir, songs, playlists, problems };
  }

  /**
   * Adopt songs no playlist holds (saved by a B-Sides from before playlists) into
   * one playlist, so the rule "a song lives while a playlist holds it" is true of
   * every song in the folder. Run when a library folder is opened.
   */
  async adoptLoose(): Promise<void> {
    await this.serial(async () => {
      const view = await this.list();
      const held = new Set(view.playlists.flatMap((playlist) => playlist.songs));
      const loose = view.songs.filter((song) => !held.has(song.id)).map((song) => song.id);
      if (loose.length === 0) return;
      const playlists = [...view.playlists];
      const at = playlists.findIndex((playlist) => playlist.name === ADOPTED_PLAYLIST);
      if (at >= 0) {
        const found = playlists[at] as Playlist;
        playlists[at] = { ...found, songs: [...found.songs, ...loose] };
      } else {
        playlists.push({ id: crypto.randomUUID(), name: ADOPTED_PLAYLIST, songs: loose, createdAt: new Date().toISOString() });
      }
      await this.writePlaylists(playlists);
      console.log(`[library] adopted ${loose.length} song(s) into "${ADOPTED_PLAYLIST}"`);
    });
  }

  /** File a song: the sidecar first, then the audio (copied from the take), each atomically. */
  private async addSong(song: NewSong): Promise<Song> {
    await this.disk.mkdir(this.dir);
    const from = basename(song.audioFrom);
    const extension = from.slice(from.lastIndexOf('.') + 1).toLowerCase();
    if (!AUDIO_FILE.test(`.${extension}`)) {
      throw new Refusal('song_format', `B-Sides keeps flac, wav or mp3 audio, not .${extension}.`);
    }
    // Unique, sortable, readable: when it was made and which take it was.
    const base = `${stamp(new Date(song.createdAt))}-${song.params.seed ?? 'noseed'}`;
    let id = base;
    for (let n = 2; await this.disk.exists(join(this.dir, `${id}.json`)); n += 1) id = `${base}-${n}`;
    const sidecar: Sidecar = {
      bside: SIDECAR_VERSION,
      id,
      title: song.title,
      file: `${id}.${extension}`,
      model: song.model,
      params: song.params,
      server: song.server,
      jobId: song.jobId,
      createdAt: song.createdAt,
      durationS: song.durationS,
      batch: song.batch,
      album: null,
      bytes: song.bytes,
      effective: song.effective,
    };
    await this.disk.writeText(this.sidecarPath(id), `${JSON.stringify(sidecar, null, 2)}\n`);
    await this.disk.copy(song.audioFrom, this.audioPath(sidecar.file));
    return songOf(sidecar);
  }

  /**
   * Save a song into a playlist. `existing` is the library song a take was
   * already saved as (a second playlist reuses it); otherwise `song` is filed.
   * Answers the song, which is now in the playlist (once — adding it twice is a
   * no-op).
   */
  async saveTo(playlistId: string, existing: string | null, song: NewSong): Promise<Song> {
    return this.serial(async () => {
      const playlists = await this.readPlaylists();
      const at = this.playlistIndex(playlists, playlistId);
      let saved: Song | null = null;
      if (existing !== null) {
        try {
          saved = songOf(await this.readSidecar(existing));
        } catch (err) {
          // Saved once, then deleted from the library: file it again.
          if (!(err instanceof Refusal && err.code === 'song_missing')) throw err;
        }
      }
      if (saved === null) saved = await this.addSong(song);
      const playlist = playlists[at] as Playlist;
      if (!playlist.songs.includes(saved.id)) {
        playlists[at] = { ...playlist, songs: [...playlist.songs, saved.id] };
        await this.writePlaylists(playlists);
      }
      return saved;
    });
  }

  /** Add a song already in the library to another playlist. */
  async addTo(playlistId: string, songId: string): Promise<void> {
    await this.serial(async () => {
      await this.readSidecar(songId);
      const playlists = await this.readPlaylists();
      const at = this.playlistIndex(playlists, playlistId);
      const playlist = playlists[at] as Playlist;
      if (playlist.songs.includes(songId)) return;
      playlists[at] = { ...playlist, songs: [...playlist.songs, songId] };
      await this.writePlaylists(playlists);
    });
  }

  async createPlaylist(name: string): Promise<Playlist> {
    return this.serial(async () => {
      const clean = cleanName(name);
      const playlists = await this.readPlaylists();
      if (playlists.some((playlist) => playlist.name.toLowerCase() === clean.toLowerCase())) {
        throw new Refusal('playlist_name_taken', `There is already a playlist named ${clean}.`);
      }
      const playlist: Playlist = { id: crypto.randomUUID(), name: clean, songs: [], createdAt: new Date().toISOString() };
      await this.disk.mkdir(this.dir);
      await this.writePlaylists([...playlists, playlist]);
      return playlist;
    });
  }

  // ── albums: playlists with `album` details ────────────────────────────────

  /** Start an album: an empty playlist named for now, its details beside it. */
  async createAlbum(name: string, album: AlbumMeta): Promise<Playlist> {
    return this.serial(async () => {
      const playlists = await this.readPlaylists();
      const playlist: Playlist = { id: crypto.randomUUID(), name: cleanName(name), songs: [], createdAt: new Date().toISOString(), album };
      await this.disk.mkdir(this.dir);
      await this.writePlaylists([...playlists, playlist]);
      return playlist;
    });
  }

  /** An album's details, or null when there is no such album (deleted, or a plain playlist). */
  async album(id: string): Promise<AlbumMeta | null> {
    return (await this.readPlaylists()).find((playlist) => playlist.id === id)?.album ?? null;
  }

  /** Write an album's details, and its name once the plan has one. A deleted album is left deleted. */
  async setAlbum(id: string, album: AlbumMeta, name?: string): Promise<void> {
    await this.serial(async () => {
      const playlists = await this.readPlaylists();
      const at = playlists.findIndex((playlist) => playlist.id === id);
      if (at < 0) return;
      const playlist = playlists[at] as Playlist;
      playlists[at] = { ...playlist, album, ...(name === undefined ? {} : { name: cleanName(name) }) };
      await this.writePlaylists(playlists);
    });
  }

  /**
   * File an album another B-Sides sent (a phone saving to its cloud). Its audio
   * files and cover are already in the folder (sent first); this writes each
   * song's sidecar and the playlist. Sending the same album again replaces it.
   */
  async importAlbum(album: ImportedAlbum): Promise<Playlist> {
    return this.serial(async () => {
      if (album.songs.length === 0) throw new Refusal('import_empty', 'That album has no songs to save.');
      for (const song of album.songs) {
        checkId(song.id, 'song');
        if (!(await this.disk.exists(this.audioPath(song.file)))) {
          throw new Refusal('import_audio_missing', `${song.file} did not arrive; send the album again.`);
        }
        const existing = await this.disk.readText(this.sidecarPath(song.id));
        if (existing !== null && (JSON.parse(existing) as Partial<Sidecar>).jobId !== song.jobId) {
          throw new Refusal('import_song_clash', `This library already has a different song named ${song.id}.`);
        }
      }
      if (album.album.cover !== null && !(await this.disk.exists(this.coverPath(album.album.cover)))) {
        throw new Refusal('import_cover_missing', 'The album cover did not arrive; send the album again.');
      }
      for (const song of album.songs) {
        const sidecar: Sidecar = { ...song, bside: SIDECAR_VERSION };
        await this.disk.writeText(this.sidecarPath(song.id), `${JSON.stringify(sidecar, null, 2)}\n`);
      }
      const playlists = (await this.readPlaylists()).filter((playlist) => playlist.id !== album.id);
      const playlist: Playlist = {
        id: checkId(album.id, 'playlist'),
        name: cleanName(album.name),
        songs: album.songs.map((song) => song.id),
        createdAt: album.createdAt,
        album: album.album,
      };
      await this.writePlaylists([...playlists, playlist]);
      return playlist;
    });
  }

  /** Where a file an import sends lands: a song's audio or an album cover, by its name. */
  importPath(name: string): string {
    return /\.cover\.(png|jpe?g|webp)$/i.test(name) ? this.coverPath(name) : this.audioPath(name);
  }

  /** Where an album's painted cover lives, by its file name. */
  coverPath(file: string): string {
    const name = basename(file);
    if (name !== file || !/^[A-Za-z0-9-]+\.cover\.(png|jpe?g|webp)$/i.test(name)) {
      throw new Refusal('cover_file_invalid', `${file} is not an album cover.`);
    }
    return join(this.dir, name);
  }

  async renamePlaylist(id: string, name: string): Promise<void> {
    await this.serial(async () => {
      const clean = cleanName(name);
      const playlists = await this.readPlaylists();
      const at = this.playlistIndex(playlists, id);
      if (playlists.some((playlist) => playlist.id !== id && playlist.name.toLowerCase() === clean.toLowerCase())) {
        throw new Refusal('playlist_name_taken', `There is already a playlist named ${clean}.`);
      }
      playlists[at] = { ...(playlists[at] as Playlist), name: clean };
      await this.writePlaylists(playlists);
    });
  }

  /** Put a playlist's songs in a new order: the same songs, each once. */
  async reorder(id: string, songs: readonly string[]): Promise<void> {
    await this.serial(async () => {
      const playlists = await this.readPlaylists();
      const at = this.playlistIndex(playlists, id);
      const playlist = playlists[at] as Playlist;
      const same = songs.length === playlist.songs.length
        && new Set(songs).size === songs.length
        && songs.every((song) => playlist.songs.includes(song));
      if (!same) {
        throw new Refusal('playlist_order_invalid', `A new order for ${playlist.name} must list each of its songs once.`);
      }
      playlists[at] = { ...playlist, songs: [...songs] };
      await this.writePlaylists(playlists);
    });
  }

  /** Take a song out of a playlist; a song no playlist holds any more is deleted. Answers whether it was. */
  async removeFrom(id: string, songId: string): Promise<boolean> {
    return this.serial(async () => {
      const playlists = await this.readPlaylists();
      const at = this.playlistIndex(playlists, id);
      const playlist = playlists[at] as Playlist;
      playlists[at] = { ...playlist, songs: playlist.songs.filter((song) => song !== songId) };
      await this.writePlaylists(playlists);
      return this.deleteIfLoose(playlists, [songId]);
    });
  }

  /** Delete a playlist; its songs no other playlist holds are deleted with it. Answers how many were. */
  async deletePlaylist(id: string): Promise<number> {
    return this.serial(async () => {
      const playlists = await this.readPlaylists();
      const at = this.playlistIndex(playlists, id);
      const gone = playlists[at] as Playlist;
      const songs = gone.songs;
      playlists.splice(at, 1);
      await this.writePlaylists(playlists);
      if (gone.album?.cover) await this.disk.remove(this.coverPath(gone.album.cover));
      let deleted = 0;
      for (const song of songs) if (await this.deleteIfLoose(playlists, [song])) deleted += 1;
      return deleted;
    });
  }

  async rename(id: string, title: string): Promise<Song> {
    return this.serial(async () => {
      const trimmed = title.trim();
      if (trimmed === '') throw new Refusal('song_title_missing', 'A song needs a title.');
      const sidecar = { ...(await this.readSidecar(id)), title: trimmed };
      await this.disk.writeText(this.sidecarPath(id), `${JSON.stringify(sidecar, null, 2)}\n`);
      return songOf(sidecar);
    });
  }

  async song(id: string): Promise<Song> {
    return songOf(await this.readSidecar(id));
  }

  // ───────────────────────────────────────────────────────────────────────────

  private playlistIndex(playlists: Playlist[], id: string): number {
    const at = playlists.findIndex((playlist) => playlist.id === id);
    if (at < 0) throw new Refusal('playlist_missing', 'That playlist is no longer in the library.', 404);
    return at;
  }

  /** Delete each of `songs` no playlist holds: the audio, then the sidecar (a crash between leaves a listed problem). */
  private async deleteIfLoose(playlists: Playlist[], songs: string[]): Promise<boolean> {
    let any = false;
    for (const songId of songs) {
      if (playlists.some((playlist) => playlist.songs.includes(songId))) continue;
      let sidecar: Sidecar;
      try {
        sidecar = await this.readSidecar(songId);
      } catch (err) {
        if (err instanceof Refusal && err.code === 'song_missing') continue;
        throw err;
      }
      await this.disk.remove(this.audioPath(sidecar.file));
      await this.disk.remove(this.sidecarPath(songId));
      any = true;
    }
    return any;
  }
}
