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
 * What the hub holds — the server registry, the job runner, the take cache and
 * the library — and the `/api` routes over them are the shared core's
 * (shared/core/hub-core.ts), which the phone runs too. This file is the
 * desktop's door onto it: HTTP, the event stream, audio files with ranges, and
 * the settings only the desktop has (the library folder, sharing, the key).
 *
 * Safety: the hub listens on 127.0.0.1 only until Settings turns on sharing.
 * Shared, a device needs only the address, as with Ollama (Owen, 2026-10-06),
 * unless Settings requires the key: then every `/api` request carries it
 * (`X-BSide-Key`, or `?key=` where an `<audio>` src or EventSource cannot set a
 * header). CORS is open because the iOS app calls from `capacitor://localhost`.
 * Sharing, the key and the library folder are changed only from this computer.
 *
 * Events go out on one SSE stream per client (`GET /api/events`): first a
 * snapshot of everything that client shows, then each change. A client that
 * reconnects gets a fresh snapshot, so nothing missed while it was away matters.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { APP_CLIENT, clientFor } from '../../shared/core/crucible';
import { HubCore, matchRoute, routeOf, type CoreRequest } from '../../shared/core/hub-core';
import type { ImportedAlbum } from '../../shared/core/library';
import type { ServerRegistry } from '../../shared/core/servers';
import type { TakeStore } from '../../shared/core/takes';
import { fileVault, nodeDisk } from '../node-disk';
import { Refusal } from '../refusal';
import { AppSettings, type StoredSettings } from '../settings';
import { ClientTracker, clientName, type ClientName } from './clients';
import { readJson, receiveFile, sendApp, sendFile, sendJson, sendRefusal } from './http';
import {
  HUB_KEY_HEADER,
  TAKE_CACHE_BYTES,
  TAKES_PER_CLIENT,
  WEB_GRACE_MS,
  type HubEvent,
  type HubInfo,
  type HubSettingsView,
  type ServerView,
} from '../../shared/types';

export interface HubOptions {
  readonly userData: string;
  readonly defaultLibraryDir: string;
  /** The built web app (`dist/renderer/browser`). */
  readonly appRoot: string;
  readonly version: string;
}

interface Request extends CoreRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  /** Whether the caller is this computer. */
  readonly local: boolean;
  client(): ClientName;
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

export class Hub {
  readonly settings: AppSettings;
  readonly core: HubCore;
  private readonly clients: ClientTracker;
  /** The desktop's own routes (events, audio, settings): asked before the core's. */
  private readonly routes: Route[] = [];
  private server: Server | null = null;

  constructor(private readonly options: HubOptions) {
    const info: HubInfo = { app: 'b-side', version: options.version, hostname: os.hostname() };
    this.settings = new AppSettings(path.join(options.userData, 'settings.json'), options.defaultLibraryDir);
    this.clients = new ClientTracker(WEB_GRACE_MS, (client) => {
      void this.core.jobs.forgetClient(client);
      void this.core.takes.removeClient(client, 'client_closed');
    });
    this.core = new HubCore({
      disk: nodeDisk,
      vault: fileVault(path.join(options.userData, 'servers.json')),
      dataDir: options.userData,
      takeLimits: { perClient: TAKES_PER_CLIENT, bytes: TAKE_CACHE_BYTES },
      clientName: `${APP_CLIENT}@${os.hostname().replace(/\.local$/i, '')}`,
      info,
      sink: {
        send: (client, event) => this.clients.send(client, event),
        broadcast: (event) => this.clients.broadcast(event),
        isClosed: (client) => this.clients.isClosed(client),
      },
      fetchAudio: async (server, jobId, artifact, file) => {
        const bytes = await clientFor(server).artifact(jobId, artifact);
        await fsp.writeFile(file, bytes);
        return bytes.byteLength;
      },
    });
    this.defineRoutes();
  }

  get registry(): ServerRegistry {
    return this.core.registry;
  }

