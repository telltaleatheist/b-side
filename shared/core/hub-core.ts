/**
 * hub-core — what a B-Sides hub IS, wherever it runs: the desktop's HTTP hub
 * (electron/hub/hub.ts) and the phone's own (src/app/phone/phone-hub.ts) are
 * two doors onto this one class.
 *
 * It holds:
 *   - the Crucible server registry (tokens never leave it: the hub proxies);
 *   - pairing a server by its address;
 *   - the job runner (a client asks; the hub submits, follows and fetches);
 *   - the take cache — every client's playing list (`TakeStore`);
 *   - the library — saved songs and playlists (`Library`).
 *
 * and answers the `/api` routes every client uses, as plain handlers over a
 * `CoreRequest` (params, body, the calling client). What only a door can do is
 * the door's: the event stream and audio files (HTTP on the desktop, in-process
 * on the phone), the desktop's settings, sharing and key.
 *
 * Changes go out through the door's `EventSink`: to one client (its jobs and
 * takes) or to all (the library, the server list).
 */
import type { CrucibleClient } from '@crucible/client';

import { AlbumMaker, albumLine, trackSong } from './albums';
import { ServerNeeds } from './server-needs';
import { clientFor, clientName, probe, serverPresets, setClientName, songPage, startInstall } from './crucible';
import { PresetStore } from './presets';
import { describe, layLyrics, lyricsBrief } from './describe';
import { describeSound, nameSong } from './split-text';
import { freshLine } from './fresh-names';
import { voiceCheck } from './voice-check';
import type { Lyricist } from './lyricist';
import { crucibleText, WRITERS, type TextModel, type Writer } from './text-model';
import { join, type Disk } from './disk';
import { JobRunner, type AudioFetcher } from './jobs';
import { Library, type ImportedAlbum } from './library';
import { PairingSessions } from './pairing';
import { Refusal } from './refusal';
import { ServerRegistry, type StoredServer, type Vault } from './servers';
import { TakeStore, type TakeLimits } from './takes';
import { defaultTitle } from './titles';
import {
  ALBUM_MINUTES,
  ALBUM_ORDERS,
  ALBUM_SPACE_GB,
  albumBytes,
  DESCRIPTION_MAX,
  ENDED_PHASES,
  LENGTH_AIMS,
  SINGLES_NAME,
  SINGLES_ORDERS,
  SONG_FORMATS,
  SONG_MODEL,
  type AlbumAsk,
  type AlbumMeta,
  type AlbumOrder,
  type ClientKind,
  type DescribeResult,
  type GenerateRequest,
  type HubEvent,
  type HubInfo,
  type HubPreferences,
  type HubSnapshot,
  type LibraryView,
  type Playlist,
  type ServerInput,
  type ServerView,
  type SinglesOrder,
  type Song,
  type SongForm,
  type SongPage,
} from '../types';

/** The device a request comes from. */
export interface CoreClient {
  readonly id: string;
  readonly kind: ClientKind;
}

export interface CoreRequest {
  readonly params: Readonly<Record<string, string>>;
  /** The JSON body, refused unless it is an object. */
  body(): Promise<Record<string, unknown>>;
  /** The calling device; refuses when it did not say. */
  client(): CoreClient;
}

export type CoreHandler = (request: CoreRequest) => Promise<unknown> | unknown;

export interface CoreRoute {
  readonly method: string;
  readonly template: string;
  readonly pattern: RegExp;
  readonly names: readonly string[];
  readonly handler: CoreHandler;
}

export interface EventSink {
  send(client: string, event: HubEvent): void;
  broadcast(event: HubEvent): void;
  /** A client that has gone for good (a closed browser tab): nobody is left to play its songs. */
  isClosed(client: string): boolean;
}

export interface HubCoreOptions {
  readonly disk: Disk;
  /** Where the server list (with tokens) is kept. */
  readonly vault: Vault;
  /** The hub's own folder: `takes/` and `pending.json` go here. */
  readonly dataDir: string;
  readonly takeLimits: TakeLimits;
  /** What this hub calls itself to Crucible (`X-Crucible-Client`, pairing requests). */
  readonly clientName: string;
  readonly fetchAudio: AudioFetcher;
  readonly info: HubInfo;
  readonly sink: EventSink;
  /** Set on the phone: albums kept here only may take `albumSpaceGb`; past it a new album is refused. */
  readonly limitsAlbumSpace?: boolean;
  /** Claude through Claude Code on this computer, writing in B-Sides' model's place; absent on the phone. */
  readonly claude?: { readonly text: TextModel; readonly lyricist: Lyricist; check(): Promise<void> };
  /**
   * Shrink a painted cover larger than a tile needs to a COVER_KEPT_PX JPEG beside it; answers the
   * new file's name (in the same folder). Absent (the phone): the cover is kept as painted.
   */
  readonly shrinkCover?: (file: string, side: number) => Promise<string | null>;
}

/** The pseudo-client an album's tracks are made for: their jobs and takes never show in anyone's playing list. */
function albumClient(id: string): string {
  return `album-${id}`;
}

/** MP3 unless the person chose lossless: about an eighth the size, the same sound on a phone. */
const DEFAULT_PREFERENCES: HubPreferences = { songFormat: 'mp3', albumSpaceGb: 2, writer: 'bside', lyricist: 'bside', albumOrder: 'one', singles: 'turn' };


export function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Refusal('body_invalid', `${what} must be text.`);
  return value;
}

/** A folder or playlist named in a body: its id, or null for none (the top of the library). */
function idOrNull(value: unknown, what: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Refusal('body_invalid', `${what} must be an id, or null.`);
  return value;
}

/** Turn `/api/things/:id` into a matcher; the door decodes each `:name` it captures. */
export function routeOf<H>(method: string, template: string, handler: H): { method: string; template: string; pattern: RegExp; names: string[]; handler: H } {
  const names: string[] = [];
  const pattern = new RegExp(
    `^${template.replace(/:([a-zA-Z]+)/g, (_, name: string) => {
      names.push(name);
      return '([^/]+)';
    })}$`,
  );
  return { method, template, pattern, names, handler };
}

/** The first route that answers `method path`, with its decoded params; null when none does. */
export function matchRoute<R extends { method: string; pattern: RegExp; names: readonly string[] }>(
  routes: readonly R[],
  method: string,
  path: string,
): { route: R; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(path);
    if (match === null) continue;
    const params: Record<string, string> = {};
    route.names.forEach((name, at) => {
      params[name] = decodeURIComponent(match[at + 1] as string);
    });
    return { route, params };
  }
  return null;
}

/** The longest name a song is given when it lands (a writer's title, cut to fit). */
const SONG_TITLE_MAX = 80;

/** A name the person gave a song or an album in Make, tidied; null when they gave none. */
function givenName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\s+/g, ' ').trim();
  if (name.length > 120) throw new Refusal('name_too_long', `A name is at most 120 characters; this one is ${name.length}.`);
  return name === '' ? null : name;
}

/** An album's description: refused by name when too long, never cut (DESCRIPTION_MAX). */
function albumDescription(value: unknown): string {
  const description = text(value ?? '', 'description');
  if (description.length > DESCRIPTION_MAX) {
    throw new Refusal('description_too_long', `A description is at most ${DESCRIPTION_MAX} characters; this one is ${description.length}. Shorten it, or put what the lyrics should be about in its own box.`);
  }
  return description;
}

/** What an album download holds. */
export interface AlbumFiles {
  readonly name: string;
  readonly artist: string;
  readonly blurb: string;
  /** The cover file, when it has one (painted, or the person's own). */
  readonly cover: string | null;
  readonly tracks: readonly { readonly title: string; readonly file: string; readonly lyrics: string | null }[];
}

/** The albums making their music on `server`, in the order they send tracks (albumLine). */
function making(playlists: readonly Playlist[], server: string, order: AlbumOrder): Playlist[] {
  const line = playlists.filter((playlist) => playlist.album?.stage === 'making' && playlist.album.server === server);
  return albumLine(line as (Playlist & { album: AlbumMeta })[], order);
}

/** A cover the person sets themselves: the image types kept, and the largest file (the page shrinks it first). */
const COVER_TYPES: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const COVER_UPLOAD_MAX = 700 * 1024;

