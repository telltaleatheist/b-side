import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { registerPlugin } from '@capacitor/core';

import type { LibraryView } from '@shared/types';

import { HubService, isNative } from './hub.service';

/** The iOS app's file store (mobile/ios/.../NativeFilePlugin.swift): Documents/bside-offline. */
interface NativeFilePlugin {
  /** Download `url` straight to disk as `name` (never through the bridge as base64). */
  download(options: { url: string; name: string }): Promise<{ url: string; bytes: number }>;
  list(): Promise<{ files: { name: string; url: string; bytes: number }[] }>;
  remove(options: { name: string }): Promise<void>;
  writeText(options: { name: string; text: string }): Promise<void>;
  readText(options: { name: string }): Promise<{ text: string | null }>;
}

const NativeFile = registerPlugin<NativeFilePlugin>('NativeFile');

/** What the phone keeps besides the audio: which playlists, and the last library it saw. */
const STATE_FILE = 'offline.json';

interface OfflineState {
  /** Playlist ids marked "keep on this phone". */
  readonly playlists: readonly string[];
  /** The library as the hub last sent it, so kept playlists open with no hub. */
  readonly library: LibraryView | null;
}

/** A song's file name on the phone: its id, with the extension AVPlayer reads the format from. */
function fileName(songId: string, file: string): string {
  return `${songId}${file.slice(file.lastIndexOf('.'))}`;
}

/**
 * "Keep on this phone" (Owen: "iOS can save for offline listening"). Only saved
 * playlists can be kept — the playing list is never stored on the phone, it
 * streams from the hub and the hub clears it FIFO.
 *
 * A kept playlist's songs are downloaded one at a time, only while the app is
 * in front and connected (the phone is not kept busy in the background — the
 * Bookshelf heat lesson), and a song no kept playlist holds any more is deleted
 * from the phone. The files on disk are the index: a song is on the phone when
 * its file is. The last library the hub sent is kept too, so with no hub in
 * reach the kept playlists still open and play.
 *
 * Desktop and browsers keep nothing (a browser cannot keep anything long term,
 * and the desktop IS the library): there this service is inert.
 */
@Injectable({ providedIn: 'root' })
export class OfflineService {
  private readonly hub = inject(HubService);

  /**
   * Keeping a computer's playlists on the phone. Not while the phone runs its own
   * hub: those songs are on the phone already, and this service's cleanup (files
   * no kept playlist wants) would read the phone's own library and delete what
   * was kept from the computer.
   */
  readonly available = isNative;
  private readonly standingDown = computed(() => this.hub.onPhone());
  readonly offered = computed(() => this.available && !this.standingDown());
  readonly kept = signal<ReadonlySet<string>>(new Set());
  /** Song id -> file:// URL, for every song on the phone. */
  readonly files = signal<ReadonlyMap<string, string>>(new Map());
  readonly busy = signal<string | null>(null);
  readonly problem = signal<string | null>(null);

  private ready = false;
  private syncing = false;

  /** Every song a kept playlist holds. */
  private readonly wanted = computed(() => {
    const kept = this.kept();
    const songs = new Map(this.hub.library().songs.map((song) => [song.id, song]));
    const wanted = new Map<string, string>();
    for (const playlist of this.hub.library().playlists) {
      if (!kept.has(playlist.id)) continue;
      for (const id of playlist.songs) {
        const song = songs.get(id);
        if (song !== undefined) wanted.set(id, song.file);
      }
    }
    return wanted;
  });

  constructor() {
    if (!this.available) return;
    void this.open();
    effect(() => {
      this.wanted();
      const live = this.hub.state() === 'live' && !this.standingDown();
      untracked(() => {
        if (live && this.ready) void this.sync();
      });
    });
  }

  /** The phone's copy of a saved song, or null to stream it from the hub. */
  urlOf(songId: string): string | null {
    if (this.standingDown()) return null;
    return this.files().get(songId) ?? null;
  }

  /** How many of a playlist's songs are on the phone. */
  countOn(songIds: readonly string[]): number {
    const files = this.files();
    return songIds.filter((id) => files.has(id)).length;
  }

  async keep(playlistId: string, keep: boolean): Promise<void> {
    const next = new Set(this.kept());
    if (keep) next.add(playlistId);
    else next.delete(playlistId);
    this.kept.set(next);
    await this.save();
  }

  private async open(): Promise<void> {
    try {
      const { text } = await NativeFile.readText({ name: STATE_FILE });
      if (text !== null) {
        const state = JSON.parse(text) as OfflineState;
        this.kept.set(new Set(state.playlists));
        // No hub yet (or none in reach): the kept playlists open from the last library seen.
        if (state.library !== null && !this.hub.loaded() && !this.standingDown()) this.hub.library.set(state.library);
      }
      await this.refreshFiles();
    } catch (error) {
      this.problem.set(`The phone's saved songs could not be read: ${String(error)}`);
    }
    this.ready = true;
    if (this.hub.state() === 'live' && !this.standingDown()) void this.sync();
  }

  private async refreshFiles(): Promise<void> {
    const { files } = await NativeFile.list();
    const map = new Map<string, string>();
    for (const file of files) {
      if (file.name === STATE_FILE) continue;
      map.set(file.name.slice(0, file.name.lastIndexOf('.')), file.url);
    }
    this.files.set(map);
  }

  private async save(): Promise<void> {
    // The library seen last is the COMPUTER's: never overwrite it with the phone's own.
    if (this.standingDown()) return;
    const state: OfflineState = { playlists: [...this.kept()], library: this.hub.loaded() ? this.hub.library() : null };
    await NativeFile.writeText({ name: STATE_FILE, text: JSON.stringify(state) });
  }

  /** Bring the phone in line with the kept playlists: fetch what is missing, delete what no kept playlist holds. */
  private async sync(): Promise<void> {
    if (this.syncing || this.standingDown()) return;
    this.syncing = true;
    try {
      await this.save();
      const wanted = this.wanted();
      for (const [id] of this.files()) {
        if (!wanted.has(id)) {
          const url = this.files().get(id) as string;
          await NativeFile.remove({ name: url.slice(url.lastIndexOf('/') + 1) });
        }
      }
      for (const [id, file] of wanted) {
        // Stop when the app leaves the front or the hub drops; the next sync resumes.
        if (this.hub.state() !== 'live' || this.standingDown() || document.visibilityState === 'hidden') break;
        if (this.files().has(id)) continue;
        this.busy.set(id);
        await NativeFile.download({ url: this.hub.audioUrl('songs', id), name: fileName(id, file) });
        await this.refreshFiles();
      }
      await this.refreshFiles();
      this.problem.set(null);
    } catch (error) {
      this.problem.set(`Saving songs to the phone stopped: ${String(error)}. It picks up again the next time the app connects.`);
    } finally {
      this.busy.set(null);
      this.syncing = false;
    }
  }
}
