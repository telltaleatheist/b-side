/**
 * hub — the desktop app as the hub: one HTTP server every client talks to.
 *
 * Owen, 2026-10-04: "Desktop is the hub. Just like Bookforge/bookshelf", and
 * "Website Served by the desktop app". So main runs this server always: the
 * built Angular app at `/`, the API at `/api`. The desktop window is its first
 * client (it loads the app from here and talks HTTP like every other client), a
 * browser tab on the network is another, the iOS app another. One UI, one
 * transport, one code path.
 *
 * What the hub holds, and nobody else does:
 *   - the Crucible server registry (tokens never leave main: the hub proxies);
 *   - the job runner (a client asks; the hub submits, follows and fetches);
 *   - the take cache — every client's playing list (`TakeStore`);
 *   - the library folder — saved songs and playlists (`Library`).
 *
 * Safety, as Bookshelf does it: every `/api` request carries the hub key
 * (`X-BSide-Key`, or `?key=` where an `<audio>` src or EventSource cannot set a
 * header); CORS is open because the iOS app calls from `capacitor://localhost`
 * and the key is the boundary. The hub listens on 127.0.0.1 only until Settings
 * turns on sharing; turning sharing on or off and replacing the key are taken
 * only from this computer.
 *
 * Events go out on one SSE stream per client (`GET /api/events`): first a
 * snapshot of everything that client shows, then each change. A client that
 * reconnects gets a fresh snapshot, so nothing missed while it was away matters.
 */
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { clientFor, deletePreset, listPresets, probe, savePreset, songPage } from '../crucible';
import { describe } from '../describe';
import { JobRunner } from '../jobs';
import { Library } from '../library';
import { Refusal } from '../refusal';
import { ServerRegistry } from '../servers';
import { AppSettings, type StoredSettings } from '../settings';
import { TakeStore } from '../takes';
import { defaultTitle } from '../titles';
import { ClientTracker, clientName, type ClientName } from './clients';
import { readJson, sendApp, sendFile, sendJson, sendRefusal } from './http';
import {
  HUB_KEY_HEADER,
  SONG_MODEL,
  TAKE_CACHE_BYTES,
  TAKES_PER_CLIENT,
  WEB_GRACE_MS,
  type GenerateRequest,
  type HubEvent,
  type HubInfo,
  type HubSettingsView,
  type HubSnapshot,
  type LibraryView,
  type ServerInput,
  type ServerView,
  type SongForm,
} from '../../shared/types';

export interface HubOptions {
  readonly userData: string;
  readonly defaultLibraryDir: string;
  /** The built web app (`dist/renderer/browser`). */
  readonly appRoot: string;
  readonly version: string;
}

interface Request {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Record<string, string>;
  /** Whether the caller is this computer. */
  readonly local: boolean;
  /** The calling device, read from its headers; refuses when it did not say. */
  client(): ClientName;
  body(): Promise<Record<string, unknown>>;
}

type Handler = (request: Request) => Promise<unknown> | unknown;

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  readonly names: readonly string[];
  readonly handler: Handler;
  /** Streams or files: the handler writes the response itself. */
  readonly raw: boolean;
}

/** Marks a handler's answer as "already sent". */
const SENT = Symbol('sent');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function sameKey(given: string, key: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Refusal('body_invalid', `${what} must be text.`);
  return value;
}

export class Hub {
  readonly settings: AppSettings;
  readonly registry: ServerRegistry;
  readonly takes: TakeStore;
  readonly jobs: JobRunner;
  private library!: Library;
  private readonly clients: ClientTracker;
  private readonly routes: Route[] = [];
  private server: Server | null = null;
  private readonly info: HubInfo;

  constructor(private readonly options: HubOptions) {
    this.info = { app: 'b-side', version: options.version, hostname: os.hostname() };
    this.settings = new AppSettings(path.join(options.userData, 'settings.json'), options.defaultLibraryDir);
    this.registry = new ServerRegistry(path.join(options.userData, 'servers.json'));
    this.takes = new TakeStore(path.join(options.userData, 'takes'), {
      perClient: TAKES_PER_CLIENT,
      bytes: TAKE_CACHE_BYTES,
    });
    this.clients = new ClientTracker(WEB_GRACE_MS, (client) => {
      void this.jobs.forgetClient(client);
      void this.takes.removeClient(client, 'client_closed');
    });
    this.takes.onGone((take, reason) => this.clients.send(take.client, { type: 'take-gone', id: take.id, reason }));
    this.jobs = new JobRunner(
      {
        publish: (job) => this.clients.send(job.client, { type: 'job', job }),
        server: (name) => this.registry.get(name),
        land: async (landed) => {
          if (this.clients.isClosed(landed.job.client)) {
            throw new Refusal('client_closed', 'The browser tab that asked for this song has closed; nobody is left to play it.');
          }
          const params = landed.job.params;
          const take = await this.takes.add({
            client: landed.job.client,
            kind: landed.job.clientKind,
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
            createdAt: new Date().toISOString(),
          });
          this.clients.send(take.client, { type: 'take', take });
          return take;
        },
      },
      path.join(options.userData, 'pending.json'),
    );
    this.defineRoutes();
  }

