import { computed, inject, Injectable, signal } from '@angular/core';

import { HUB_KEY_HEADER, type HubInfo, type LibraryView, type Playlist, type Song } from '@shared/types';

import { HubService, parseHubLink, STOCK_COVER } from './hub.service';

const STORED_PEERS = 'bside.peers';
/** How often a library that is listed (or not) is looked at again. */
const LOOK_EVERY_MS = 30_000;
/** A library that does not answer in this long is not on the network now. */
const ANSWER_WITHIN_MS = 4_000;

/** Another B-Sides library added by address, as it was last seen. */
export interface Peer {
  /** The address as kept (`http://192.168.68.50:7300`); its host is the peer's id in routes. */
  readonly url: string;
  /** What the person called it when adding it; else the computer's own name. */
  readonly label: string | null;
  readonly key: string;
  readonly state: 'looking' | 'ok' | 'away';
  /** The computer's name, from its hub. */
  readonly hostname: string | null;
  readonly library: LibraryView | null;
}

interface StoredPeer {
  readonly url: string;
  readonly key: string;
  readonly label: string | null;
  /** The computer's own name, once it has answered: found again by it (`<name>.local`) when its address changes. */
  readonly hostname?: string | null;
}

/**
 * Other B-Sides libraries on the network (Owen, 2026-10-09: "I add her library
 * by IP, it lists all of her songs"). Nothing is copied: each library stays on
 * its own computer, and is read and played from there. One that does not answer
 * (the laptop off, or away from home) is simply not listed until it does.
 *
 * Home routers hand out addresses that move (Victoria's laptop went from .52
 * to .64, 2026-10-10). So each library's computer name is kept once it has
 * answered, and when its address stops answering it is looked for by that
 * name (`desktop-ot9rumi.local`, which macOS, iOS and Windows all answer);
 * found there, its address becomes the name, which follows it from then on.
 */
@Injectable({ providedIn: 'root' })
export class PeersService {
  private readonly hub = inject(HubService);

  readonly peers = signal<readonly Peer[]>([]);
  /** The libraries answering now: the ones the Library lists. */
  readonly present = computed(() => this.peers().filter((peer) => peer.state === 'ok' && peer.library !== null));

