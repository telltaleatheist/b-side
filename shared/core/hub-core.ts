/**
 * hub-core — what a B-Side hub IS, wherever it runs: the desktop's HTTP hub
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
import { clientFor, deletePreset, listPresets, probe, savePreset, songPage } from './crucible';
import { describe } from './describe';
import { join, type Disk } from './disk';
import { JobRunner, type AudioFetcher } from './jobs';
import { Library } from './library';
import { PairingSessions } from './pairing';
import { Refusal } from './refusal';
import { ServerRegistry, type Vault } from './servers';
import { TakeStore, type TakeLimits } from './takes';
import { defaultTitle } from './titles';
import {
  SONG_FORMATS,
  SONG_MODEL,
  type ClientKind,
  type HubPreferences,
  type GenerateRequest,
  type HubEvent,
  type HubInfo,
  type HubSnapshot,
  type LibraryView,
  type ServerInput,
  type ServerView,
  type SongForm,
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
}

/** MP3 unless the person chose lossless: about an eighth the size, the same sound on a phone. */
const DEFAULT_PREFERENCES: HubPreferences = { songFormat: 'mp3' };

export function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Refusal('body_invalid', `${what} must be text.`);
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

export class HubCore {
  readonly registry: ServerRegistry;
  readonly takes: TakeStore;
  readonly jobs: JobRunner;
  readonly routes: CoreRoute[] = [];
  private readonly pairing: PairingSessions;
  private library!: Library;
  private readonly sink: EventSink;
  private preferences: HubPreferences = DEFAULT_PREFERENCES;

  constructor(private readonly options: HubCoreOptions) {
    this.sink = options.sink;
    this.registry = new ServerRegistry(options.vault);
    this.pairing = new PairingSessions(options.clientName, async (pairing) => {
      const name = await this.registry.addPaired(pairing);
      this.serversChanged();
      return name;
    });
    this.takes = new TakeStore(options.disk, join(options.dataDir, 'takes'), options.takeLimits);
    this.takes.onGone((take, reason) => this.sink.send(take.client, { type: 'take-gone', id: take.id, reason }));
    this.jobs = new JobRunner(
      {
        publish: (job) => this.sink.send(job.client, { type: 'job', job }),
        server: (name) => this.registry.get(name),
        land: async (landed) => {
          if (this.sink.isClosed(landed.job.client)) {
            throw new Refusal('client_closed', 'The browser tab that asked for this song has closed; nobody is left to play it.');
          }
          const params = landed.job.params;
          const take = await this.takes.add({
            client: landed.job.client,
            kind: landed.job.clientKind,
            title: defaultTitle(params),
            extension: landed.extension,
            fill: landed.fill,
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
            createdAt: new Date().toISOString(),
          });
          this.sink.send(take.client, { type: 'take', take });
          return take;
        },
      },
      options.disk,
      join(options.dataDir, 'pending.json'),
      options.fetchAudio,
    );
    this.defineRoutes();
  }

  /** Read what is stored: the server list, the take cache, the library in `libraryDir`. */
  async open(libraryDir: string): Promise<void> {
    await this.readPreferences();
    await this.registry.open();
    await this.takes.open();
    await this.openLibrary(libraryDir);
  }

  /** Follow again the jobs that were generating when this hub last stopped. */
  async resume(): Promise<void> {
    await this.jobs.resume();
  }

  async openLibrary(dir: string): Promise<void> {
    this.library = new Library(this.options.disk, dir);
    await this.library.adoptLoose();
  }

  /** The audio file of a take in the playing list. */
  takeAudio(id: string): string {
    return this.takes.audioPath(id);
  }

  /** The audio file of a saved song, and its title. */
  async songFile(id: string): Promise<{ title: string; file: string }> {
    const song = await this.library.song(id);
    return { title: song.title, file: this.library.audioPath(song.file) };
  }

  libraryView(): Promise<LibraryView> {
    return this.library.list();
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
    return servers;
  }

  async snapshot(client: CoreClient): Promise<HubSnapshot> {
    return {
      hub: this.options.info,
      servers: this.registry.views(),
      jobs: this.jobs.list(client.id),
      takes: this.takes.list(client.id),
      library: await this.libraryView(),
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
      this.preferences = {
        songFormat: SONG_FORMATS.includes(stored.songFormat as never) ? (stored.songFormat as HubPreferences['songFormat']) : DEFAULT_PREFERENCES.songFormat,
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
    const next: HubPreferences = { ...this.preferences, ...(format === undefined ? {} : { songFormat: format as HubPreferences['songFormat'] }) };
    await this.options.disk.mkdir(this.options.dataDir);
    await this.options.disk.writeText(this.preferencesFile, `${JSON.stringify(next, null, 2)}\n`);
    this.preferences = next;
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

    // ── the song page and presets (the active server's) ─────────────────────
    this.route('GET', '/api/song-page', () => songPage(this.registry.active()));
    this.route('GET', '/api/presets', () => listPresets(this.registry.active()));
    this.route('POST', '/api/describe', async (request) => {
      const server = this.registry.active();
      return describe(clientFor(server), await songPage(server), text((await request.body())['text'], 'text'));
    });
    this.route('PUT', '/api/presets/:name', async (request) =>
      savePreset(this.registry.active(), request.params['name'] as string, (await request.body()) as unknown as SongForm));
    this.route('DELETE', '/api/presets/:name', (request) =>
      deletePreset(this.registry.active(), request.params['name'] as string));

    // ── jobs ──────────────────────────────────────────────────────────────────
    this.route('POST', '/api/jobs', async (request) => {
      const client = request.client();
      const body = (await request.body()) as unknown as GenerateRequest;
      if (typeof body.params !== 'object' || body.params === null || typeof body.count !== 'number') {
        throw new Refusal('body_invalid', 'A generate request is {params, count}.');
      }
      return this.jobs.generate(this.registry.active(), client, body, this.preferences.songFormat);
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
    this.route('PATCH', '/api/songs/:id', async (request) => {
      await this.library.rename(request.params['id'] as string, text((await request.body())['title'], 'title'));
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
      return this.libraryChanged();
    });
    this.route('DELETE', '/api/playlists/:id', async (request) => {
      await this.library.deletePlaylist(request.params['id'] as string);
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