/**
 * How long a cover may paint, once it has started, before the album goes on without it (the standard
 * cover stands in). Its wait in the server's line does not count (Victoria's laptop, 2026-10-11: five
 * covers queued behind songs, and Color Party's gave up after 15 minutes without ever starting); the
 * server ends a job that waits past its own limit, and an expired cover is asked for again.
 */
const COVER_WAIT_MS = 15 * 60_000;
/** The size every cover is painted at (Owen, 2026-10-11), whichever model paints it. */
const COVER_PAINT_PX = 1024;
/** Why the server may drop a cover from its line through no fault of the cover's: then it is asked for again. */
const RESEND_COVER_REASONS: readonly string[] = ['session_closed', 'server_restart', 'expired'];
/** How often a cover job's status is read while it paints. */
const COVER_POLL_MS = 2000;

/** A painted cover larger than this is shrunk to it for keeping (a tile never shows more). */
const COVER_KEPT_PX = 512;

/**
 * The side to paint `model`'s cover at, from Crucible 1.0.138's image page facts: a model that
 * paints well at COVER_SIZE (`quality_min_side` at most that: qwen-image) keeps it, as Owen chose
 * on 2026-10-06; one that does not paints at its `native_size` (Owen, 2026-10-10, comparing
 * DreamShaper at 512 and 1024: "1024 is definitely better. lets stick to that"), else at its
 * minimum. COVER_SIZE when the server publishes nothing. Read from the playground directly: the
 * pinned SDK predates the facts and drops them.
 */
export async function coverSide(server: StoredServer, model: string): Promise<number> {
  try {
    const response = await fetch(`${server.url.replace(/\/+$/, '')}/v1/playground`, { headers: { Authorization: `Bearer ${server.token}`, 'X-Crucible-Api': '1' } });
    if (!response.ok) return COVER_SIZE;
    const body = (await response.json()) as { pages?: { id?: unknown; facts?: { quality_min_side?: unknown; native_width?: unknown; native_height?: unknown; native_size?: unknown } }[] };
    const facts = body.pages?.find((page) => page.id === model)?.facts;
    const least = facts?.quality_min_side;
    if (typeof least !== 'number' || !Number.isFinite(least) || least <= COVER_SIZE) return COVER_SIZE;
    // 1.0.140 publishes native_width and native_height (a square cover takes the smaller).
    const native = sideOf(facts?.native_width !== undefined || facts?.native_height !== undefined
      ? { width: facts.native_width, height: facts.native_height } : facts?.native_size);
    // A multiple of 32, as the server takes.
    return Math.ceil((native !== null && native >= least ? native : least) / 32) * 32;
  } catch {
    return COVER_SIZE;
  }
}

/** A published size as one side: a number, [width, height] or {width, height} (the smaller side). */
function sideOf(size: unknown): number | null {
  const pair = Array.isArray(size) ? size : size !== null && typeof size === 'object'
    ? [(size as { width?: unknown }).width, (size as { height?: unknown }).height] : [size, size];
  const sides = pair.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
  return sides.length === 0 ? null : Math.min(...sides);
}

/** The painted cover's width and height, in pixels. */
const COVER_SIZE = 256;

export class HubCore {
  readonly registry: ServerRegistry;
  readonly takes: TakeStore;
  readonly jobs: JobRunner;
  readonly routes: CoreRoute[] = [];
  private readonly pairing: PairingSessions;
  private readonly albums: AlbumMaker;
  private library!: Library;
  private readonly sink: EventSink;
  private preferences: HubPreferences = DEFAULT_PREFERENCES;
  private readonly presets: PresetStore;
  private readonly needs = new ServerNeeds();

  constructor(private readonly options: HubCoreOptions) {
    this.sink = options.sink;
    // A computer with Claude Code writes everything through it until B-Sides' model is ready (Owen,
    // 2026-10-11: "just keep every call as claude -p"); the phone, without it, keeps B-Sides' model.
    // On a computer with Claude Code, Claude writes the words and the server's model the sound
    // (Owen, 2026-10-11); a phone, without it, has the server's model write both.
    if (options.claude !== undefined) this.preferences = { ...DEFAULT_PREFERENCES, writer: 'bside', lyricist: 'claude', textSplit: 2 };
    this.registry = new ServerRegistry(options.vault);
    setClientName(options.clientName);
    this.pairing = new PairingSessions(options.clientName, async (pairing) => {
      const name = await this.registry.addPaired(pairing);
      this.serversChanged();
      return name;
    });
    this.takes = new TakeStore(options.disk, join(options.dataDir, 'takes'), options.takeLimits);
    this.presets = new PresetStore(options.disk, options.dataDir, serverPresets);
    this.takes.onGone((take, reason) => this.sink.send(take.client, { type: 'take-gone', id: take.id, reason }));
    this.jobs = new JobRunner(
      {
        publish: (job) => {
          // An album's track belongs to the album's own client, which no device is: every device follows it.
          if (job.album != null) this.sink.broadcast({ type: 'album-job', job });
          else this.sink.send(job.client, { type: 'job', job });
        },
        server: (name) => this.registry.get(name),
        land: async (landed) => {
          if (this.sink.isClosed(landed.job.client)) {
            throw new Refusal('client_closed', 'The browser tab that asked for this song has closed; nobody is left to play it.');
          }
          const params = landed.job.params;
          const album = landed.job.album ?? null;
          const planned = album === null ? null : ((await this.library.album(album.id))?.plan?.tracks[album.track] ?? null);
          const take = await this.takes.add({
            client: landed.job.client,
            kind: landed.job.clientKind,
            title: planned?.title ?? landed.job.title ?? defaultTitle(params),
            extension: landed.extension,
            fill: landed.fill,
            model: SONG_MODEL,
            params: {
              tags: params.tags ?? null,
              lyrics: params.lyrics ?? null,
              instrumental: params.instrumental === true,
              cfg: params.cfg ?? null,
              seed: landed.seed,
              // B-Sides' own since 2026-10-11: the server's record of planning lyrics it was sent names no set.
              ...(params.instrumental === true && params.planning_set !== undefined ? { planning_set: params.planning_set } : {}),
              ...(params.min_duration_s !== undefined ? { min_duration_s: params.min_duration_s } : {}),
              ...(params.max_duration_s !== undefined ? { max_duration_s: params.max_duration_s } : {}),
            },
            server: { name: landed.server.name, url: landed.server.url },
            jobId: landed.job.jobId as string,
            durationS: landed.durationS,
            batch: landed.job.batch > 1 ? { index: landed.job.index, of: landed.job.batch } : null,
            effective: landed.effective,
            createdAt: new Date().toISOString(),
          });
          if (album !== null) {
            // An album's track goes straight into the album; it never sits in a playing list.
            await this.fileAlbumTrack(album.id, take.id, album.track);
            return { take, songId: null };
          }
          const into = landed.job.playlist ?? null;
          if (into != null) {
            // A song made on its own goes into New Songs; it never sits in a playing list either.
            const songId = await this.fileTake(into, take.id);
            if (songId !== null) return { take, songId };
          }
          this.sink.send(take.client, { type: 'take', take });
          return { take, songId: null };
        },
        ended: (job) => {
          if (job.album && job.phase !== 'cancelled') void this.albums.failed(job.album.id, job.refusal, job.album.track).then(() => this.libraryChanged());
          // A remake cancelled (Stop, the album deleted) is dropped; its old take stays.
          if (job.album && job.phase === 'cancelled') void this.albums.cancelled(job.album.id, job.album.track).then(() => this.libraryChanged());
          // A single song that ended without one frees the line too (it never lands).
          if (job.album == null) this.singleLeft(job.server);
        },
        // A single song being fetched is off the server: albums held back for it carry on.
        fetching: (job) => {
          if (job.album == null) this.singleLeft(job.server);
        },
      },
      options.disk,
      join(options.dataDir, 'pending.json'),
      options.fetchAudio,
    );
    this.albums = new AlbumMaker({
      meta: (id) => this.library.album(id),
      update: async (id, meta, name) => {
        await this.library.setAlbum(id, meta, name);
        await this.libraryChanged();
      },
      server: (name) => this.registry.get(name),
      // Its own client name: Crucible counts every request from the session's name as one of its
      // items, and removes the ones still waiting when it closes. Under the install's own name, a song
      // made meanwhile would join the album's session and be dropped with it.
      client: (server, album) => (album ? clientFor(server, `${clientName()}/album`) : clientFor(server)),
      page: (server) => this.songPageOf(server).catch(() => null),
      paint: (id, server, client, model, prompt) => this.paintCover(id, server, client, model, prompt),
      removeCover: (file) => this.library.removeCover(file),
      render: (id, track, server, params) => {
        // Whether this server's YuE2 makes instrumentals, as its song page said when the album was written.
        const song = trackSong(params, track, this.pages.get(server.name));
        this.jobs.generate(server, { id: albumClient(id), kind: 'desktop' }, { params: song, count: 1 }, this.preferences.songFormat, { id, track });
      },
      inFlight: (id) => this.jobs.list(albumClient(id)).filter((job) => !ENDED_PHASES.includes(job.phase)).length,
      retitle: async (id, titles) => {
        const view = await this.libraryView();
        const songs = view.playlists.find((p) => p.id === id)?.songs ?? [];
        for (const [at, title] of titles.entries()) {
          const songId = songs[at];
          if (songId !== undefined) await this.library.rename(songId, title);
        }
        if (titles.length > 0) await this.libraryChanged();
      },
      made: async (id) => {
        const view = await this.libraryView();
        const playlist = view.playlists.find((p) => p.id === id);
        const songs = new Map(view.songs.map((song) => [song.id, song]));
        return (playlist?.songs ?? []).flatMap((songId) => {
          const song = songs.get(songId);
          return song === undefined ? [] : [{ title: song.title, durationS: song.durationS }];
        });
      },
      claude: () => this.claude(),
      freshNames: () => this.freshNames(),
      renameSong: async (id, from, to) => {
        const view = await this.libraryView();
        const playlist = view.playlists.find((p) => p.id === id);
        const songs = new Map(view.songs.map((song) => [song.id, song]));
        const songId = playlist?.songs.find((sid) => songs.get(sid)?.title.toLowerCase() === from.toLowerCase());
        if (songId === undefined) return;
        await this.library.rename(songId, to);
        await this.libraryChanged();
      },
      makingOn: (server) => this.makingOn(server),
      order: () => ({ albums: this.preferences.albumOrder ?? 'one', singles: this.preferences.singles ?? 'turn' }),
      singlesWaiting: (server) => this.jobs.singlesWaiting(server),
      flyingTracks: (id) => this.jobs.list(albumClient(id))
        .filter((job) => !ENDED_PHASES.includes(job.phase) && job.album?.id === id)
        .map((job) => job.album?.track as number),
      cancelInFlight: async (id) => {
        for (const job of this.jobs.list(albumClient(id)).filter((j) => !ENDED_PHASES.includes(j.phase))) {
          await this.jobs.cancel(job.key).catch((err: unknown) => console.error(`[albums] could not cancel ${job.key}:`, err));
        }
      },
    });
    this.defineRoutes();
  }

