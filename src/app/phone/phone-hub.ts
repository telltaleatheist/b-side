import { CrucibleUnreachable } from '@crucible/client';

import { CLIENT_NAME } from '@shared/core/crucible';
import { HubCore, matchRoute, type CoreClient } from '@shared/core/hub-core';
import { Refusal, refusalOf } from '@shared/core/refusal';
import { TAKE_CACHE_BYTES, TAKES_PER_CLIENT, type HubEvent, type Outcome } from '@shared/types';

import { NativeDisk, keychainVault, nativeDisk } from './native-disk';
import { PHONE_DATA, PHONE_LIBRARY } from './phone-paths';

const VAULT_KEY = 'crucible-servers';

/**
 * The phone's own B-Sides hub: the shared core (shared/core/hub-core.ts) run in
 * the app, so the phone talks to a Crucible server itself, with no B-Sides
 * computer. The screens do not know: HubService sends its calls here instead of
 * over HTTP, and hears events from here instead of a stream.
 *
 * What differs from the desktop's door: one client (this phone), files in the
 * app's folder (NativeDisk), the server list in the Keychain, and songs
 * downloaded natively with the token in the header. The playing list is the
 * phone's 60-take FIFO; saved playlists live in `library/` and are backed up
 * with the phone.
 */
export class PhoneHub {
  private readonly listeners = new Set<(event: HubEvent) => void>();

  private constructor(
    readonly core: HubCore,
    private readonly client: CoreClient,
    /** `file://` URL of Documents/bside, for the native player. */
    readonly rootUrl: string,
  ) {}

  static async open(client: CoreClient, version: string): Promise<PhoneHub> {
    const root = (await NativeDisk.root()).url.replace(/\/+$/, '');
    let hub: PhoneHub | null = null;
    const core = new HubCore({
      disk: nativeDisk,
      vault: keychainVault(VAULT_KEY),
      dataDir: PHONE_DATA,
      takeLimits: { perClient: TAKES_PER_CLIENT, bytes: TAKE_CACHE_BYTES },
      clientName: CLIENT_NAME,
      limitsAlbumSpace: true,
      info: { app: 'b-side', version, hostname: 'this phone' },
      sink: {
        send: (to, event) => {
          if (to === client.id) hub?.emit(event);
        },
        broadcast: (event) => hub?.emit(event),
        isClosed: () => false,
      },
      fetchAudio: async (server, jobId, artifact, file) => {
        const url = `${server.url}/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifact)}`;
        try {
          const done = await NativeDisk.download({
            url,
            path: file,
            headers: { Authorization: `Bearer ${server.token}`, 'X-Crucible-Api': '1', 'X-Crucible-Client': CLIENT_NAME },
          });
          return done.bytes;
        } catch (error) {
          const { code, message } = error as { code?: string; message?: string };
          if (code === 'unreachable') throw new CrucibleUnreachable(server.url, message ?? 'the download failed');
          throw new Refusal(code ?? 'download_failed', message ?? 'The song could not be downloaded.');
        }
      },
    });
    hub = new PhoneHub(core, client, root);
    await core.open(PHONE_LIBRARY);
    // Read before anyone listens, so the first snapshot carries the resumed jobs (their following runs on).
    await core.resume();
    return hub;
  }

  /** Hear every event, starting with a snapshot; answers how to stop. */
  async subscribe(listener: (event: HubEvent) => void): Promise<() => void> {
    listener({ type: 'snapshot', snapshot: await this.core.snapshot(this.client) });
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** One API call, as HubService makes them over HTTP to a desktop hub. */
  async call<T>(method: string, path: string, body?: unknown): Promise<Outcome<T>> {
    const found = matchRoute(this.core.routes, method, path);
    if (found === null) {
      return { ok: false, refusal: { code: 'not_found', message: `This phone does not answer ${method} ${path}.` } };
    }
    try {
      const value = await found.route.handler({
        params: found.params,
        client: () => this.client,
        body: async () => {
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            throw new Refusal('body_invalid', 'This request needs a JSON object.');
          }
          return body as Record<string, unknown>;
        },
      });
      // Through JSON, as over the wire: a screen never holds the core's own objects.
      return { ok: true, value: (value === undefined ? null : JSON.parse(JSON.stringify(value))) as T };
    } catch (error) {
      return { ok: false, refusal: refusalOf(error) };
    }
  }

  /** A `file://` URL the native player opens, for a file the core named. */
  fileUrl(path: string): string {
    return `${this.rootUrl}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  private emit(event: HubEvent): void {
    const copy = JSON.parse(JSON.stringify(event)) as HubEvent;
    for (const listener of this.listeners) listener(copy);
  }
}
