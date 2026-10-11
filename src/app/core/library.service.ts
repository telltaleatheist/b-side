import { computed, inject, Injectable } from '@angular/core';

import type { Folder, LibraryView, Outcome, Playlist, RefusalView, Song, Take } from '@shared/types';

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
  /** The folders albums and playlists are grouped in (none from a hub before folders). */
  readonly folders = computed<readonly Folder[]>(() => this.hub.library().folders ?? []);
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

  // ── folders: albums and playlists grouped (Victoria, 2026-10-11) ────────────
  // At each level the folders come first, each list in the library's own order.

  folder(id: string): Folder | null {
    return this.folders().find((folder) => folder.id === id) ?? null;
  }

  /** The folders directly inside `parent` (null: the top of the library), in order. */
  foldersIn(parent: string | null): Folder[] {
    return this.folders().filter((folder) => folder.parent === parent);
  }

  /** The albums and playlists directly inside `folder` (null: the top of the library), in order. */
  playlistsIn(folder: string | null): Playlist[] {
    return this.playlists().filter((playlist) => (playlist.folder ?? null) === folder);
  }

  /** Every album and playlist in a folder and the folders inside it, top to bottom as shown: what Play folder plays. */
  playlistsUnder(id: string): Playlist[] {
    return [...this.foldersIn(id).flatMap((folder) => this.playlistsUnder(folder.id)), ...this.playlistsIn(id)];
  }

  /** Every folder top to bottom as shown, with how deep it sits (0 at the top) and its path, for pickers. */
  readonly folderRows = computed(() => {
    const rows: { readonly folder: Folder; readonly depth: number; readonly path: string }[] = [];
    const walk = (parent: string | null, depth: number, path: string): void => {
      for (const folder of this.foldersIn(parent)) {
        const here = path === '' ? folder.name : `${path} / ${folder.name}`;
        rows.push({ folder, depth, path: here });
        walk(folder.id, depth + 1, here);
      }
    };
    walk(null, 0, '');
    return rows;
  });

  /** Make a folder (inside `parent`); answers it, found in the new library, or the refusal. */
  async createFolder(name: string, parent: string | null = null): Promise<Folder | RefusalView> {
    const before = new Set(this.folders().map((folder) => folder.id));
    const outcome = await this.hub.call<LibraryView>('POST', '/api/folders', { name, parent });
    if (!outcome.ok) return outcome.refusal;
    this.hub.library.set(outcome.value);
    const made = (outcome.value.folders ?? []).find((folder) => !before.has(folder.id) && folder.name === name.trim());
    if (made === undefined) return { code: 'folder_missing', message: `The hub did not list ${name} after making it.` };
    return made;
  }

  renameFolder(id: string, name: string): Promise<RefusalView | null> {
    return this.changed(this.hub.call<LibraryView>('PATCH', `/api/folders/${encodeURIComponent(id)}`, { name }));
  }

  /** Delete a folder; what was in it moves up a level. */
  deleteFolder(id: string): Promise<RefusalView | null> {
    return this.changed(this.hub.call<LibraryView>('DELETE', `/api/folders/${encodeURIComponent(id)}`));
  }

  /** Move a folder into `parent` (null: the top), before the folder `before` there, or last. */
  moveFolder(id: string, parent: string | null, before: string | null = null): Promise<RefusalView | null> {
    return this.changed(this.hub.call<LibraryView>('PATCH', `/api/folders/${encodeURIComponent(id)}`, { parent, before }));
  }

  /** File an album or playlist in `folder` (null: the top), before the playlist `before` there, or last. */
  movePlaylist(id: string, folder: string | null, before: string | null = null): Promise<RefusalView | null> {
    return this.changed(this.hub.call<LibraryView>('PATCH', `/api/playlists/${encodeURIComponent(id)}`, { folder, before }));
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

  /** Whether this device can save files itself (the desktop app): album downloads. */
  readonly canSave = desktop !== null;

  async saveAlbum(playlistId: string): Promise<RefusalView | null> {
    if (desktop === null) return null;
    const outcome = await desktop.saveAlbum(playlistId);
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