  get takes(): TakeStore {
    return this.core.takes;
  }

  /** Read what is on disk, then listen. Refuses (with the port in the sentence) when the port is taken. */
  async start(): Promise<void> {
    await this.settings.ensureKey();
    await this.core.open(this.settings.view().libraryDir);
    this.clients.adopt(this.core.takes.clients());
    await this.listen();
    await this.core.resume();
  }

  /** Where this computer reaches the hub, and with what key (for the desktop window). */
  localAddress(): { url: string; key: string } {
    const view = this.settings.view();
    return { url: `http://127.0.0.1:${view.port}`, key: view.key };
  }

  async setLibraryDir(dir: string | null): Promise<HubSettingsView> {
    const view = await this.settings.setLibraryDir(dir);
    await this.core.openLibrary(view.libraryDir);
    await this.core.libraryChanged();
    return this.settingsView(view, true);
  }

  /** The audio file of a saved song, for the desktop's "save a copy" and "show in folder". */
  songFile(id: string): Promise<{ title: string; file: string }> {
    return this.core.songFile(id);
  }

  /** Tell every client the server list changed (the desktop's Crucible setup changes it outside the routes). */
  serversChanged(servers?: ServerView[]): ServerView[] {
    return this.core.serversChanged(servers);
  }

  async stop(): Promise<void> {
    await this.close();
  }

  /** Close the album writing sessions open now, so a quit frees the Crucible server at once. */
  async closeSessions(): Promise<void> {
    await this.core.closeSessions();
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
            `Port ${view.port} is already in use by another program, so B-Sides cannot start its hub. ` +
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

  private settingsView(view: StoredSettings, local: boolean): HubSettingsView {
    const links: string[] = [];
    if (view.sharing) {
      for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses ?? []) {
          if (address.family === 'IPv4' && !address.internal) {
            links.push(`http://${address.address}:${view.port}${view.requireKey ? `/#key=${view.key}` : ''}`);
          }
        }
      }
    }
    return {
      libraryDir: view.libraryDir,
      defaultLibraryDir: view.defaultLibraryDir,
      sharing: view.sharing,
      requireKey: view.requireKey,
      port: view.port,
      links,
      local,
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
    // The key is asked for only when Settings requires it. Off (the default), the address is enough,
    // as Ollama: a device that can reach the hub can use it. Sharing still decides who can reach it.
    const given = String(req.headers[HUB_KEY_HEADER.toLowerCase()] ?? url.searchParams.get('key') ?? '');
    const settings = this.settings.view();
    if (settings.requireKey && !sameKey(given, settings.key)) {
      // `code` lets a client tell "wrong key" from a hub it cannot reach, and ask for the link again.
      sendJson(res, 401, { error: { code: 'hub_key', message: 'This device needs the B-Sides link (with its key) to use this hub.' } });
      return;
    }
    const method = req.method === 'HEAD' ? 'GET' : (req.method ?? 'GET');
    let found: { handler: Handler; params: Record<string, string>; raw: boolean } | null = null;
    try {
      const own = matchRoute(this.routes, method, url.pathname);
      const core = own === null ? matchRoute(this.core.routes, method, url.pathname) : null;
      if (own !== null) found = { handler: own.route.handler, params: own.params, raw: own.route.raw };
      else if (core !== null) found = { handler: core.route.handler, params: core.params, raw: false };
    } catch {
      sendJson(res, 400, { error: { code: 'path_invalid', message: 'That address is not valid.' } });
      return;
    }
    if (found === null) {
      sendJson(res, 404, { error: { code: 'not_found', message: `There is no ${method} ${url.pathname}.` } });
      return;
    }
    const request: Request = {
      req,
      res,
      url,
      params: found.params,
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
      const value = await found.handler(request);
      if (!found.raw && value !== SENT) sendJson(res, 200, value ?? null);
    } catch (error) {
      if (res.headersSent) {
        console.error(`[hub] ${method} ${url.pathname} failed after it began answering:`, error);
        res.destroy();
      } else {
        sendRefusal(res, error);
      }
    }
  }

  private route(method: string, template: string, handler: Handler, raw = false): void {
    this.routes.push({ ...routeOf(method, template, handler), raw });
  }

  private localOnly(request: Request, what: string): void {
    if (!request.local) throw new Refusal('hub_local_only', `Only the computer B-Sides runs on can ${what}.`, 403);
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
      const first: HubEvent = { type: 'snapshot', snapshot: await this.core.snapshot(client) };
      res.write(`data: ${JSON.stringify(first)}\n\n`);
      this.clients.open(client, res);
    }, true);

