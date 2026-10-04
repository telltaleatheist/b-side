import { computed, inject, Injectable } from '@angular/core';

import type { LibraryView, Outcome, Playlist, RefusalView, Song, Take } from '@shared/types';

import { desktop, HubService } from './hub.service';

/**
 * The playing list (this device's takes) and the library (saved songs in named
 * playlists), with every change the person can make to them. The hub answers a
 * library change with the whole new library, which is applied at once (the same
 * view also arrives on the event stream, for every other device).
 */
@Injectable({ providedIn: 'root' })
export class LibraryService {
  private readonly hub = inject(HubService);

  /** This device's playing list, oldest first: the order it plays in. */
  readonly takes = this.hub.takes;
  readonly songs = computed(() => this.hub.library().songs);
  readonly playlists = computed(() => this.hub.library().playlists);
  readonly problems = computed(() => this.hub.library().problems);
  readonly dir = computed(() => this.hub.library().dir);

  private readonly byId = computed(() => new Map(this.songs().map((song) => [song.id, song])));

  song(id: string): Song | null {
    return this.byId().get(id) ?? null;
  }

  playlist(id: string): Playlist | null {
    return this.playlists().find((playlist) => playlist.id === id) ?? null;
  }

  /** A playlist's songs in its order (a song whose sidecar went missing is left out, and listed as a problem). */
  songsOf(playlist: Playlist): Song[] {
    return playlist.songs.map((id) => this.song(id)).filter((song): song is Song => song !== null);
  }

  /** The playlists a song is in: the last one is the one that keeps it. */
  holding(songId: string): Playlist[] {
    return this.playlists().filter((playlist) => playlist.songs.includes(songId));
  }

  // ── the playing list ────────────────────────────────────────────────────────

  async removeTake(take: Take): Promise<RefusalView | null> {
    const outcome = await this.hub.call<null>('DELETE', `/api/takes/${encodeURIComponent(take.id)}`);
    return outcome.ok ? null : outcome.refusal;
  }

  async saveTake(take: Take, playlistId: string): Promise<RefusalView | null> {
    return this.changed(this.hub.call<LibraryView>('POST', `/api/playlists/${encodeURIComponent(playlistId)}/songs`, { takeId: take.id }));
  }

  // ── playlists ───────────────────────────────────────────────────────────────

  /** Make a playlist; answers it (found by name in the new library) or the refusal. */
  async createPlaylist(name: string): Promise<Playlist | RefusalView> {
    const outcome = await this.hub.call<LibraryView>('POST', '/api/playlists', { name });
    if (!outcome.ok) return outcome.refusal;
    this.hub.library.set(outcome.value);
    const made = outcome.value.playlists.find((playlist) => playlist.name === name.trim());
    if (made === undefined) return { code: 'playlist_missing', message: `The hub did not list ${name} after making it.` };
    return made;
  }

  renamePlaylist(id: string, name: string): Promise<RefusalView | null> {
    return this.changed(this.hub.call<LibraryView>('PATCH', `/api/playlists/${encodeURIComponent(id)}`, { name }));
  }

  reorder(id: string, songs: readonly string[]): Promise<RefusalView | null> {
    return this.changed(this.hub.call<LibraryView>('PATCH', `/api/playlists/${encodeURIComponent(id)}`, { songs }));
  }

  deletePlaylist(id: string): Promise<RefusalView | null> {
    return this.changed(this.hub.call<LibraryView>('DELETE', `/api/playlists/${encodeURIComponent(id)}`));
  }

  addSong(playlistId: string, songId: string): Promise<RefusalView | null> {
    return this.changed(this.hub.call<LibraryView>('POST', `/api/playlists/${encodeURIComponent(playlistId)}/songs`, { songId }));
  }

  removeSong(playlistId: string, songId: string): Promise<RefusalView | null> {
    return this.changed(this.hub.call<LibraryView>(
      'DELETE', `/api/playlists/${encodeURIComponent(playlistId)}/songs/${encodeURIComponent(songId)}`));
  }

  renameSong(id: string, title: string): Promise<RefusalView | null> {
    return this.changed(this.hub.call<LibraryView>('PATCH', `/api/songs/${encodeURIComponent(id)}`, { title }));
  }

  // ── the desktop's own acts ──────────────────────────────────────────────────

  async saveCopy(song: Song): Promise<RefusalView | null> {
    if (desktop === null) return null;
    const outcome = await desktop.saveCopy(song.id);
    return outcome.ok ? null : outcome.refusal;
  }

  async reveal(song: Song): Promise<RefusalView | null> {
    if (desktop === null) return null;
    const outcome = await desktop.reveal(song.id);
    return outcome.ok ? null : outcome.refusal;
  }

  private async changed(call: Promise<Outcome<LibraryView>>): Promise<RefusalView | null> {
    const outcome = await call;
    if (!outcome.ok) return outcome.refusal;
    this.hub.library.set(outcome.value);
    return null;
  }
}
