import { Injectable, signal } from '@angular/core';

import type { LibraryView, RefusalView, Song } from '@shared/types';

import { api } from './bside';

/** The songs on disk, oldest first — the order they play in. */
@Injectable({ providedIn: 'root' })
export class LibraryService {
  readonly songs = signal<Song[]>([]);
  readonly dir = signal<string>('');
  readonly problems = signal<string[]>([]);

  private readonly landedListeners: ((song: Song) => void)[] = [];

  constructor() {
    if (api === null) return;
    void api.library.list().then((view) => this.apply(view));
    api.library.onChanged((view) => this.apply(view));
    api.library.onAdded((song) => {
      if (!this.songs().some((other) => other.id === song.id)) this.songs.update((songs) => [...songs, song]);
      for (const listener of this.landedListeners) listener(song);
    });
  }

  /** Hear each song a job just finished, after it is in `songs`. */
  onLanded(listener: (song: Song) => void): void {
    this.landedListeners.push(listener);
  }

  async rename(id: string, title: string): Promise<RefusalView | null> {
    if (api === null) return null;
    const outcome = await api.library.rename(id, title);
    if (!outcome.ok) return outcome.refusal;
    this.songs.update((songs) => songs.map((song) => (song.id === id ? outcome.value : song)));
    return null;
  }

  async remove(id: string): Promise<RefusalView | null> {
    if (api === null) return null;
    const outcome = await api.library.remove(id);
    if (!outcome.ok) return outcome.refusal;
    this.songs.update((songs) => songs.filter((song) => song.id !== id));
    return null;
  }

  private apply(view: LibraryView): void {
    this.songs.set([...view.songs]);
    this.dir.set(view.dir);
    this.problems.set([...view.problems]);
  }
}
