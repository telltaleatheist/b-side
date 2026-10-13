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
 *   playlists.json   the named playlists, each an ordered list of song ids,
 *                    and the folders they are filed in (`folders`, written
 *                    only once there is one, so a library from before folders
 *                    is left as it was)
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
import { AUDIO_FILE, checkId, isId, stamp, stripFacts } from './takes';
import { holds } from '../planning-sets';
import { FOLDER_DEPTH, type AlbumMeta, type Folder, type LibraryView, type Playlist, type Song, type SongFacts, type SongMade } from '../types';

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
  /**
   * Added beside the playlists, not a new version: a B-Sides from before folders still reads the
   * file (it keeps each playlist's `folder` and drops the folders, which then read as the top level).
   */
  readonly folders?: Folder[];
}

/** The playlists and the folders, as one file holds them. */
interface Shelf {
  readonly playlists: Playlist[];
  readonly folders: Folder[];
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
    structure: structureOf(sidecar.params, sidecar.effective),
    aim: aimOf(sidecar.params, sidecar.effective),
    ...stripFacts(sidecar),
  };
}

/**
 * The length a song aimed for and whether its score landed in it, when it was given one. B-Sides
 * keeps the aim itself since 2026-10-11 and no longer sends it, so it holds the score's length
 * (`length.score_seconds`, which Crucible records for every song) against it as Crucible did
 * (planning-sets.ts holds); an older song has the server's own `min_duration_s`/`in_range`.
 */
export function aimOf(params: SongMade, effective: unknown): Song['aim'] {
  const length = (effective as { length?: { min_duration_s?: unknown; max_duration_s?: unknown; in_range?: unknown; score_seconds?: unknown } } | null)?.length;
  const ours = params.min_duration_s !== undefined || params.max_duration_s !== undefined;
  const min = ours ? params.min_duration_s ?? null : typeof length?.min_duration_s === 'number' ? length.min_duration_s : null;
  const max = ours ? params.max_duration_s ?? null : typeof length?.max_duration_s === 'number' ? length.max_duration_s : null;
  if (min === null && max === null) return null;
  const inRange = !ours && typeof length?.in_range === 'boolean' ? length.in_range
    : typeof length?.score_seconds === 'number' ? holds({ min, max }, length.score_seconds) : null;
  return { min, max, inRange };
}

/**
 * The planning set an instrumental was scored from: the one B-Sides picked (`params.planning_set`,
 * 2026-10-11), or on an older song the server's record (`planning_lyrics.id`). Planning lyrics
 * B-Sides sent are recorded by the server with no id, whatever source it names.
 */
export function structureOf(params: SongMade, effective: unknown): string | null {
  if (typeof params.planning_set === 'string' && params.planning_set !== '') return params.planning_set;
  const planning = (effective as { planning_lyrics?: { id?: unknown } } | null)?.planning_lyrics;
  return typeof planning?.id === 'string' && planning.id !== '' ? planning.id : null;
}

function cleanName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '') throw new Refusal('playlist_name_missing', 'A playlist needs a name.');
  if (trimmed.length > 120) throw new Refusal('playlist_name_long', 'A playlist name is at most 120 characters.');
  return trimmed;
}

function cleanFolderName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '') throw new Refusal('folder_name_missing', 'A folder needs a name.');
  if (trimmed.length > 120) throw new Refusal('folder_name_long', 'A folder name is at most 120 characters.');
  return trimmed;
}

/**
 * The folders as they can be trusted: each once, each parent one that exists, no folder inside
 * itself. A folder whose parent is gone (or that loops) sits at the top, and a playlist filed in a
 * folder that is gone (an older B-Sides dropped the folders) is at the top too: nothing is lost.
 */