  /** Read what is stored: the server list, the take cache, the library in `libraryDir`. */
  async open(libraryDir: string): Promise<void> {
    await this.readPreferences();
    await this.registry.open();
    await this.takes.open();
    await this.openLibrary(libraryDir);
  }

  /** Follow again the jobs that were generating when this hub last stopped, and the albums being made. */
  async resume(): Promise<void> {
    this.askNeeds();
    await this.jobs.resume();
    // Before any album opens a new one: this install's album sessions left over from a run that
    // ended (crucible-pc-1, 2026-10-11: every hold has an owner and a reconciler that finds orphans).
    await Promise.all(this.registry.views().map((view) => this.closeOrphanSessions(view.name)));
    for (const playlist of (await this.libraryView()).playlists) {
      const stage = playlist.album?.stage;
      if (stage === 'planning' || stage === 'cover' || stage === 'making') this.albums.start(playlist.id);
    }
  }

  /** File an album a phone sent to this hub (its files arrived first, through the door's upload route). */
  async importAlbum(album: ImportedAlbum): Promise<LibraryView> {
    await this.library.importAlbum({ ...album, album: { ...album.album, stage: album.album.stage === 'done' ? 'done' : 'stopped' } });
    return this.libraryChanged();
  }

  /** Where an uploaded file (a song's audio, an album cover) belongs, by its name. */
  importPath(name: string): string {
    return this.library.importPath(name);
  }

  /** An album's painted cover file, when it has one. */
  async coverFile(id: string): Promise<string> {
    const album = await this.library.album(id);
    if (album?.cover == null) throw new Refusal('no_cover', 'That album has no painted cover.', 404);
    return this.library.coverPath(album.cover);
  }

  /**
   * File a landed song into a playlist (New Songs) and answer its id; null when
   * that playlist is gone (deleted while the song was made): it stays a take.
   */
  private async fileTake(playlistId: string, takeId: string): Promise<string | null> {
    const take = this.takes.get(takeId);
    let song: Song;
    try {
      song = await this.library.saveTo(playlistId, null, {
        title: take.title,
        model: take.model,
        params: take.params,
        server: take.server,
        jobId: take.jobId,
        createdAt: take.createdAt,
        durationS: take.durationS,
        batch: take.batch,
        audioFrom: this.takes.audioPath(takeId),
        bytes: take.bytes,
        effective: this.takes.effective(takeId),
      });
    } catch (error) {
      if (error instanceof Refusal && error.code === 'playlist_missing') return null;
      throw error;
    }
    await this.takes.remove(takeId, take.client);
    await this.libraryChanged();
    return song.id;
  }

