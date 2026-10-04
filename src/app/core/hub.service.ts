import { computed, Injectable, signal } from '@angular/core';

import type { DesktopBridge } from '@shared/api';
import {
  HUB_KEY_HEADER,
  type ClientKind,
  type HubEvent,
  type HubInfo,
  type JobView,
  type LibraryView,
  type Outcome,
  type RefusalView,
  type ServerView,
  type Take,
} from '@shared/types';

declare global {
  interface Window {
    bside?: DesktopBridge;
  }
}

/** The desktop bridge, when this is the desktop window; null in a browser tab or the phone. */
export const desktop: DesktopBridge | null = typeof window !== 'undefined' && window.bside ? window.bside : null;

/** Whether this is the iOS app (Capacitor serves the app from `capacitor://localhost`). */
export const isNative = typeof location !== 'undefined' && location.protocol === 'capacitor:';

export type HubState =
  /** Opening the event stream. */
  | 'connecting'
  /** The stream is open; everything shown is current. */
  | 'live'
  /** The stream dropped; trying again with backoff. Shown, never silent. */
  | 'reconnecting'
  /** The hub said the key is wrong or missing: this device needs the link again. */
  | 'key'
  /** The phone has no hub chosen yet. */
  | 'no-hub'
  /** The phone is in the background: no network on purpose (heat, battery). */
  | 'paused';

export interface HubAddress {
  readonly url: string;
  readonly key: string;
}

const STORED_HUB = 'bside.hub';
const STORED_KEY = 'bside.key';
const STORED_CLIENT = 'bside.client';
const BACKOFF_FIRST_MS = 1000;
const BACKOFF_MOST_MS = 30_000;

/** Browser storage can be missing or throw (private windows, blocked site data): a convenience, never relied on. */
function stored(storage: () => Storage, name: string): string | null {
  try {
    return storage().getItem(name);
  } catch {
    return null;
  }
}