function tidyShelf(playlists: Playlist[], folders: Folder[]): Shelf {
  const seen = new Set<string>();
  const kept = folders.filter((folder) => {
    const fine = typeof folder?.id === 'string' && typeof folder.name === 'string' && !seen.has(folder.id);
    if (fine) seen.add(folder.id);
    return fine;
  });
  const parentOf = new Map(kept.map((folder) => [folder.id, typeof folder.parent === 'string' && seen.has(folder.parent) ? folder.parent : null]));
  const loops = (id: string): boolean => {
    const met = new Set<string>();
    for (let at: string | null = id; at !== null; at = parentOf.get(at) ?? null) {
      if (met.has(at)) return true;
      met.add(at);
    }
    return false;
  };
  const tidy = kept.map((folder) => {
    const parent = parentOf.get(folder.id) ?? null;
    return parent === folder.parent && !loops(folder.id) ? folder : { ...folder, parent: null };
  });
  const tidyPlaylists = playlists.map((playlist) =>
    playlist.folder == null || seen.has(playlist.folder) ? playlist : { ...playlist, folder: null });
  return { playlists: tidyPlaylists, folders: tidy };
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
    const stem = name.replace(AUDIO_FILE, '');
    // A song's id names its file: a name from the network never becomes a stream (`a:b`), a device or an illegal path.
    if (name !== file || stem === name || !isId(stem)) {
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
    return (await this.readShelf()).playlists;
  }

  private async readShelf(): Promise<Shelf> {
    const text = await this.disk.readText(join(this.dir, PLAYLISTS_FILE));
    if (text === null) return { playlists: [], folders: [] };
    const parsed = JSON.parse(text) as Partial<PlaylistsDocument>;
    if (parsed.bsidePlaylists !== PLAYLISTS_VERSION || !Array.isArray(parsed.playlists)) {
      throw new Refusal(
        'playlists_unreadable',
        `${join(this.dir, PLAYLISTS_FILE)} is not a B-Sides playlist file; move it aside to start over.`,
      );
    }
    return tidyShelf(parsed.playlists, Array.isArray(parsed.folders) ? parsed.folders : []);
  }

  /** Write the playlists; the folders as given, else as they are on disk (a playlist edit leaves them be). */
  private async writePlaylists(playlists: Playlist[], folders?: Folder[]): Promise<void> {
    const shelf = folders ?? (await this.readShelf()).folders;
    const document: PlaylistsDocument = { bsidePlaylists: PLAYLISTS_VERSION, playlists, ...(shelf.length > 0 ? { folders: shelf } : {}) };
    await this.disk.writeText(join(this.dir, PLAYLISTS_FILE), `${JSON.stringify(document, null, 2)}\n`);
  }

  /** Every saved song (oldest first) and every playlist. A sidecar that will not read is listed as a problem, never removed. */
  async list(): Promise<LibraryView> {
    const { playlists, folders } = await this.readShelf();
    const names = await this.disk.list(this.dir);
    if (names === null) return { dir: this.dir, songs: [], playlists, folders, problems: [] };
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
    return { dir: this.dir, songs, playlists, folders, problems };
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
      ...stripFacts(song),
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

  /**
   * Start an album: an empty playlist named for now, its details beside it, filed in `folder` when
   * one was picked in Make (Victoria, 2026-10-11: lullaby albums in their own folder).
   */
  async createAlbum(name: string, album: AlbumMeta, folder: string | null = null): Promise<Playlist> {
    return this.serial(async () => {
      const { playlists, folders } = await this.readShelf();
      if (folder !== null) this.folderIndex(folders, folder);
      const playlist: Playlist = {
        id: crypto.randomUUID(), name: cleanName(name), songs: [], createdAt: new Date().toISOString(), album,
        ...(folder === null ? {} : { folder }),
      };
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
      const before = await this.readPlaylists();
      // Sent again: it stays in the folder it was filed in here.
      const folder = before.find((playlist) => playlist.id === album.id)?.folder ?? null;
      const playlists = before.filter((playlist) => playlist.id !== album.id);
      const playlist: Playlist = {
        id: checkId(album.id, 'playlist'),
        name: cleanName(album.name),
        songs: album.songs.map((song) => song.id),
        createdAt: album.createdAt,
        album: album.album,
        ...(folder === null ? {} : { folder }),
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

  /** Remove a cover file a newer one replaced. */
  async removeCover(file: string): Promise<void> {
    await this.disk.remove(this.coverPath(file));
  }

  /** Give a plain playlist a copy of a cover file (an album's), under a name of its own. */
  async copyCoverTo(id: string, cover: string): Promise<void> {
    await this.serial(async () => {
      const playlists = await this.readPlaylists();
      const at = this.playlistIndex(playlists, id);
      const extension = cover.slice(cover.lastIndexOf('.') + 1);
      const file = `${id}-${Date.now().toString(36)}.cover.${extension}`;
      await this.disk.copy(this.coverPath(cover), this.coverPath(file));
      playlists[at] = { ...(playlists[at] as Playlist), cover: file };
      await this.writePlaylists(playlists);
    });
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

  /**
   * Put `fresh` (just filed into the playlist, at its end) in `old`'s place, and take `old` out:
   * an album track made again (Victoria, 2026-10-11). `old` goes into `keepIn` (New Songs), so the
   * old take is kept outside the album; with no `keepIn`, or that playlist gone, it is deleted
   * once no playlist holds it. Answers false, changing nothing, when `old` is not in the playlist.
   */
  async replaceIn(id: string, old: string, fresh: string, keepIn: string | null): Promise<boolean> {
    return this.serial(async () => {
      const playlists = await this.readPlaylists();
      const at = this.playlistIndex(playlists, id);
      const playlist = playlists[at] as Playlist;
      const place = playlist.songs.indexOf(old);
      if (place < 0 || old === fresh) return false;
      const songs = playlist.songs.map((song) => (song === old ? fresh : song));
      playlists[at] = { ...playlist, songs: songs.filter((song, i) => song !== fresh || i === place) };
      const keep = keepIn === null ? -1 : playlists.findIndex((each) => each.id === keepIn);
      if (keep >= 0 && keep !== at) {
        const into = playlists[keep] as Playlist;
        if (!into.songs.includes(old)) playlists[keep] = { ...into, songs: [...into.songs, old] };
      }
      await this.writePlaylists(playlists);
      await this.deleteIfLoose(playlists, [old]);
      return true;
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
      const cover = gone.album?.cover ?? gone.cover;
      if (cover) await this.disk.remove(this.coverPath(cover));
      let deleted = 0;
      for (const song of songs) if (await this.deleteIfLoose(playlists, [song])) deleted += 1;
      return deleted;
    });
  }

  // ── folders: albums and playlists grouped (Victoria, 2026-10-11) ───────────

  /** Make a folder at the top of the library, or inside `parent`; it goes after the folders beside it. */
  async createFolder(name: string, parent: string | null = null): Promise<Folder> {
    return this.serial(async () => {
      const clean = cleanFolderName(name);
      const { playlists, folders } = await this.readShelf();
      if (parent !== null) {
        this.folderIndex(folders, parent);
        if (this.depth(folders, parent) + 1 > FOLDER_DEPTH) throw this.tooDeep();
      }
      this.nameFree(folders, clean, parent, null);
      const folder: Folder = { id: crypto.randomUUID(), name: clean, parent, createdAt: new Date().toISOString() };
      await this.disk.mkdir(this.dir);
      await this.writePlaylists(playlists, [...folders, folder]);
      return folder;
    });
  }

  async renameFolder(id: string, name: string): Promise<void> {
    await this.serial(async () => {
      const clean = cleanFolderName(name);
      const { playlists, folders } = await this.readShelf();
      const at = this.folderIndex(folders, id);
      const folder = folders[at] as Folder;
      this.nameFree(folders, clean, folder.parent, id);
      folders[at] = { ...folder, name: clean };
      await this.writePlaylists(playlists, folders);
    });
  }

  /**
   * Delete a folder, never what is in it: its folders, albums and playlists move up a level, into
   * the folder it was in (or the top), its folders taking its place among their new siblings.
   */
  async deleteFolder(id: string): Promise<void> {
    await this.serial(async () => {
      const shelf = await this.readShelf();
      const at = this.folderIndex(shelf.folders, id);
      const gone = shelf.folders[at] as Folder;
      const inside = shelf.folders.filter((folder) => folder.parent === id).map((folder) => ({ ...folder, parent: gone.parent }));
      const rest = shelf.folders.filter((folder) => folder.id !== id && folder.parent !== id);
      // Its place in the order, counted among the folders that stay where they are.
      const place = shelf.folders.slice(0, at).filter((folder) => folder.parent !== id).length;
      const folders = [...rest.slice(0, place), ...inside, ...rest.slice(place)];
      const playlists = shelf.playlists.map((playlist) => (playlist.folder === id ? { ...playlist, folder: gone.parent } : playlist));
      await this.writePlaylists(playlists, folders);
    });
  }

  /**
   * Move a folder into `parent` (null: the top), just before the folder `before` there, or after
   * the folders there when `before` is null. A folder never goes inside itself.
   */
  async moveFolder(id: string, parent: string | null, before: string | null = null): Promise<void> {
    await this.serial(async () => {
      const { playlists, folders } = await this.readShelf();
      const folder = folders[this.folderIndex(folders, id)] as Folder;
      if (parent !== null) {
        this.folderIndex(folders, parent);
        for (let up: string | null = parent; up !== null; up = folders.find((other) => other.id === up)?.parent ?? null) {
          if (up === id) throw new Refusal('folder_inside_itself', `${folder.name} cannot go inside itself.`);
        }
        if (this.depth(folders, parent) + this.height(folders, id) > FOLDER_DEPTH) throw this.tooDeep();
      }
      if (parent !== folder.parent) this.nameFree(folders, folder.name, parent, id);
      const rest = folders.filter((other) => other.id !== id);
      const moved: Folder = { ...folder, parent };
      if (before === null) {
        rest.push(moved);
      } else {
        const next = rest.findIndex((other) => other.id === before);
        if (next < 0 || (rest[next] as Folder).parent !== parent) {
          throw new Refusal('folder_place_invalid', 'A folder goes before another folder in the same place.');
        }
        rest.splice(next, 0, moved);
      }
      await this.writePlaylists(playlists, rest);
    });
  }

  /**
   * File an album or playlist in a folder (null: the top of the library), just before the playlist
   * `before` there, or after the ones there when `before` is null. It stays whole: only its place changes.
   */
  async movePlaylist(id: string, folder: string | null, before: string | null = null): Promise<void> {
    await this.serial(async () => {
      const { playlists, folders } = await this.readShelf();
      const at = this.playlistIndex(playlists, id);
      if (folder !== null) this.folderIndex(folders, folder);
      const moved: Playlist = { ...(playlists[at] as Playlist), folder };
      const rest = playlists.filter((playlist) => playlist.id !== id);
      if (before === null) {
        rest.push(moved);
      } else {
        const next = rest.findIndex((playlist) => playlist.id === before);
        if (next < 0 || ((rest[next] as Playlist).folder ?? null) !== folder) {
          throw new Refusal('playlist_place_invalid', 'A playlist goes before another playlist in the same folder.');
        }
        rest.splice(next, 0, moved);
      }
      await this.writePlaylists(rest, folders);
    });
  }

  /**
   * Replace a song's audio with a file made elsewhere (Victoria, 2026-10-13): under a new name beside
   * the sidecar, so a player's cached copy of the old one is never played again; the old file goes once
   * the sidecar names the new. The record keeps everything but the length, the size and where it came from.
   */
  async replaceAudio(id: string, from: string, facts: { readonly name: string; readonly durationS: number | null; readonly bytes: number }): Promise<Song> {
    return this.serial(async () => {
      const sidecar = await this.readSidecar(id);
      const fromName = basename(from);
      const extension = fromName.slice(fromName.lastIndexOf('.') + 1).toLowerCase();
      if (!AUDIO_FILE.test(`.${extension}`)) {
        throw new Refusal('song_format', `B-Sides keeps flac, wav or mp3 audio, not .${extension}.`);
      }
      let file = `${id}-r1.${extension}`;
      for (let n = 2; await this.disk.exists(this.audioPath(file)); n += 1) file = `${id}-r${n}.${extension}`;
      await this.disk.copy(from, this.audioPath(file));
      const effective = typeof sidecar.effective === 'object' && sidecar.effective !== null ? sidecar.effective : {};
      const next: Sidecar = {
        ...sidecar,
        file,
        durationS: facts.durationS ?? sidecar.durationS,
        bytes: facts.bytes,
        effective: { ...effective, replacedFrom: facts.name, replacedAt: new Date().toISOString() },
      };
      await this.disk.writeText(this.sidecarPath(id), `${JSON.stringify(next, null, 2)}\n`);
      if (sidecar.file !== file) await this.disk.remove(this.audioPath(sidecar.file)).catch(() => undefined);
      return songOf(next);
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

  /** Set a song's lyrics (pasted for a song made elsewhere, or corrected); blank clears them. */
  async setLyrics(id: string, lyrics: string): Promise<Song> {
    return this.serial(async () => {
      const sidecar = await this.readSidecar(id);
      const words = lyrics.replace(/\r\n?/g, '\n').trim();
      const next = { ...sidecar, params: { ...sidecar.params, lyrics: words === '' ? null : words, instrumental: words === '' ? sidecar.params.instrumental : false } };
      await this.disk.writeText(this.sidecarPath(id), `${JSON.stringify(next, null, 2)}\n`);
      return songOf(next);
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

  private folderIndex(folders: Folder[], id: string): number {
    const at = folders.findIndex((folder) => folder.id === id);
    if (at < 0) throw new Refusal('folder_missing', 'That folder is no longer in the library.', 404);
    return at;
  }

  /** How deep a folder sits: 1 at the top of the library. (The folders are tidy: no loops.) */
  private depth(folders: Folder[], id: string): number {
    let depth = 0;
    for (let at: string | null = id; at !== null; at = folders.find((folder) => folder.id === at)?.parent ?? null) depth += 1;
    return depth;
  }

  /** How many levels a folder takes with the folders inside it: 1 when it holds none. */
  private height(folders: Folder[], id: string): number {
    const inside = folders.filter((folder) => folder.parent === id);
    return 1 + Math.max(0, ...inside.map((folder) => this.height(folders, folder.id)));
  }

  private tooDeep(): Refusal {
    return new Refusal('folder_too_deep', `Folders go at most ${FOLDER_DEPTH} deep.`);
  }

  /** Two folders side by side never share a name; the same name in different folders is fine. */
  private nameFree(folders: Folder[], name: string, parent: string | null, self: string | null): void {
    if (folders.some((folder) => folder.id !== self && folder.parent === parent && folder.name.toLowerCase() === name.toLowerCase())) {
      throw new Refusal('folder_name_taken', `There is already a folder named ${name} there.`);
    }
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