  /**
   * File an audio file dropped on the app (Owen, 2026-10-08) into a playlist,
   * or New Songs when it was not dropped on one. `file` is a copy the caller
   * removes afterwards; the library keeps its own.
   */
  async importSong(
    file: string,
    facts: { readonly name: string; readonly title: string; readonly durationS: number | null; readonly bytes: number },
    playlistId: string | null,
  ): Promise<LibraryView> {
    const target = playlistId ?? (await this.singlesPlaylist());
    await this.library.saveTo(target, null, {
      title: facts.title,
      model: 'imported',
      params: { tags: null, lyrics: null, instrumental: false, cfg: null, seed: null },
      server: { name: 'imported', url: '' },
      jobId: `import-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      durationS: facts.durationS,
      batch: null,
      audioFrom: file,
      bytes: facts.bytes,
      effective: { importedFrom: facts.name },
    });
    return this.libraryChanged();
  }

  /** New Songs' id: the one kept, else a playlist already named so, else a new one. */
  private async singlesPlaylist(): Promise<string> {
    const view = await this.library.list();
    const kept = this.preferences.singlesPlaylist ?? null;
    if (kept !== null && view.playlists.some((playlist) => playlist.id === kept)) return kept;
    const named = view.playlists.find((playlist) => playlist.album == null && playlist.name.trim().toLowerCase() === SINGLES_NAME.toLowerCase());
    const id = named?.id ?? (await this.library.createPlaylist(SINGLES_NAME)).id;
    if (named === undefined) await this.libraryChanged();
    const next: HubPreferences = { ...this.preferences, singlesPlaylist: id };
    await this.options.disk.mkdir(this.options.dataDir);
    await this.options.disk.writeText(this.preferencesFile, `${JSON.stringify(next, null, 2)}\n`);
    this.preferences = next;
    return id;
  }

  /** File a landed album track (plan place `track`) into its album, and send the next. */
  private async fileAlbumTrack(albumId: string, takeId: string, track: number): Promise<void> {
    const take = this.takes.get(takeId);
    // A track made again (Victoria, 2026-10-11) takes its old take's place; any other is added at the end.
    const remake = (await this.library.album(albumId))?.remakes?.find((each) => each.at === track) ?? null;
    let song: Song;
    try {
      song = await this.library.saveTo(albumId, null, {
        title: take.title,
        model: take.model,
        params: take.params,
        server: take.server,
        jobId: take.jobId,
        createdAt: take.createdAt,
        durationS: take.durationS,
        batch: null,
        audioFrom: this.takes.audioPath(takeId),
        bytes: take.bytes,
        effective: this.takes.effective(takeId),
      });
    } catch (error) {
      // The album was deleted while this track was being made: nothing to file it in.
      if (!(error instanceof Refusal && error.code === 'playlist_missing')) throw error;
      await this.takes.remove(takeId, take.client);
      return;
    }
    await this.takes.remove(takeId, take.client);
    const replacedS = remake === null ? null : await this.replaceTake(albumId, remake.song, song);
    await this.albums.landed(albumId, take.durationS, remake === null ? undefined : { at: track, replacedS });
  }

  /**
   * A new take of an album track is in: it goes in the old take's place, under the old take's name
   * (renamed by hand, perhaps), and the old one leaves the album. The old one is kept in New Songs
   * as "<name> (old take)", so a take Victoria liked better is not lost; she deletes it there if
   * not. Answers the old take's length, or null when it was not in the album to replace (deleted
   * meanwhile): then the new one stays where it was filed, at the end.
   */
  private async replaceTake(albumId: string, oldId: string | null, fresh: Song): Promise<number | null> {
    if (oldId === null) return null;
    const old = await this.library.song(oldId).catch(() => null);
    if (old === null) return null;
    const keepIn = await this.singlesPlaylist().catch((err: unknown) => {
      console.error(`[albums] no New Songs to keep the old take of ${old.title} in; it is deleted:`, err);
      return null;
    });
    if (!(await this.library.replaceIn(albumId, oldId, fresh.id, keepIn))) return null;
    if (fresh.title !== old.title) await this.library.rename(fresh.id, old.title);
    if (keepIn !== null) await this.library.rename(oldId, `${old.title} (old take)`).catch(() => undefined);
    return old.durationS;
  }

  /** Paint an album's cover on the server and file it beside the album. */
  private async paintCover(id: string, server: StoredServer, _albumClient: CrucibleClient, model: string, prompt: string): Promise<string> {
    // Under a name of its own, never the albums' (Victoria's laptop, 2026-10-11): Crucible counts a
    // job sent under a session's client name as one of that session's items, so Heroes and Monsters'
    // cover joined Magical Creatures' writing session and was dropped when that session closed.
    const client = clientFor(server, `${clientName()}/cover`);
    // No model named: Crucible paints with the biggest image model the card holds (Owen, 2026-10-11:
    // "if the gpu can fit qwen image then it should use that. if not, it should use dreamshape").
    // 1024 across the board, kept as a 512 JPEG: DreamShaper paints well only near 1024, and until
    // B-Sides can learn which model Crucible will pick, one size serves both ("its simpler").
    const submit = async (): Promise<string> => {
      const jobId = await client.image({ prompt, width: COVER_PAINT_PX, height: COVER_PAINT_PX });
      const now = await this.library.album(id);
      if (now !== null) await this.library.setAlbum(id, { ...now, coverJob: jobId });
      console.log(`[albums] painting the cover for ${id} (the server's pick; ${model} is ready there): job ${jobId}`);
      return jobId;
    };
    // A cover this album was already painting when B-Sides last stopped is waited for, not painted again.
    const kept = (await this.library.album(id))?.coverJob ?? null;
    const alive = kept === null ? null : await client.job(kept).then((job) => (['queued', 'running', 'done'].includes(job.status) ? kept : null), () => null);
    let jobId = alive ?? await submit();
    // The job's status is read every few seconds until it ends. Its event stream was followed
    // instead, and on Victoria's laptop (2026-10-11) the Iliad's cover finished on the server at
    // 16:43:21 while B-Sides waited on, never saving it: the album sat at "planning" with no cover,
    // and each restart painted it again. A cover job is short, so a few seconds' lag costs nothing.
    let until: number | null = null;
    let resent = 0;
    for (;;) {
      const status = await client.job(jobId).catch((error: unknown) => {
        console.error(`[albums] could not read cover job ${jobId}; trying again:`, error);
        return null;
      });
      if (status?.status === 'done') break;
      // Dropped from the line through no fault of its own (a session closing, a server restart):
      // asked for again, as a song would be, rather than the album going without.
      if (status?.status === 'removed' && status.removal !== null && RESEND_COVER_REASONS.includes(status.removal.reason) && resent < 2) {
        resent += 1;
        console.log(`[albums] cover job ${jobId} for ${id} was dropped (${status.removal.reason}); asking again`);
        jobId = await submit();
        continue;
      }
      if (status !== null && status.status !== 'queued' && status.status !== 'running') {
        throw new Refusal('cover_failed', `The server could not paint the cover (${status.status}${status.error ? `: ${status.error.message}` : ''}).`);
      }
      if (status?.status === 'running' && until === null) until = Date.now() + COVER_WAIT_MS;
      if (until !== null && Date.now() > until) {
        // Given up on, it is taken off the server too: left, it painted later for nobody.
        await client.cancel(jobId).catch(() => undefined);
        throw new Refusal('cover_slow', `The cover did not finish within ${COVER_WAIT_MS / 60_000} minutes of starting.`);
      }
      await new Promise((rest) => setTimeout(rest, COVER_POLL_MS));
    }
    // A name of its own each time it is painted: every client's cover URL carries the file name,
    // so a cover painted again (the regenerate button) is never one a browser has cached.
    const file = `${id}-${Date.now().toString(36)}.cover.png`;
    await this.options.fetchAudio(server, jobId, 'image.png', this.library.coverPath(file));
    console.log(`[albums] the cover for ${id} is in: ${file}`);
    if (this.options.shrinkCover !== undefined) {
      const small = await this.options.shrinkCover(this.library.coverPath(file), COVER_KEPT_PX).catch((err: unknown) => {
        console.error(`[albums] could not shrink the cover for ${id}; keeping it as painted:`, err);
        return null;
      });
      if (small !== null) {
        await this.library.removeCover(file);
        return small;
      }
    }
    return file;
  }

  /**
   * Close the queue sessions on `name` that this install's albums opened in an earlier run, open or
   * still waiting in the line. On Victoria's laptop (2026-10-11) one opened 30 s after B-Sides
   * restarted and held her only slot, doing nothing, with two songs and two sessions behind it.
   * Nothing this run opened exists yet when it is called. A server that does not answer is passed by.
   */
  private async closeOrphanSessions(name: string): Promise<void> {
    const owner = `${clientName()}/album`;
    try {
      const client = clientFor(this.registry.get(name), owner);
      // A sleeping server must not hold up every album: 8 s, then it is passed by.
      const [activity, queue] = await Promise.race([
        Promise.all([client.activity(), client.queue()]),
        new Promise<never>((_, fail) => setTimeout(() => fail(new Error('no answer within 8 s')), 8000)),
      ]);
      const orphans = [
        ...(activity.session !== null && activity.session.client === owner ? [activity.session.sessionId] : []),
        ...queue.items.filter((item) => item.kind === 'session' && item.client === owner).map((item) => item.jobId),
      ];
      for (const id of new Set(orphans)) {
        console.log(`[albums] closing ${id} on ${name}: an album session left from an earlier run`);
        await client.closeSession(id).catch((err: unknown) => console.error(`[albums] could not close ${id} on ${name}:`, err));
      }
    } catch (err) {
      console.error(`[albums] could not look for leftover sessions on ${name}:`, err);
    }
  }

  /** Close the album writing sessions open now (the app is quitting). */
  async closeSessions(): Promise<void> {
    await this.albums.closeSessions();
  }

  async openLibrary(dir: string): Promise<void> {
    this.library = new Library(this.options.disk, dir);
    await this.library.adoptLoose();
  }

  /** The audio file of a take in the playing list. */
  takeAudio(id: string): string {
    return this.takes.audioPath(id);
  }

  /** An album's files for a download: its songs in order (each with its lyrics), its cover, and its words. */
  async albumFiles(id: string): Promise<AlbumFiles> {
    const view = await this.library.list();
    const playlist = view.playlists.find((p) => p.id === id);
    if (playlist === undefined) throw new Refusal('album_missing', 'That album is gone.', 404);
    const songs = new Map(view.songs.map((song) => [song.id, song]));
    const tracks = playlist.songs.flatMap((songId) => {
      const song = songs.get(songId);
      return song === undefined ? [] : [{
        title: song.title,
        file: this.library.audioPath(song.file),
        lyrics: song.params.instrumental ? null : song.params.lyrics || null,
      }];
    });
    if (tracks.length === 0) throw new Refusal('album_empty', 'That album has no songs to download yet.', 409);
    const album = playlist.album ?? null;
    return {
      name: playlist.name,
      artist: album?.artist ?? '',
      blurb: album?.blurb ?? '',
      cover: album?.cover != null ? this.library.coverPath(album.cover) : null,
      tracks,
    };
  }

  /** The audio file of a saved song, and its title. */
  async songFile(id: string): Promise<{ title: string; file: string }> {
    const song = await this.library.song(id);
    return { title: song.title, file: this.library.audioPath(song.file) };
  }

  /** Each server's song page as last read, for what its YuE2 takes when an album's track is sent. */
  private readonly pages = new Map<string, SongPage>();

  private async songPageOf(server: StoredServer): Promise<SongPage> {
    const page = await songPage(server);
    this.pages.set(server.name, page);
    return page;
  }

  /** The albums making their music on `server`, in the order they send tracks. */
  private async makingOn(server: string): Promise<string[]> {
    return making((await this.library.list()).playlists, server, this.preferences.albumOrder ?? 'one').map((playlist) => playlist.id);
  }

  /**
   * A single song left `server`'s line (fetched, failed or cancelled): with single songs going
   * next, the albums held back for it carry on.
   */
  private singleLeft(server: string): void {
    if (this.preferences.singles !== 'next') return;
    void this.albums.next(server).then(() => this.libraryChanged()).catch((err: unknown) => console.error(`[albums] could not carry on on ${server}:`, err));
  }

  /** Every server with an album making its music: a Settings change to the line takes effect now. */
  private async refill(): Promise<void> {
    const servers = new Set((await this.library.list()).playlists.flatMap((p) => (p.album?.stage === 'making' ? [p.album.server] : [])));
    for (const server of servers) await this.albums.next(server).catch((err: unknown) => console.error(`[albums] could not carry on on ${server}:`, err));
    if (servers.size > 0) await this.libraryChanged();
  }

  /** The library, each album being made saying whether anything is being done for it right now. */
  /**
   * The words names already lean on and a spark (fresh-names.ts; Owen, 2026-10-11: metal names all
   * crowns, ash and cathedrals, soul all velvet): from the library's 80 newest songs and its albums.
   */
  private async freshNames(): Promise<string> {
    try {
      const view = await this.libraryView();
      const songs = [...view.songs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 80).map((song) => song.title);
      return freshLine([...songs, ...view.playlists.map((playlist) => playlist.name)]);
    } catch (err) {
      console.error('[hub] could not read the library for fresh names:', err);
      return freshLine([]);
    }
  }

  async libraryView(): Promise<LibraryView> {
    const view = await this.library.list();
    return {
      ...view,
      playlists: view.playlists.map((playlist) => {
        const album = playlist.album;
        if (album == null || !['planning', 'cover', 'making'].includes(album.stage)) return playlist;
        // Waiting its turn behind another album on its server: being handled, not interrupted.
        // Taking turns, no album waits for another: each is making its music, a track at a time.
        const turns = this.preferences.albumOrder === 'turns';
        const line = album.stage === 'making' ? making(view.playlists, album.server, turns ? 'turns' : 'one') : [];
        const ahead = !turns && line[0] !== undefined && line[0].id !== playlist.id ? line[0] : null;
        const takingTurns = turns && line.length > 1;
        const working = ahead !== null
          || takingTurns
          // Held back while a single song goes next: also waiting its turn.
          || (album.stage === 'making' && this.preferences.singles === 'next' && this.jobs.singlesWaiting(album.server) > 0)
          || this.albums.writing(playlist.id)
          || this.jobs.list(albumClient(playlist.id)).some((job) => !ENDED_PHASES.includes(job.phase));
        return { ...playlist, album: { ...album, working, waitingFor: ahead?.name ?? null, takingTurns } };
      }),
    };
  }

  async libraryChanged(): Promise<LibraryView> {
    const library = await this.libraryView();
    this.sink.broadcast({ type: 'library', library });
    return library;
  }

  /**
   * Tell every client the server list changed. The server routes call it with
   * the list they wrote; the desktop-only Crucible setup (electron/ipc.ts:
   * install, start, use, uninstall) changes the registry outside them and calls
   * it with nothing, so the list is read as stored.
   */
  serversChanged(servers: ServerView[] = this.registry.views()): ServerView[] {
    this.sink.broadcast({ type: 'servers', servers });
    this.askNeeds();
    return servers;
  }

  /**
   * Ask the server in use for what B-Sides needs beyond YuE2, once per server per run: on a
   * start, and whenever a server is set up or switched to (Owen, 2026-10-11; server-needs.ts).
   * In the background; nothing waits on it.
   */
  private askNeeds(): void {
    let server;
    try {
      server = this.registry.active();
    } catch {
      return;
    }
    void this.needs.ensure(server.name, clientFor(server));
  }

  async snapshot(client: CoreClient): Promise<HubSnapshot> {
    return {
      hub: this.options.info,
      servers: this.registry.views(),
      jobs: this.jobs.list(client.id),
      takes: this.takes.list(client.id),
      library: await this.libraryView(),
      albumJobs: this.jobs.albumJobs(),
    };
  }

  /**
   * Claude, for what the person chose it to write in B-Sides' model's place: the text calls, the
   * lyrics, or both (each null where B-Sides' model writes); null when it writes nothing.
   */
  private claude(): { readonly text: TextModel | null; readonly words: TextModel | null; readonly lyricist: Lyricist | null } | null {
    const { writer, lyricist } = this.preferences;
    if (writer !== 'claude' && lyricist !== 'claude') return null;
    if (this.options.claude === undefined) {
      throw new Refusal('claude_unavailable', 'Claude writes only on a B-Sides computer, through its Claude Code.');
    }
    return {
      // The sound: the tags and the cover description.
      text: writer === 'claude' ? this.options.claude.text : null,
      // The words: names, the liner note, track ideas (its text calls) and the lyrics (its lyricist).
      words: lyricist === 'claude' ? this.options.claude.text : null,
      lyricist: lyricist === 'claude' ? this.options.claude.lyricist : null,
    };
  }

  // ── preferences ─────────────────────────────────────────────────────────────

  private get preferencesFile(): string {
    return join(this.options.dataDir, 'preferences.json');
  }

  /** A file that will not read is said so and left alone; the defaults stand until a change rewrites it. */
  private async readPreferences(): Promise<void> {
    const text = await this.options.disk.readText(this.preferencesFile);
    if (text === null) return;
    try {
      const stored = JSON.parse(text) as Partial<HubPreferences>;
      const split = stored.textSplit === 2;
      // Before 0.1.38 `writer` wrote names as well as tags. Owen, 2026-10-11: the server's model
      // writes the sound and Claude the words; so on moving over, that is what each hub starts with.
      const writer = !split
        ? this.preferences.writer
        : WRITERS.includes(stored.writer as never) ? (stored.writer as Writer) : this.preferences.writer;
      this.preferences = {
        songFormat: SONG_FORMATS.includes(stored.songFormat as never) ? (stored.songFormat as HubPreferences['songFormat']) : DEFAULT_PREFERENCES.songFormat,
        albumSpaceGb: ALBUM_SPACE_GB.includes(stored.albumSpaceGb as never) ? (stored.albumSpaceGb as number) : DEFAULT_PREFERENCES.albumSpaceGb,
        singlesPlaylist: typeof stored.singlesPlaylist === 'string' ? stored.singlesPlaylist : null,
        // 0.1.10 stored the same choice as `lyricsWriter` (lyrics only); it carries over.
        writer,
        lyricist: !split || !WRITERS.includes(stored.lyricist as never) ? this.preferences.lyricist : (stored.lyricist as Writer),
        textSplit: 2,
        albumOrder: ALBUM_ORDERS.includes(stored.albumOrder as never) ? (stored.albumOrder as AlbumOrder) : DEFAULT_PREFERENCES.albumOrder,
        singles: SINGLES_ORDERS.includes(stored.singles as never) ? (stored.singles as SinglesOrder) : DEFAULT_PREFERENCES.singles,
      };
    } catch (err) {
      console.error(`[hub] ${this.preferencesFile} could not be read; using the defaults:`, err);
    }
  }

  private async setPreferences(change: Record<string, unknown>): Promise<HubPreferences> {
    const format = change['songFormat'];
    if (format !== undefined && !SONG_FORMATS.includes(format as never)) {
      throw new Refusal('body_invalid', `songFormat is one of ${SONG_FORMATS.join(', ')}.`);
    }
    const space = change['albumSpaceGb'];
    if (space !== undefined && !ALBUM_SPACE_GB.includes(space as never)) {
      throw new Refusal('body_invalid', `albumSpaceGb is one of ${ALBUM_SPACE_GB.join(', ')}.`);
    }
    const writer = change['writer'];
    if (writer !== undefined && !WRITERS.includes(writer as never)) {
      throw new Refusal('body_invalid', `writer is one of ${WRITERS.join(', ')}.`);
    }
    const lyricist = change['lyricist'];
    if (lyricist !== undefined && !WRITERS.includes(lyricist as never)) {
      throw new Refusal('body_invalid', `lyricist is one of ${WRITERS.join(', ')}.`);
    }
    const albumOrder = change['albumOrder'];
    if (albumOrder !== undefined && !ALBUM_ORDERS.includes(albumOrder as never)) {
      throw new Refusal('body_invalid', `albumOrder is one of ${ALBUM_ORDERS.join(', ')}.`);
    }
    const singles = change['singles'];
    if (singles !== undefined && !SINGLES_ORDERS.includes(singles as never)) {
      throw new Refusal('body_invalid', `singles is one of ${SINGLES_ORDERS.join(', ')}.`);
    }
    const toClaude = (writer === 'claude' && this.preferences.writer !== 'claude') || (lyricist === 'claude' && this.preferences.lyricist !== 'claude');
    if (toClaude && this.options.claude === undefined) {
      throw new Refusal('claude_unavailable', 'Claude writes only on a B-Sides computer, through its Claude Code.');
    }
    // Switched on: say now if Claude Code is missing or signed out, not on the first song.
    if (toClaude) await this.options.claude?.check();
    const next: HubPreferences = {
      ...this.preferences,
      ...(format === undefined ? {} : { songFormat: format as HubPreferences['songFormat'] }),
      ...(space === undefined ? {} : { albumSpaceGb: space as number }),
      ...(writer === undefined ? {} : { writer: writer as Writer }),
      ...(lyricist === undefined ? {} : { lyricist: lyricist as Writer }),
      ...(albumOrder === undefined ? {} : { albumOrder: albumOrder as AlbumOrder }),
      ...(singles === undefined ? {} : { singles: singles as SinglesOrder }),
    };
    await this.options.disk.mkdir(this.options.dataDir);
    await this.options.disk.writeText(this.preferencesFile, `${JSON.stringify(next, null, 2)}\n`);
    const reorder = next.albumOrder !== this.preferences.albumOrder || next.singles !== this.preferences.singles;
    this.preferences = next;
    // The line's new order takes effect now: the album whose turn it is sends, the pages say so.
    if (reorder) await this.refill();
    return next;
  }

  // ── routes ──────────────────────────────────────────────────────────────────

  private route(method: string, template: string, handler: CoreHandler): void {
    this.routes.push(routeOf(method, template, handler));
  }

  private defineRoutes(): void {
    // ── this hub's own choices ──────────────────────────────────────────────
    this.route('GET', '/api/preferences', () => this.preferences);
    this.route('PUT', '/api/preferences', async (request) => this.setPreferences(await request.body()));

    // ── Crucible servers (tokens go in, never come out) ─────────────────────
    this.route('GET', '/api/servers', () => this.registry.views());
    // What the server in use was asked for beyond YuE2, and where that got to (server-needs.ts).
    this.route('GET', '/api/server-needs', () => {
      const active = this.registry.views().find((server) => server.active);
      return active === undefined ? null : this.needs.of(active.name);
    });
    this.route('POST', '/api/servers/pairing', async (request) =>
      this.serversChanged(await this.registry.addPairing(text((await request.body())['line'], 'line'))));
    // By address alone: begin, then poll at `pollAfterMs` until it is not pending.
    this.route('POST', '/api/servers/pair', async (request) => this.pairing.begin(text((await request.body())['address'], 'address')));
    this.route('POST', '/api/servers/pair/:id', (request) => this.pairing.poll(request.params['id'] as string));
    this.route('DELETE', '/api/servers/pair/:id', (request) => {
      this.pairing.cancel(request.params['id'] as string);
      return null;
    });
    this.route('POST', '/api/servers', async (request) =>
      this.serversChanged(await this.registry.add((await request.body()) as unknown as ServerInput)));
    this.route('PUT', '/api/servers/:name', async (request) =>
      this.serversChanged(await this.registry.update(request.params['name'] as string, (await request.body()) as unknown as ServerInput)));
    this.route('DELETE', '/api/servers/:name', async (request) =>
      this.serversChanged(await this.registry.remove(request.params['name'] as string)));
    this.route('POST', '/api/servers/:name/activate', async (request) =>
      this.serversChanged(await this.registry.setActive(request.params['name'] as string)));
    this.route('POST', '/api/servers/:name/test', (request) => probe(this.registry.get(request.params['name'] as string)));

    // ── the song page (the active server's) and presets (the app's own) ─────
    this.route('GET', '/api/song-page', async () => {
      const page = await songPage(this.registry.active());
      return {
        ...page,
        ...(this.preferences.writer === 'claude' ? { writer: 'Claude Sonnet 5.5' } : {}),
        ...(this.preferences.lyricist === 'claude' ? { lyricist: 'Claude Sonnet 5.5' } : {}),
      };
    });
    this.route('GET', '/api/presets', () => this.presets.list(this.registry.all()));
    this.route('POST', '/api/describe', async (request) => {
      const server = this.registry.active();
      const body = await request.body();
      const brief = lyricsBrief(body['lyrics']);
      const page = await songPage(server);
      const claude = this.claude();
      const about = text(body['text'], 'text');
      const instrumental = body['instrumental'] === true;
      const serverText = async (): Promise<TextModel> => {
        if (page.tagModel === null) throw new Refusal('no_tag_model', page.tagModelReason ?? 'This server has no tag model.');
        // A chat never installs a model: a server without the tag model starts installing it here,
        // and the person is told so (the Studio says to describe again once it is done).
        const client = clientFor(server);
        const installing = await startInstall(client, page.tagModel);
        if (installing !== null) throw new Refusal('describe_installing', `The tag model is being set up on the server first: ${installing.message}`, 409);
        return crucibleText(client, page.tagModel);
      };
      const sound = claude?.text ?? await serverText();
      const lyricist = claude?.lyricist ?? null;
      // The person's own name (Victoria, 2026-10-11): kept, and the words written to it.
      const named = givenName(body['title']);
      // No Claude for the words (a phone): the server's model writes the tags and the words in one call.
      if (lyricist === null || claude?.words == null) {
        const described = await describe(sound, page, about, instrumental, brief);
        return named === null ? described : { ...described, title: named };
      }
      // The sound from the tag model, then the words and the name from the lyricist (Owen, 2026-10-11:
      // whoever writes the lyrics names the song, so the name fits its hook).
      const described: DescribeResult = await describeSound(sound, page, about, instrumental, brief);
      if (described.instrumental) {
        return { ...described, title: named ?? await nameSong(claude.words, about, described.tags, '', await this.freshNames()), lyricsModel: claude.words.name };
      }
      const song = {
        title: named, tags: described.tags.join(', '), about, brief,
        ...(body['preChorus'] === true ? { preChorus: true } : {}),
        ...(body['phonetic'] === true ? { phonetic: true } : {}),
        ...(named === null ? { fresh: await this.freshNames() } : {}),
      };
      const written = named === null && lyricist.writeTitled !== undefined
        ? await lyricist.writeTitled(song)
        : { lyrics: await lyricist.write(song), title: named };
      return { ...described, lyrics: layLyrics(written.lyrics), title: written.title, lyricsModel: lyricist.name };
    });
    this.route('PUT', '/api/presets/:name', async (request) => {
      const name = (request.params['name'] as string).trim();
      if (name === '') throw new Refusal('preset_name', 'Name the preset first.');
      return this.presets.save(this.registry.all(), name, (await request.body()) as unknown as SongForm);
    });
    this.route('DELETE', '/api/presets/:name', (request) =>
      this.presets.remove(this.registry.all(), request.params['name'] as string));

    // ── albums ────────────────────────────────────────────────────────────────
    this.route('POST', '/api/albums', async (request) => {
      const body = await request.body();
      const minutes = body['minutes'];
      const tags = body['tags'];
      if (typeof minutes !== 'number' || !ALBUM_MINUTES.includes(minutes)) {
        throw new Refusal('body_invalid', `minutes is one of ${ALBUM_MINUTES.join(', ')}.`);
      }
      if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) throw new Refusal('body_invalid', 'tags must be a list of text.');
      const cfg = typeof body['cfg'] === 'number' && Number.isFinite(body['cfg']) ? body['cfg'] : null;
      const sung = body['sung'] === true;
      const lyrics = sung ? lyricsBrief(body['lyrics']) : '';
      const title = givenName(body['title']);
      const ask: AlbumAsk = {
        description: albumDescription(body['description']), tags: tags as string[], minutes, sung, cfg,
        ...(title !== null ? { title } : {}),
        ...(sung && body['preChorus'] === true ? { preChorus: true } : {}),
        ...(sung && body['phonetic'] === true ? { phonetic: true } : {}),
        ...(lyrics ? { lyrics } : {}), ...(body['exactTags'] === true ? { exactTags: true } : {}),
        // Make's Lead (Owen, 2026-10-11): every track's; blank, each track picks its own.
        ...(typeof body['lead'] === 'string' && body['lead'].trim() !== '' ? { lead: body['lead'].replace(/\s+/g, ' ').trim().slice(0, 80) } : {}),
        ...(LENGTH_AIMS.some((aim) => aim.key === body['trackLength']) ? { trackLength: body['trackLength'] as string } : {}),
      };
      if (ask.description.trim() === '' && ask.tags.length === 0) {
        throw new Refusal('album_ask_empty', 'Describe the album, or pick some tags, first.');
      }
      if (this.options.limitsAlbumSpace === true) {
        const view = await this.libraryView();
        const used = view.playlists
          .filter((playlist) => playlist.album !== undefined && playlist.album.cloud == null)
          .reduce((sum, playlist) => sum + albumBytes(playlist, view.songs), 0);
        const limit = this.preferences.albumSpaceGb * 1e9;
        if (used >= limit * 0.95) {
          throw new Refusal('album_space_full', `Albums on this phone take ${(used / 1e9).toFixed(1)} of ${this.preferences.albumSpaceGb} GB. Save some to your cloud or delete one, then make the next.`);
        }
      }
      // Its own server when the person picked one (another computer's Crucible, so two albums are
      // made at once, one on each; Victoria, 2026-10-10), else the active one.
      const server = typeof body['server'] === 'string' && body['server'] !== '' ? this.registry.get(body['server']) : this.registry.active();
      // Make → Album's "Add to folder" (Victoria, 2026-10-11): it lands in the folder from the start.
      const album = await this.library.createAlbum(title ?? 'A new album', {
        artist: '', blurb: '', cover: null, ask, plan: null, stage: 'planning', sent: 0, madeS: 0, refusal: null,
        server: server.name, writer: null,
      }, idOrNull(body['folder'], 'folder'));
      this.albums.start(album.id);
      await this.libraryChanged();
      return { id: album.id };
    });
    // The person's own cover (Owen, 2026-10-10: "we should be able to upload our own images though ...
    // drag/drop or ctrl+v"): {image: base64, type}, made small by the page first (COVER_UPLOAD_MAX).
    this.route('PUT', '/api/albums/:id/cover', async (request) => {
      const id = request.params['id'] as string;
      const body = await request.body();
      const extension = COVER_TYPES[typeof body['type'] === 'string' ? body['type'] : ''];
      if (extension === undefined || typeof body['image'] !== 'string') {
        throw new Refusal('body_invalid', 'A cover is {image: base64, type: image/png, image/jpeg or image/webp}.');
      }
      const write = this.options.disk.writeBytes;
      if (write === undefined) throw new Refusal('cover_upload_unavailable', 'Setting your own cover is not on this device yet; set it on a B-Sides computer.', 501);
      const album = await this.library.album(id);
      if (album === null) throw new Refusal('album_missing', 'That album is gone.', 404);
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(body['image']), (char) => char.charCodeAt(0));
      } catch {
        throw new Refusal('body_invalid', 'The cover image is not base64.');
      }
      if (bytes.length === 0 || bytes.length > COVER_UPLOAD_MAX) throw new Refusal('cover_too_large', 'That image is too large for a cover.', 413);
      const file = `${id}-${Date.now().toString(36)}.cover.${extension}`;
      await write.call(this.options.disk, this.library.coverPath(file), bytes);
      const now = (await this.library.album(id)) ?? album;
      await this.library.setAlbum(id, { ...now, cover: file, coverState: null });
      if (now.cover !== null && now.cover !== file) await this.library.removeCover(now.cover);
      return this.libraryChanged();
    });
    this.route('POST', '/api/albums/:id/extend', async (request) => {
      await this.albums.extend(request.params['id'] as string);
      return this.libraryChanged();
    });
    this.route('POST', '/api/albums/:id/resume', async (request) => {
      await this.albums.resume(request.params['id'] as string);
      return this.libraryChanged();
    });
    // Make this next (Victoria, 2026-10-11): the album goes ahead of the others on its server.
    this.route('POST', '/api/albums/:id/next', async (request) => {
      await this.albums.makeNext(request.params['id'] as string);
      return this.libraryChanged();
    });
    this.route('POST', '/api/albums/:id/stop', async (request) => {
      await this.albums.stop(request.params['id'] as string);
      return this.libraryChanged();
    });
    // One piece written again by B-Sides' model: {piece: title | artist | cover | track, track?: its plan place}.
    this.route('POST', '/api/albums/:id/regenerate', async (request) => {
      const body = await request.body();
      const piece = body['piece'];
      if (piece !== 'title' && piece !== 'artist' && piece !== 'cover' && piece !== 'track') {
        throw new Refusal('body_invalid', 'piece is one of title, artist, cover, track.');
      }
      const track = body['track'];
      if (piece === 'track' && (typeof track !== 'number' || !Number.isInteger(track) || track < 0)) {
        throw new Refusal('body_invalid', 'track is the plan place of the track to name again.');
      }
      await this.albums.regenerate(request.params['id'] as string, piece, piece === 'track' ? (track as number) : undefined);
      return this.libraryChanged();
    });

