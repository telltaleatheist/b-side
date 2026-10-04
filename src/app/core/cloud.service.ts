import { computed, Injectable, inject, signal } from '@angular/core';

import { HUB_KEY_HEADER, type LibraryView, type Playlist, type RefusalView, type Song } from '@shared/types';

import { PHONE_LIBRARY } from '../phone/phone-paths';
import { HubService, isNative, type HubAddress } from './hub.service';

const STORED_CLOUD = 'bside.cloud';

export type CloudState = 'none' | 'loading' | 'ok' | 'unreachable' | 'key';

/** Where one album's save to the cloud has got. */
export interface CloudSave {
  readonly playlist: string;
  readonly done: number;
  readonly of: number;
}

/**
 * The phone's cloud: a B-Side computer it links to, as Bookshelf links to
 * BookForge (Owen, 2026-10-04: "the computer can act like a cloud ... you
 * download the albums, or you stream them").
 *
 * The phone makes songs itself (its own hub); the cloud is where albums go to
 * be kept. "Save to cloud" uploads an album natively (the audio never crosses
 * the WebView bridge) and, once the computer has filed it, removes the phone's
 * copy. Cloud albums stream from the computer, or download for offline
 * (OfflineService, which follows the cloud's library here).
 */
@Injectable({ providedIn: 'root' })
export class CloudService {
  private readonly hub = inject(HubService);

  readonly address = signal<HubAddress | null>(null);
  readonly library = signal<LibraryView | null>(null);
  readonly state = signal<CloudState>('none');
  readonly trouble = signal<string | null>(null);
  readonly saving = signal<CloudSave | null>(null);

  /** The computer's name as its address says it. */
  readonly host = computed(() => {
    const address = this.address();
    if (address === null) return null;
    try {
      return new URL(address.url).hostname;
    } catch {
      return address.url;
    }
  });
  /** The cloud is offered only to the phone running its own hub. */
  readonly available = computed(() => isNative && this.hub.onPhone());
  readonly linked = computed(() => this.available() && this.address() !== null);