function store(storage: () => Storage, name: string, value: string | null): void {
  try {
    if (value === null) storage().removeItem(name);
    else storage().setItem(name, value);
  } catch {
    // Not kept: this device asks again next time.
  }
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The hub connection: every request and every event, for every client.
 *
 * Who this device is:
 *   - the desktop window: id `desktop`, and the bridge says where the hub is;
 *   - a browser tab: a new id per tab (sessionStorage, so it dies with the tab,
 *     and the hub clears its playing list after), served by the hub itself, the
 *     key read once from the link's `#key=` and kept in localStorage;
 *   - the iOS app: one id kept for good, and the hub the person chose.
 *
 * Events come on one stream (`GET /api/events`). Its first event is a snapshot of
 * everything this device shows; a dropped stream reconnects with backoff (1 s,
 * doubling, at most 30 s) and gets a fresh snapshot, so nothing missed matters.
 * The phone closes the stream in the background and opens it again in front:
 * never a request loop (the Bookshelf app's heat lesson).
 */
@Injectable({ providedIn: 'root' })
export class HubService {
  readonly kind: ClientKind = desktop !== null ? 'desktop' : isNative ? 'ios' : 'web';
  readonly client: string;

  readonly address = signal<HubAddress | null>(null);
  readonly state = signal<HubState>('connecting');
  /** Why the stream is down, while it is. */
  readonly trouble = signal<string | null>(null);

  readonly info = signal<HubInfo | null>(null);
  readonly servers = signal<ServerView[]>([]);
  readonly jobs = signal<JobView[]>([]);
  readonly takes = signal<Take[]>([]);
  readonly library = signal<LibraryView>({ dir: '', songs: [], playlists: [], problems: [] });
  /** True once the first snapshot has arrived. */
  readonly loaded = signal(false);

  readonly activeServer = computed(() => this.servers().find((server) => server.active) ?? null);

  private readonly takeListeners: ((take: Take) => void)[] = [];
  private stream: AbortController | null = null;
  private backoff = BACKOFF_FIRST_MS;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.client = this.whoAmI();
    this.address.set(this.whereIsTheHub());
    if (this.kind === 'ios') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.pause();
        else this.connect();
      });
    }
    this.connect();
  }

  /** Hear each take that just landed in this device's playing list. */
  onTake(listener: (take: Take) => void): void {
    this.takeListeners.push(listener);
  }

  /** Choose (or re-key) the hub: the phone's hub picker, or a tab given its link again. */
  useHub(address: HubAddress): void {
    const url = address.url.trim().replace(/\/+$/, '');
    const next = { url, key: address.key.trim() };
    if (this.kind === 'ios') store(() => localStorage, STORED_HUB, JSON.stringify(next));
    if (this.kind === 'web') store(() => localStorage, STORED_KEY, next.key);
    this.address.set(next);
    this.reconnectNow();
  }

  /** The desktop replaced the key: keep using this hub with the new one. */
  rekey(key: string): void {
    const address = this.address();
    if (address !== null) this.useHub({ url: address.url, key });
  }

  /** A playable URL for a take or a saved song (an `<audio>` src cannot carry headers, so the key rides along). */
  audioUrl(kind: 'takes' | 'songs', id: string): string {
    const address = this.address();
    if (address === null) return '';
    return `${address.url}/api/${kind}/${encodeURIComponent(id)}/audio?key=${encodeURIComponent(address.key)}`;
  }

  /** One API call, answered as an Outcome so a refusal keeps its code. */
  async call<T>(method: string, path: string, body?: unknown): Promise<Outcome<T>> {
    const address = this.address();
    if (address === null) return { ok: false, refusal: { code: 'no_hub', message: 'Choose a B-Side hub first.' } };
    const headers: Record<string, string> = {
      [HUB_KEY_HEADER]: address.key,
      'X-BSide-Client': this.client,
      'X-BSide-Client-Kind': this.kind,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await fetch(`${address.url}${path}`, init);
    } catch {
      return { ok: false, refusal: { code: 'hub_unreachable', message: `The B-Side hub at ${address.url} is not answering.` } };
    }
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = (parsed as { error?: RefusalView } | null)?.error;
      if (response.status === 401) this.needsKey();
      return {
        ok: false,
        refusal: error && typeof error.code === 'string'
          ? error
          : { code: `http_${response.status}`, message: `The hub answered HTTP ${response.status}.` },
      };
    }
    return { ok: true, value: parsed as T };
  }

  // ── the event stream ────────────────────────────────────────────────────────

  private connect(): void {
    if (this.stream !== null) return;
    const address = this.address();
    if (address === null) {
      this.state.set('no-hub');
      return;
    }
    if (this.retry !== null) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    const controller = new AbortController();
    this.stream = controller;
    if (this.state() !== 'reconnecting') this.state.set('connecting');
    void this.read(address, controller).then(
      (outcome) => this.ended(controller, outcome),
      (error: unknown) => this.ended(controller, error instanceof Error ? error.message : String(error)),
    );
  }

  /** Read events until the stream ends; answers why it ended. */
  private async read(address: HubAddress, controller: AbortController): Promise<string | 'key' | 'aborted'> {
    const query = `client=${encodeURIComponent(this.client)}&kind=${this.kind}&key=${encodeURIComponent(address.key)}`;
    let response: Response;
    try {
      response = await fetch(`${address.url}/api/events?${query}`, { signal: controller.signal, cache: 'no-store' });
    } catch {
      return controller.signal.aborted ? 'aborted' : `the hub at ${address.url} is not answering`;
    }
    if (response.status === 401) return 'key';
    if (!response.ok || response.body === null) return `the hub answered HTTP ${response.status}`;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return 'the hub closed the stream';
        buffer += decoder.decode(value, { stream: true });
        let end = buffer.indexOf('\n\n');
        while (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
          if (data !== '') this.apply(JSON.parse(data) as HubEvent);
          end = buffer.indexOf('\n\n');
        }
      }
    } catch {
      return controller.signal.aborted ? 'aborted' : 'the connection to the hub dropped';
    }
  }

  private ended(controller: AbortController, why: string): void {
    if (this.stream === controller) this.stream = null;
    if (why === 'aborted') return;
    if (why === 'key') {
      this.needsKey();
      return;
    }
    this.state.set('reconnecting');
    this.trouble.set(`${why[0]?.toUpperCase() ?? ''}${why.slice(1)}; trying again in ${Math.round(this.backoff / 1000)} s`);
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MOST_MS);
  }

  private apply(event: HubEvent): void {
    switch (event.type) {
      case 'snapshot':
        this.info.set(event.snapshot.hub);
        this.servers.set([...event.snapshot.servers]);
        this.jobs.set([...event.snapshot.jobs]);
        this.takes.set([...event.snapshot.takes]);
        this.library.set(event.snapshot.library);
        this.loaded.set(true);
        this.state.set('live');
        this.trouble.set(null);
        this.backoff = BACKOFF_FIRST_MS;
        break;
      case 'job':
        this.upsertJob(event.job);
        break;
      case 'take': {
        const known = this.takes().some((take) => take.id === event.take.id);
        this.takes.update((takes) =>
          known ? takes.map((take) => (take.id === event.take.id ? event.take : take)) : [...takes, event.take]);
        if (!known) for (const listener of this.takeListeners) listener(event.take);
        break;
      }
      case 'take-gone':
        this.takes.update((takes) => takes.filter((take) => take.id !== event.id));
        break;
      case 'library':
        this.library.set(event.library);
        break;
      case 'servers':
        this.servers.set([...event.servers]);
        break;
    }
  }

  /** Apply a job change (from the stream, or the answer to a generate). */
  upsertJob(job: JobView): void {
    if (job.phase === 'done') {
      this.jobs.update((jobs) => jobs.filter((other) => other.key !== job.key));
      return;
    }
    this.jobs.update((jobs) => {
      const at = jobs.findIndex((other) => other.key === job.key);
      if (at < 0) return [...jobs, job].sort((a, b) => a.number - b.number);
      const next = [...jobs];
      next[at] = job;
      return next;
    });
  }

  dropJob(key: string): void {
    this.jobs.update((jobs) => jobs.filter((job) => job.key !== key));
  }

  private needsKey(): void {
    this.state.set('key');
    this.trouble.set(null);
  }

  private pause(): void {
    this.stream?.abort();
    this.stream = null;
    if (this.retry !== null) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    this.state.set('paused');
  }

  private reconnectNow(): void {
    this.stream?.abort();
    this.stream = null;
    this.backoff = BACKOFF_FIRST_MS;
    this.connect();
  }

  // ── who and where ───────────────────────────────────────────────────────────

  private whoAmI(): string {
    if (this.kind === 'desktop') return 'desktop';
    const storage = this.kind === 'web' ? (): Storage => sessionStorage : (): Storage => localStorage;
    const known = stored(storage, STORED_CLIENT);
    if (known !== null && /^[A-Za-z0-9_-]{6,64}$/.test(known)) return known;
    const made = newId(this.kind === 'web' ? 'tab' : 'ios');
    store(storage, STORED_CLIENT, made);
    return made;
  }

  private whereIsTheHub(): HubAddress | null {
    if (desktop !== null) return desktop.hub;
    if (this.kind === 'ios') {
      const raw = stored(() => localStorage, STORED_HUB);
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as HubAddress;
        return typeof parsed.url === 'string' && typeof parsed.key === 'string' ? parsed : null;
      } catch {
        return null;
      }
    }
    // A browser tab: the hub is whoever served this page. The link carries the key once.
    const fromLink = /(?:^#|&)key=([^&]+)/.exec(location.hash)?.[1];
    if (fromLink !== undefined) {
      store(() => localStorage, STORED_KEY, decodeURIComponent(fromLink));
      history.replaceState(null, '', location.pathname + location.search);
    }
    const key = fromLink !== undefined ? decodeURIComponent(fromLink) : stored(() => localStorage, STORED_KEY);
    return { url: location.origin, key: key ?? '' };
  }
}

/** Read a hub link (`http://host:port/#key=...`) into an address. Null when it is not one. */
export function parseHubLink(link: string): HubAddress | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const key = /(?:^#|&)key=([^&]+)/.exec(url.hash)?.[1];
  if (key === undefined) return null;
  return { url: `${url.protocol}//${url.host}`, key: decodeURIComponent(key) };
}