    // Make one made track again (Victoria, 2026-10-11): {lyrics: keep | new}. `at` is its plan place.
    this.route('POST', '/api/albums/:id/tracks/:at/remake', async (request) => {
      const id = request.params['id'] as string;
      const at = Number(request.params['at']);
      if (!Number.isInteger(at) || at < 0) throw new Refusal('body_invalid', 'The track is its place in the album, from 0.');
      const lyrics = (await request.body())['lyrics'];
      if (lyrics !== 'keep' && lyrics !== 'new') throw new Refusal('body_invalid', 'lyrics is keep or new.');
      // Its take now: the album's song with its plan track's name, as the album finds its songs.
      const view = await this.library.list();
      const playlist = view.playlists.find((p) => p.id === id);
      const title = playlist?.album?.plan?.tracks[at]?.title.toLowerCase();
      const songs = new Map(view.songs.map((song) => [song.id, song]));
      const song = title === undefined ? undefined
        : playlist?.songs.map((songId) => songs.get(songId)).find((each) => each?.title.toLowerCase() === title);
      await this.albums.remake(id, at, {
        fresh: lyrics === 'new',
        song: song?.id ?? null,
        // Same words: as they stand on the old take, so a chorus corrected by hand is sung corrected.
        keep: song !== undefined && !song.params.instrumental ? song.params.lyrics : null,
      });
      return this.libraryChanged();
    });