  /** Read what is on disk, then listen. Refuses (with the port in the sentence) when the port is taken. */
  async start(): Promise<void> {
    await this.settings.ensureKey();
    await this.takes.open();
    this.clients.adopt(this.takes.clients());
    await this.openLibrary(this.settings.view().libraryDir);
    await this.listen();
    await this.jobs.resume();
  }

  /** Where this computer reaches the hub, and with what key (for the desktop window). */
  localAddress(): { url: string; key: string } {
    const view = this.settings.view();
    return { url: `http://127.0.0.1:${view.port}`, key: view.key };
  }

  async setLibraryDir(dir: string | null): Promise<HubSettingsView> {
    const view = await this.settings.setLibraryDir(dir);
    await this.openLibrary(view.libraryDir);
    await this.libraryChanged();
    return this.settingsView(view, true);
  }

  /** The audio file of a saved song, for the desktop's "save a copy" and "show in folder". */
  async songFile(id: string): Promise<{ title: string; file: string }> {
    const song = await this.library.song(id);
    return { title: song.title, file: this.library.audioPath(song.file) };
  }

  async stop(): Promise<void> {
    await this.close();
  }

  // ── listening ───────────────────────────────────────────────────────────────

  private async listen(): Promise<void> {
    const view = this.settings.view();
    const host = view.sharing ? '0.0.0.0' : '127.0.0.1';
    const server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Refusal(
            'hub_port_taken',
            `Port ${view.port} is already in use by another program, so B-Side cannot start its hub. ` +
              `Close that program, or set "hubPort" to another number in ${path.join(this.options.userData, 'settings.json')}.`,
          ));
        } else {
          reject(err);
        }
      });
      server.listen(view.port, host, () => resolve());
    });
    server.on('error', (err) => console.error('[hub] server error:', err));
    this.server = server;
    console.log(`[hub] listening on ${host}:${view.port}${view.sharing ? ' (shared on the network)' : ' (this computer only)'}`);
  }

  private async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    this.server = null;
    this.clients.endAll();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  // ── state ───────────────────────────────────────────────────────────────────

  private async openLibrary(dir: string): Promise<void> {
    this.library = new Library(dir);
    await this.library.adoptLoose();
  }

  private async libraryView(): Promise<LibraryView> {
    return this.library.list();
  }

  private async libraryChanged(): Promise<LibraryView> {
    const library = await this.libraryView();
    this.clients.broadcast({ type: 'library', library });
    return library;
  }

  /**
   * Tell every client the server list changed. The hub's own server routes call
   * it with the list they wrote; the desktop-only Crucible setup (electron/ipc.ts:
   * install, start, use, uninstall) changes the registry outside those routes and
   * calls it with nothing, so the list is read as stored.
   */
  serversChanged(servers: ServerView[] = this.registry.views()): ServerView[] {
    this.clients.broadcast({ type: 'servers', servers });
    return servers;
  }

  private settingsView(view: StoredSettings, local: boolean): HubSettingsView {
    const links: string[] = [];
    if (view.sharing) {
      for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses ?? []) {
          if (address.family === 'IPv4' && !address.internal) {
            links.push(`http://${address.address}:${view.port}/#key=${view.key}`);
          }
        }
      }
    }
    return {
      libraryDir: view.libraryDir,
      defaultLibraryDir: view.defaultLibraryDir,
      sharing: view.sharing,
      port: view.port,
      links,
      local,
    };
  }

  private async snapshot(client: ClientName): Promise<HubSnapshot> {
    return {
      hub: this.info,
      servers: this.registry.views(),
      jobs: this.jobs.list(client.id),
      takes: this.takes.list(client.id),
      library: await this.libraryView(),
    };
  }

  // ── requests ────────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://hub');
    } catch {
      sendJson(res, 400, { error: { code: 'path_invalid', message: 'That address is not valid.' } });
      return;
    }
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/api') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'The web app is only read.' } });
        return;
      }
      await sendApp(req, res, this.options.appRoot, url.pathname);
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      `Content-Type, Range, ${HUB_KEY_HEADER}, X-BSide-Client, X-BSide-Client-Kind`,
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const given = String(req.headers[HUB_KEY_HEADER.toLowerCase()] ?? url.searchParams.get('key') ?? '');
    if (!sameKey(given, this.settings.view().key)) {
      // `code` lets a client tell "wrong key" from a hub it cannot reach, and ask for the link again.
      sendJson(res, 401, { error: { code: 'hub_key', message: 'This device needs the B-Side link (with its key) to use this hub.' } });
      return;
    }
    const method = req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET');
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(url.pathname);
      if (match === null) continue;
      const params: Record<string, string> = {};
      try {
        route.names.forEach((name, at) => {
          params[name] = decodeURIComponent(match[at + 1] as string);
        });
      } catch {
        sendJson(res, 400, { error: { code: 'path_invalid', message: 'That address is not valid.' } });
        return;
      }
      const request: Request = {
        req,
        res,
        url,
        params,
        local: LOOPBACK.has(req.socket.remoteAddress ?? ''),
        client: () => {
          const name = clientName(
            req.headers['x-bside-client'] ?? url.searchParams.get('client'),
            req.headers['x-bside-client-kind'] ?? url.searchParams.get('kind'),
          );
          this.clients.note(name);
          return name;
        },
        body: async () => {
          const body = await readJson(req);
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            throw new Refusal('body_invalid', 'This request needs a JSON object.');
          }
          return body as Record<string, unknown>;
        },
      };
      try {
        const value = await route.handler(request);
        if (!route.raw && value !== SENT) sendJson(res, 200, value ?? null);
      } catch (error) {
        if (res.headersSent) {
          console.error(`[hub] ${method} ${url.pathname} failed after it began answering:`, error);
          res.destroy();
        } else {
          sendRefusal(res, error);
        }
      }
      return;
    }
    sendJson(res, 404, { error: { code: 'not_found', message: `There is no ${method} ${url.pathname}.` } });
  }

  private route(method: string, template: string, handler: Handler, raw = false): void {
    const names: string[] = [];
    const pattern = new RegExp(
      `^${template.replace(/:([a-zA-Z]+)/g, (_, name: string) => {
        names.push(name);
        return '([^/]+)';
      })}$`,
    );
    this.routes.push({ method, pattern, names, handler, raw });
  }

  private localOnly(request: Request, what: string): void {
    if (!request.local) throw new Refusal('hub_local_only', `Only the computer B-Side runs on can ${what}.`, 403);
  }

  private defineRoutes(): void {
    // ── events ────────────────────────────────────────────────────────────────
    this.route('GET', '/api/events', async (request) => {
      const client = request.client();
      const res = request.res;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        // Tells a buffering proxy to pass each event straight through.
        'X-Accel-Buffering': 'no',
      });
      const first: HubEvent = { type: 'snapshot', snapshot: await this.snapshot(client) };
      res.write(`data: ${JSON.stringify(first)}\n\n`);
      this.clients.open(client, res);
    }, true);

    // ── settings ──────────────────────────────────────────────────────────────
    this.route('GET', '/api/settings', (request) => this.settingsView(this.settings.view(), request.local));
    this.route('PUT', '/api/settings/sharing', async (request) => {
      this.localOnly(request, 'turn sharing on or off');
      const sharing = (await request.body())['sharing'];
      if (typeof sharing !== 'boolean') throw new Refusal('body_invalid', 'sharing must be true or false.');
      const view = await this.settings.setSharing(sharing);
      // Answer first, then rebind: this very connection is one the rebind ends.
      sendJson(request.res, 200, this.settingsView(view, true));
      setTimeout(() => {
        void this.close().then(() => this.listen()).catch((err: unknown) => {
          console.error('[hub] could not listen again after the sharing change:', err);
        });
      }, 100);
      return SENT;
    });
    this.route('POST', '/api/settings/key', async (request) => {
      this.localOnly(request, 'replace the hub key');
      const view = await this.settings.replaceKey();
      // The desktop window holds the key in memory; it reads the new one from here.
      sendJson(request.res, 200, { settings: this.settingsView(view, true), key: view.key });
      setTimeout(() => this.clients.endAll(), 100);
      return SENT;
    });

    // ── Crucible servers (tokens go in, never come out) ─────────────────────
    this.route('GET', '/api/servers', () => this.registry.views());
    this.route('POST', '/api/servers/pairing', async (request) =>
      this.serversChanged(await this.registry.addPairing(text((await request.body())['line'], 'line'))));
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
      return this.jobs.generate(this.registry.active(), client, body);
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
    this.route('GET', '/api/takes/:id/audio', async (request) => {
      await sendFile(request.req, request.res, this.takes.audioPath(request.params['id'] as string), 'private, max-age=86400');
    }, true);

    // ── the library: saved songs and playlists ──────────────────────────────
    this.route('GET', '/api/library', () => this.libraryView());
    this.route('GET', '/api/songs/:id/audio', async (request) => {
      const song = await this.library.song(request.params['id'] as string);
      await sendFile(request.req, request.res, this.library.audioPath(song.file), 'private, max-age=86400');
    }, true);
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
        this.clients.send(marked.client, { type: 'take', take: marked });
      }
      return this.libraryChanged();
    });
    this.route('DELETE', '/api/playlists/:id/songs/:song', async (request) => {
      await this.library.removeFrom(request.params['id'] as string, request.params['song'] as string);
      return this.libraryChanged();
    });
  }

  /** A job is cancelled or dismissed only by the device that asked for it. */
  private ownJob(request: Request): void {
    const owner = this.jobs.owner(request.params['key'] as string);
    if (owner !== null && owner !== request.client().id) {
      throw new Refusal('job_not_yours', 'That song is being made for another device.', 403);
    }
  }
}