  constructor() {
    let stored: StoredPeer[] = [];
    try {
      stored = JSON.parse(localStorage.getItem(STORED_PEERS) ?? '[]') as StoredPeer[];
    } catch {
      stored = [];
    }
    this.peers.set(stored.filter((peer) => typeof peer.url === 'string').map((peer) => this.fresh(peer)));
    void this.lookAll();
    setInterval(() => void this.lookAll(), LOOK_EVERY_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.lookAll();
    });
  }

  /** Add a library by its address ("192.168.68.50"); answers why not, or null. */
  async add(text: string, label: string): Promise<string | null> {
    const address = parseHubLink(text);
    if (address === null) return 'That is not an address: type one like 192.168.68.50 or victorias-laptop.local';
    if (this.peers().some((peer) => peer.url === address.url)) return 'That library is already added.';
    const own = this.hub.address()?.url;
    if (own !== undefined && own === address.url) return 'That is this B-Sides itself.';
    const peer = this.fresh({ url: address.url, key: address.key, label: label.trim() || null });
    this.peers.update((peers) => [...peers, peer]);
    this.store();
    await this.look(peer.url);
    const now = this.peers().find((other) => other.url === peer.url);
    return now?.state === 'ok' ? null : `${address.url} is not answering now. It stays added, and shows up whenever it answers (is B-Sides running there, with sharing on?).`;
  }

  remove(url: string): void {
    this.peers.update((peers) => peers.filter((peer) => peer.url !== url));
    this.store();
  }

  /** A peer by the id routes carry (its address's host). */
  byId(id: string): Peer | null {
    return this.peers().find((peer) => peerId(peer) === id) ?? null;
  }

  name(peer: Peer): string {
    return peer.label ?? (peer.hostname ? peer.hostname.replace(/\.(local|lan|home)$/i, '') : new URL(peer.url).hostname);
  }

  playlist(peerKey: string, playlistId: string): Playlist | null {
    return this.byId(peerKey)?.library?.playlists.find((playlist) => playlist.id === playlistId) ?? null;
  }

  songsOf(peerKey: string, playlist: Playlist): Song[] {
    const songs = new Map((this.byId(peerKey)?.library?.songs ?? []).map((song) => [song.id, song]));
    return playlist.songs.map((id) => songs.get(id)).filter((song): song is Song => song !== undefined);
  }

  audioUrl(peerKey: string, songId: string): string {
    const peer = this.byId(peerKey);
    return peer === null ? '' : `${peer.url}/api/songs/${encodeURIComponent(songId)}/audio?key=${encodeURIComponent(peer.key)}`;
  }

  coverUrl(peerKey: string, playlist: Playlist): string {
    const peer = this.byId(peerKey);
    const cover = playlist.album?.cover ?? null;
    if (peer === null || cover === null) return STOCK_COVER;
    return `${peer.url}/api/albums/${encodeURIComponent(playlist.id)}/cover?key=${encodeURIComponent(peer.key)}&v=${encodeURIComponent(cover)}`;
  }

  /** Look at every added library again. */
  async lookAll(): Promise<void> {
    await Promise.all(this.peers().map((peer) => this.look(peer.url)));
  }

  private async look(url: string): Promise<void> {
    const peer = this.peers().find((other) => other.url === url);
    if (peer === undefined) return;
    let at = peer;
    let [library, info] = await Promise.all([this.get<LibraryView>(at, '/api/library'), this.get<HubInfo>(at, '/api/info')]);
    // Not at its address: look for it by its computer's name, and keep that if it is the same library.
    if (library === null && peer.hostname) {
      const byName = { ...peer, url: nameUrl(peer.url, peer.hostname) };
      if (byName.url !== peer.url) {
        const found = await this.get<HubInfo>(byName, '/api/info');
        if (found !== null && found.hostname.toLowerCase() === peer.hostname.toLowerCase()) {
          at = byName;
          [library, info] = [await this.get<LibraryView>(at, '/api/library'), found];
        }
      }
    }
    this.peers.update((peers) => peers.map((other) => other.url !== url ? other : {
      ...other,
      url: library !== null ? at.url : other.url,
      state: library === null ? 'away' : 'ok',
      library: library ?? other.library,
      hostname: info?.hostname ?? other.hostname,
    }));
    if (at.url !== url || (info !== null && info.hostname !== peer.hostname)) this.store();
  }

  private async get<T>(peer: Peer, path: string): Promise<T | null> {
    try {
      const response = await fetch(`${peer.url}${path}`, {
        headers: { [HUB_KEY_HEADER]: peer.key, 'X-BSide-Client': this.hub.client, 'X-BSide-Client-Kind': 'web' },
        signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
      });
      return response.ok ? ((await response.json()) as T) : null;
    } catch {
      return null;
    }
  }

  private fresh(stored: StoredPeer): Peer {
    return { url: stored.url, key: stored.key ?? '', label: stored.label ?? null, state: 'looking', hostname: stored.hostname ?? null, library: null };
  }

  private store(): void {
    try {
      const stored: StoredPeer[] = this.peers().map(({ url, key, label, hostname }) => ({ url, key, label, hostname }));
      localStorage.setItem(STORED_PEERS, JSON.stringify(stored));
    } catch {
      // Kept for this run only.
    }
  }
}

/** Where a computer answers by its own name on the home network: `http://<name>.local:<port>`. */
export function nameUrl(url: string, hostname: string): string {
  const at = new URL(url);
  const name = hostname.toLowerCase().replace(/\.local$/, '');
  return `${at.protocol}//${name}.local${at.port === '' ? '' : `:${at.port}`}`;
}

/** The id a peer goes by in routes: its address's host and port. */
export function peerId(peer: { readonly url: string }): string {
  return new URL(peer.url).host;
}