    // ── jobs ──────────────────────────────────────────────────────────────────
    this.route('POST', '/api/jobs', async (request) => {
      const client = request.client();
      const body = (await request.body()) as unknown as GenerateRequest;
      if (typeof body.params !== 'object' || body.params === null || typeof body.count !== 'number') {
        throw new Refusal('body_invalid', 'A generate request is {params, count}.');
      }
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, SONG_TITLE_MAX) : '';
      const { title: _given, ...rest } = body;
      const server = this.registry.active();
      const made = this.jobs.generate(server, client, title === '' ? rest : { ...rest, title }, this.preferences.songFormat, null, await this.singlesPlaylist());
      // Not named (a preset and Make, no Describe): Claude names it while it renders, so it never
      // lands as a list of its tags (Owen, 2026-10-11). Without Claude (a phone) the server's model
      // is not asked: it would take the card from the song. A name that is late or fails leaves the default.
      const words = this.preferences.lyricist === 'claude' ? this.options.claude?.text ?? null : null;
      if (title === '' && words !== null) {
        const params = rest.params;
        const tags = typeof params.tags === 'string' ? params.tags.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '') : [];
        void this.freshNames()
          .then((fresh) => nameSong(words, '', tags, params.instrumental === true ? '' : (params.lyrics ?? ''), fresh))
          .then((named) => { if (named !== null) this.jobs.retitle(made.map((job) => job.key), named); })
          .catch((err: unknown) => console.error('[jobs] could not name a song made without one:', err));
      }
      return made;
    });
    this.route('POST', '/api/jobs/:key/cancel', async (request) => {
      this.ownJob(request);
      return this.jobs.cancel(request.params['key'] as string);
    });
    this.route('DELETE', '/api/jobs/:key', (request) => {
      this.ownJob(request);
      this.jobs.dismiss(request.params['key'] as string);
      return null;
    });

    // ── takes: the playing list ─────────────────────────────────────────────
    this.route('DELETE', '/api/takes/:id', async (request) => {
      await this.takes.remove(request.params['id'] as string, request.client().id);
      return null;
    });

    // ── the library: saved songs and playlists ──────────────────────────────
    this.route('GET', '/api/library', () => this.libraryView());
    // What the active server says it is doing: its activity and its line, as the SDK reads them
    // (for working out a stall, 2026-10-11: a model loaded and nothing running).
    this.route('GET', '/api/server-activity', async () => {
      const client = clientFor(this.registry.active());
      const [activity, queue] = await Promise.all([client.activity(), client.queue()]);
      return { activity, queue };
    });
    // How much voice a song holds (voice-check.ts; Owen, 2026-10-11): a 44.1 kHz WAV by its bare name
    // in the library folder, separated on the active server; its vocal stem is kept beside it.
    this.route('POST', '/api/voice-check', async (request) => {
      const name = (await request.body())['file'];
      if (typeof name !== 'string' || !/^[\w.-]+\.wav$/i.test(name) || name.includes('..')) {
        throw new Refusal('body_invalid', 'A voice check is {file}: a .wav in the library folder, by its name.');
      }
      const dir = (await this.libraryView()).dir;
      const wav = await this.options.disk.readBytes?.(join(dir, name));
      if (wav == null) throw new Refusal('not_found', `There is no ${name} in the library folder.`);
      const checked = await voiceCheck(clientFor(this.registry.active()), wav, name);
      await this.options.disk.writeBytes?.(join(dir, name.replace(/\.wav$/i, '.vocals.wav')), checked.stem);
      const { stem: _stem, ...levels } = checked;
      return levels;
    });
    // Who this hub is (its computer's name), for another B-Sides listing its library.
    this.route('GET', '/api/info', () => this.options.info);
    this.route('PATCH', '/api/songs/:id', async (request) => {
      const id = request.params['id'] as string;
      const body = await request.body();
      if (body['title'] === undefined && body['lyrics'] === undefined) throw new Refusal('body_invalid', 'A song change is {title} and/or {lyrics}.');
      if (body['title'] !== undefined) await this.library.rename(id, text(body['title'], 'title'));
      if (body['lyrics'] !== undefined) {
        if (typeof body['lyrics'] !== 'string') throw new Refusal('body_invalid', 'lyrics must be text.');
        await this.library.setLyrics(id, body['lyrics']);
      }
      return this.libraryChanged();
    });
    this.route('POST', '/api/playlists', async (request) => {
      await this.library.createPlaylist(text((await request.body())['name'], 'name'));
      return this.libraryChanged();
    });
    this.route('PATCH', '/api/playlists/:id', async (request) => {
      const id = request.params['id'] as string;
      const body = await request.body();
      if (body['name'] !== undefined) await this.library.renamePlaylist(id, text(body['name'], 'name'));
      if (body['songs'] !== undefined) {
        const songs = body['songs'];
        if (!Array.isArray(songs) || !songs.every((song) => typeof song === 'string')) {
          throw new Refusal('body_invalid', 'songs must be a list of song ids.');
        }
        await this.library.reorder(id, songs as string[]);
      }
      // Filed in a folder (null: the top of the library), before the playlist `before` there or last.
      if (body['folder'] !== undefined) await this.library.movePlaylist(id, idOrNull(body['folder'], 'folder'), idOrNull(body['before'], 'before'));
      return this.libraryChanged();
    });
    this.route('DELETE', '/api/playlists/:id', async (request) => {
      const id = request.params['id'] as string;
      // An album still being made: stop it first, so its tracks are not made for nothing.
      const album = await this.library.album(id);
      if (album !== null && (album.stage === 'planning' || album.stage === 'cover' || album.stage === 'making')) await this.albums.stop(id);
      await this.library.deletePlaylist(id);
      // The next album in line on its server makes its music now.
      if (album !== null) await this.albums.next(album.server);
      return this.libraryChanged();
    });
    // ── folders: albums and playlists grouped, in the library view (Victoria, 2026-10-11) ──
    this.route('POST', '/api/folders', async (request) => {
      const body = await request.body();
      await this.library.createFolder(text(body['name'], 'name'), idOrNull(body['parent'], 'parent'));
      return this.libraryChanged();
    });
    // {name} renames; {parent, before?} moves it (parent null: the top), before the folder `before` there or last.
    this.route('PATCH', '/api/folders/:id', async (request) => {
      const id = request.params['id'] as string;
      const body = await request.body();
      if (body['name'] === undefined && body['parent'] === undefined) throw new Refusal('body_invalid', 'A folder change is {name} and/or {parent, before}.');
      if (body['name'] !== undefined) await this.library.renameFolder(id, text(body['name'], 'name'));
      if (body['parent'] !== undefined) await this.library.moveFolder(id, idOrNull(body['parent'], 'parent'), idOrNull(body['before'], 'before'));
      return this.libraryChanged();
    });
    // What was in it moves up a level: nothing in a folder is deleted with it.
    this.route('DELETE', '/api/folders/:id', async (request) => {
      await this.library.deleteFolder(request.params['id'] as string);
      return this.libraryChanged();
    });
    this.route('POST', '/api/playlists/:id/songs', async (request) => {
      const playlist = request.params['id'] as string;
      const body = await request.body();
      if (typeof body['songId'] === 'string') {
        await this.library.addTo(playlist, body['songId']);
        return this.libraryChanged();
      }
      const takeId = text(body['takeId'], 'takeId');
      const take = this.takes.get(takeId);
      const song = await this.library.saveTo(playlist, take.savedAs, {
        title: take.title,
        model: take.model,
        params: take.params,
        server: take.server,
        jobId: take.jobId,
        createdAt: take.createdAt,
        durationS: take.durationS,
        batch: take.batch,
        audioFrom: this.takes.audioPath(takeId),
        bytes: take.bytes,
        effective: this.takes.effective(takeId),
      });
      if (take.savedAs !== song.id) {
        const marked = await this.takes.markSaved(takeId, song.id);
        this.sink.send(marked.client, { type: 'take', take: marked });
      }
      return this.libraryChanged();
    });
    this.route('DELETE', '/api/playlists/:id/songs/:song', async (request) => {
      await this.library.removeFrom(request.params['id'] as string, request.params['song'] as string);
      return this.libraryChanged();
    });
  }

  /** A job is cancelled or dismissed only by the device that asked for it. */
  private ownJob(request: CoreRequest): void {
    const owner = this.jobs.owner(request.params['key'] as string);
    if (owner !== null && owner !== request.client().id) {
      throw new Refusal('job_not_yours', 'That song is being made for another device.', 403);
    }
  }
}