    // ── audio, with ranges ────────────────────────────────────────────────────
    this.route('GET', '/api/takes/:id/audio', async (request) => {
      await sendFile(request.req, request.res, this.core.takeAudio(request.params['id'] as string), 'private, max-age=86400');
    }, true);
    this.route('GET', '/api/albums/:id/cover', async (request) => {
      await sendFile(request.req, request.res, await this.core.coverFile(request.params['id'] as string), 'private, max-age=86400');
    }, true);
    // ── the phone's cloud: albums sent from a phone ─────────────────────────────
    // Files first (raw bodies, natively uploaded), then the album that names them.
    this.route('PUT', '/api/import/files/:name', async (request) => {
      const target = this.core.importPath(request.params['name'] as string);
      await receiveFile(request.req, target);
      sendJson(request.res, 200, { name: request.params['name'] });
    }, true);
    // A song file dropped on the window (raw body): into the playlist named, else New Songs.
    this.route('PUT', '/api/import/song', async (request) => {
      const name = path.basename(request.url.searchParams.get('name') ?? '');
      const extension = path.extname(name).toLowerCase();
      if (!/^\.(flac|wav|mp3)$/.test(extension)) {
        throw new Refusal('song_format', `B-Sides keeps flac, wav or mp3 audio; ${name || 'that file'} is not one.`);
      }
      const title = (request.url.searchParams.get('title') ?? '').trim() || path.basename(name, extension);
      const duration = Number(request.url.searchParams.get('duration'));
      const playlist = request.url.searchParams.get('playlist');
      const temporary = path.join(os.tmpdir(), `bsides-import-${randomUUID()}${extension}`);
      try {
        await receiveFile(request.req, temporary);
        const bytes = (await fsp.stat(temporary)).size;
        const view = await this.core.importSong(temporary, { name, title, durationS: Number.isFinite(duration) && duration > 0 ? duration : null, bytes }, playlist || null);
        sendJson(request.res, 200, view);
      } finally {
        await fsp.rm(temporary, { force: true });
      }
    }, true);
    this.route('POST', '/api/import/albums', async (request) =>
      this.core.importAlbum((await request.body()) as unknown as ImportedAlbum));
    this.route('GET', '/api/songs/:id/audio', async (request) => {
      const song = await this.core.songFile(request.params['id'] as string);
      await sendFile(request.req, request.res, song.file, 'private, max-age=86400');
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
    this.route('PUT', '/api/settings/require-key', async (request) => {
      this.localOnly(request, 'choose whether devices need the key');
      const requireKey = (await request.body())['requireKey'];
      if (typeof requireKey !== 'boolean') throw new Refusal('body_invalid', 'requireKey must be true or false.');
      return this.settingsView(await this.settings.setRequireKey(requireKey), true);
    });
    this.route('POST', '/api/settings/key', async (request) => {
      this.localOnly(request, 'replace the hub key');
      const view = await this.settings.replaceKey();
      // The desktop window holds the key in memory; it reads the new one from here.
      sendJson(request.res, 200, { settings: this.settingsView(view, true), key: view.key });
      setTimeout(() => this.clients.endAll(), 100);
      return SENT;
    });
  }
}
