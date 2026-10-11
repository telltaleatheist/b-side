import { computed, inject, Injectable, signal } from '@angular/core';

import { coverOf, HUB_KEY_HEADER, type HubInfo, type HubSettingsView, type JobView, type LibraryView, type PeerIntroduction, type Playlist, type Song } from '@shared/types';

import { albumJobKey, HubService, isNative, parseHubLink, STOCK_COVER } from './hub.service';
import { hearPairLinks, readPairLink } from './pairing';

const STORED_PEERS = 'bside.peers';
/** How often a library that is listed (or not) is looked at again. */
const LOOK_EVERY_MS = 30_000;
/** How often, while one of them is making an album: its progress bar moves. */
const LOOK_WHILE_MAKING_MS = 5_000;
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
  /** Its album tracks on a server now, by "<album>:<track>" (read only while it is making an album). */
  readonly albumJobs: ReadonlyMap<string, JobView>;
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
  /** Libraries that added this one and offer theirs back (only the desktop's own window sees them). */
  readonly offered = signal<readonly PeerIntroduction[]>([]);
  /** Whether this window can offer its library back: the desktop, whose hub others can reach. */
  readonly canShareBack = this.hub.kind === 'desktop';
  /** What the last scanned pairing code did (shown until dismissed). */
  readonly pairNote = signal<string | null>(null);

  constructor() {
    let stored: StoredPeer[] = [];
    try {
      stored = JSON.parse(localStorage.getItem(STORED_PEERS) ?? '[]') as StoredPeer[];
    } catch {
      stored = [];
    }
    this.peers.set(stored.filter((peer) => typeof peer.url === 'string').map((peer) => this.fresh(peer)));
    void this.lookAgain();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.lookAll();
    });
    if (isNative) hearPairLinks((link) => void this.pair(link).then((note) => this.pairNote.set(note)));
  }

  /**
   * A desktop's pairing code, scanned: a phone with no B-Sides yet connects to it;
   * one that has its own (a computer, or the phone's own) lists it as another library.
   */
  async pair(text: string): Promise<string> {
    const target = readPairLink(text);
    if (target === null) return 'That is not a B-Sides pairing code.';
    const address = parseHubLink(target.link);
    if (address === null) return 'That pairing code holds no address.';
    const name = target.hostname?.replace(/\.local$/i, '') ?? new URL(address.url).hostname;
    const state = this.hub.state();
    if (state === 'no-hub' || state === 'key') {
      this.hub.useHub(address);
      return `Connected to ${name}.`;
    }
    const own = this.hub.address();
    if (!this.hub.onPhone() && (own?.url === address.url || sameHost(this.hub.info()?.hostname, target.hostname))) {
      return `This phone already uses ${name}'s B-Sides.`;
    }
    const why = await this.add(target.link, '', false, target.hostname);
    if (why === null) return `${name}'s library is added: it shows in your Library.`;
    if (why === 'That library is already added.') return `${name}'s library is already in your Library.`;
    return why;
  }

  /** Add a library by its address ("192.168.68.50"); answers why not, or null. */
  async add(text: string, label: string, shareBack = false, hostname: string | null = null): Promise<string | null> {
    const address = parseHubLink(text);
    if (address === null) return 'That is not an address: type one like 192.168.68.50 or victorias-laptop.local';
    if (this.peers().some((peer) => peer.url === address.url)) return 'That library is already added.';
    const own = this.hub.address()?.url;
    if (own !== undefined && own === address.url) return 'That is this B-Sides itself.';
    if (hostname !== null && this.peers().some((peer) => sameHost(peer.hostname, hostname))) return 'That library is already added.';
    const peer = this.fresh({ url: address.url, key: address.key, label: label.trim() || null, hostname });
    this.peers.update((peers) => [...peers, peer]);
    this.store();
    await this.look(peer.url);
    const now = this.peers().find((other) => other.url === peer.url);
    if (now === undefined) {
      const same = this.peers().find((other) => sameHost(other.hostname, this.lastDuplicate));
      return `That is ${same === undefined ? 'a library' : this.name(same)} again, already added.`;
    }
    if (now.state !== 'ok') return `${address.url} is not answering now. It stays added, and shows up whenever it answers (is B-Sides running there, with sharing on?).`;
    if (shareBack && this.canShareBack) {
      const shared = await this.introduceTo(now);
      if (!shared) return `Added. ${this.name(now)} could not be offered your library back; it can add yours by this computer's address.`;
    }
    return null;
  }

  /** Add a library that offered itself, and stop offering it. */
  async accept(offer: PeerIntroduction): Promise<string | null> {
    const why = await this.add(offer.url, offer.name ?? '', false, offer.hostname);
    if (why === null || why === 'That library is already added.') await this.dismiss(offer);
    return why === 'That library is already added.' ? null : why;
  }

  async dismiss(offer: PeerIntroduction): Promise<void> {
    const outcome = await this.hub.call<PeerIntroduction[]>('DELETE', `/api/peers/introductions/${encodeURIComponent(offer.hostname)}`);
    if (outcome.ok) this.offered.set(outcome.value);
  }

  /** Offer this computer's library to a peer: it hears this computer's name and port, and adds it with one press. */
  private async introduceTo(peer: Peer): Promise<boolean> {
    const [settings, info] = await Promise.all([
      this.hub.call<HubSettingsView>('GET', '/api/settings'),
      this.hub.call<HubInfo>('GET', '/api/info'),
    ]);
    if (!settings.ok || !info.ok || !settings.value.sharing) return false;
    const link = settings.value.links[0];
    const key = settings.value.requireKey && link !== undefined ? (parseHubLink(link)?.key ?? '') : '';
    try {
      const response = await fetch(`${peer.url}/api/peers/introduce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [HUB_KEY_HEADER]: peer.key },
        body: JSON.stringify({ hostname: info.value.hostname, port: settings.value.port, key }),
        signal: AbortSignal.timeout(ANSWER_WITHIN_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async readOffers(): Promise<void> {
    if (!this.canShareBack) return;
    const outcome = await this.hub.call<PeerIntroduction[]>('GET', '/api/peers/introductions');
    // Already added (by name): not offered again.
    if (outcome.ok) this.offered.set(outcome.value.filter((offer) => !this.peers().some((peer) => sameHost(peer.hostname, offer.hostname))));
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

  /** An album track being made in that library now, or null. */
  albumJob(peerKey: string, playlistId: string, track: number): JobView | null {
    return this.byId(peerKey)?.albumJobs.get(`${playlistId}:${track}`) ?? null;
  }

  audioUrl(peerKey: string, songId: string): string {
    const peer = this.byId(peerKey);
    return peer === null ? '' : `${peer.url}/api/songs/${encodeURIComponent(songId)}/audio?key=${encodeURIComponent(peer.key)}`;
  }

  coverUrl(peerKey: string, playlist: Playlist): string {
    const peer = this.byId(peerKey);
    const cover = coverOf(playlist);
    if (peer === null || cover === null) return STOCK_COVER;
    return `${peer.url}/api/albums/${encodeURIComponent(playlist.id)}/cover?key=${encodeURIComponent(peer.key)}&v=${encodeURIComponent(cover)}`;
  }

  /** Look at every library, then again soon while one is making an album, else in a while. */
  private async lookAgain(): Promise<void> {
    await this.lookAll();
    const making = this.present().some((peer) => peer.library !== null && makingAlbum(peer.library));
    setTimeout(() => void this.lookAgain(), making ? LOOK_WHILE_MAKING_MS : LOOK_EVERY_MS);
  }

  /** Look at every added library again. */
  async lookAll(): Promise<void> {
    await Promise.all(this.peers().map((peer) => this.look(peer.url)));
    await this.readOffers();
  }

  /** The computer name of the last library dropped as a second entry for one already added. */
  private lastDuplicate: string | null = null;

  /**
   * One computer added twice (by its address and by its name, Victoria 2026-10-11)
   * is listed once: the entry added first stays, and takes the other's name for it if it had none.
   */
  private dedupe(): void {
    const peers = this.peers();
    const kept: Peer[] = [];
    for (const peer of peers) {
      const first = peer.hostname === null ? -1 : kept.findIndex((other) => sameHost(other.hostname, peer.hostname));
      if (first === -1) {
        kept.push(peer);
        continue;
      }
      this.lastDuplicate = peer.hostname;
      const other = kept[first] as Peer;
      kept[first] = { ...other, label: other.label ?? peer.label, ...(other.state !== 'ok' && peer.state === 'ok' ? { url: peer.url, key: peer.key, state: peer.state, library: peer.library } : {}) };
    }
    if (kept.length !== peers.length) {
      this.peers.set(kept);
      this.store();
    }
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
    // While it is making an album, each track's progress too (a hub without that list yet answers nothing: no bars).
    const jobs = library !== null && makingAlbum(library) ? await this.get<JobView[]>(at, '/api/albums/jobs') : null;
    this.peers.update((peers) => peers.map((other) => other.url !== url ? other : {
      ...other,
      url: library !== null ? at.url : other.url,
      state: library === null ? 'away' : 'ok',
      library: library ?? other.library,
      hostname: info?.hostname ?? other.hostname,
      albumJobs: new Map((jobs ?? []).map((job) => [albumJobKey(job), job])),
    }));
    if (at.url !== url || (info !== null && info.hostname !== peer.hostname)) this.store();
    this.dedupe();
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
    return { url: stored.url, key: stored.key ?? '', label: stored.label ?? null, state: 'looking', hostname: stored.hostname ?? null, library: null, albumJobs: new Map() };
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

/** Whether a library is making an album now (not stopped or interrupted). */
function makingAlbum(library: LibraryView): boolean {
  return library.playlists.some((playlist) => {
    const album = playlist.album;
    return album != null && album.working !== false && ['planning', 'cover', 'making'].includes(album.stage);
  });
}

function sameHost(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const bare = (name: string): string => name.toLowerCase().replace(/\.local$/, '');
  return bare(a) === bare(b);
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