  constructor() {
    try {
      const raw = localStorage.getItem(STORED_CLOUD);
      const parsed = raw === null ? null : (JSON.parse(raw) as HubAddress);
      if (parsed !== null && typeof parsed.url === 'string' && typeof parsed.key === 'string') this.address.set(parsed);
    } catch {
      // Not kept: the cloud is linked again from Settings.
    }
    if (this.linked()) void this.refresh();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.linked()) void this.refresh();
    });
  }

  link(address: HubAddress): void {
    const next = { url: address.url.trim().replace(/\/+$/, ''), key: address.key.trim() };
    try {
      localStorage.setItem(STORED_CLOUD, JSON.stringify(next));
    } catch {
      // Kept for this run only.
    }
    this.address.set(next);
    void this.refresh();
  }

  unlink(): void {
    try {
      localStorage.removeItem(STORED_CLOUD);
    } catch {
      // Nothing kept.
    }
    this.address.set(null);
    this.library.set(null);
    this.state.set('none');
  }

  /** Read the computer's library (on linking, on coming to the front, after a save). */
  async refresh(): Promise<void> {
    const outcome = await this.call<LibraryView>('GET', '/api/library');
    if (outcome.ok) {
      this.library.set(outcome.value);
      this.state.set('ok');
      this.trouble.set(null);
    }
  }

  audioUrl(songId: string): string {
    const address = this.address();
    return address === null ? '' : `${address.url}/api/songs/${encodeURIComponent(songId)}/audio?key=${encodeURIComponent(address.key)}`;
  }

  coverUrl(playlist: Playlist): string | null {
    const address = this.address();
    const cover = playlist.album?.cover ?? null;
    if (address === null || cover === null) return null;
    return `${address.url}/api/albums/${encodeURIComponent(playlist.id)}/cover?key=${encodeURIComponent(address.key)}&v=${encodeURIComponent(cover)}`;
  }

  playlist(id: string): Playlist | null {
    return this.library()?.playlists.find((playlist) => playlist.id === id) ?? null;
  }

  songsOf(playlist: Playlist): Song[] {
    const songs = new Map((this.library()?.songs ?? []).map((song) => [song.id, song]));
    return playlist.songs.map((id) => songs.get(id)).filter((song): song is Song => song !== undefined);
  }

  /**
   * Save one of the phone's albums to the cloud: each song's audio and the
   * cover (uploaded natively, from disk), then the album that names them; once
   * the computer has filed it, the phone's copy is deleted.
   */
  async saveAlbum(playlist: Playlist, songs: readonly Song[]): Promise<RefusalView | null> {
    const address = this.address();
    if (address === null) return { code: 'no_cloud', message: 'Link a B-Side computer in Settings first.' };
    if (playlist.album === undefined) return { code: 'not_an_album', message: 'Only albums are saved to the cloud.' };
    const { NativeDisk } = await import('../phone/native-disk');
    const headers = { [HUB_KEY_HEADER]: address.key };
    const files = [...songs.map((song) => song.file), ...(playlist.album.cover === null ? [] : [playlist.album.cover])];
    this.saving.set({ playlist: playlist.id, done: 0, of: files.length + 1 });
    try {
      for (const [at, file] of files.entries()) {
        await NativeDisk.upload({ url: `${address.url}/api/import/files/${encodeURIComponent(file)}`, path: `${PHONE_LIBRARY}/${file}`, headers });
        this.saving.set({ playlist: playlist.id, done: at + 1, of: files.length + 1 });
      }
      // Each song's own sidecar, as the phone keeps it: the computer files exactly what the phone had.
      const sidecars: unknown[] = [];
      for (const song of songs) {
        const { text } = await NativeDisk.readText({ path: `${PHONE_LIBRARY}/${song.id}.json` });
        if (text === null) return { code: 'song_missing', message: `${song.title} is no longer on the phone.` };
        sidecars.push(JSON.parse(text));
      }
      const filed = await this.call<LibraryView>('POST', '/api/import/albums', {
        id: playlist.id,
        name: playlist.name,
        createdAt: playlist.createdAt,
        album: { ...playlist.album, cloud: null },
        songs: sidecars,
      });
      if (!filed.ok) return filed.refusal;
      this.library.set(filed.value);
      const removed = await this.hub.call<LibraryView>('DELETE', `/api/playlists/${encodeURIComponent(playlist.id)}`);
      return removed.ok ? null : removed.refusal;
    } catch (error) {
      const { code, message } = error as { code?: string; message?: string };
      return { code: code ?? 'upload_failed', message: `Saving to ${this.host()} stopped: ${message ?? String(error)}. Nothing was removed from the phone; save it again.` };
    } finally {
      this.saving.set(null);
    }
  }

  /** Delete an album or playlist from the cloud (the computer's library). */
  async remove(playlistId: string): Promise<RefusalView | null> {
    const outcome = await this.call<LibraryView>('DELETE', `/api/playlists/${encodeURIComponent(playlistId)}`);
    if (outcome.ok) this.library.set(outcome.value);
    return outcome.ok ? null : outcome.refusal;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ ok: true; value: T } | { ok: false; refusal: RefusalView }> {
    const address = this.address();
    if (address === null) return { ok: false, refusal: { code: 'no_cloud', message: 'No B-Side computer is linked.' } };
    if (method === 'GET') this.state.set(this.state() === 'ok' ? 'ok' : 'loading');
    const headers: Record<string, string> = { [HUB_KEY_HEADER]: address.key, 'X-BSide-Client': this.hub.client, 'X-BSide-Client-Kind': 'ios' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(`${address.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      this.state.set('unreachable');
      this.trouble.set(`${this.host()} is not answering (is B-Side running there, with sharing on?)`);
      return { ok: false, refusal: { code: 'cloud_unreachable', message: this.trouble() as string } };
    }
    const parsed = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      if (response.status === 401) this.state.set('key');
      const error = (parsed as { error?: RefusalView } | null)?.error;
      return { ok: false, refusal: error ?? { code: `http_${response.status}`, message: `${this.host()} answered HTTP ${response.status}.` } };
    }
    return { ok: true, value: parsed as T };
  }
}
