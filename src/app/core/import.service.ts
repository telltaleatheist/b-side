import { computed, inject, Injectable, signal } from '@angular/core';

import { SINGLES_NAME, type LibraryView, type RefusalView } from '@shared/types';

import { HubService } from './hub.service';
import { LibraryService } from './library.service';

/** The audio B-Sides keeps; anything else dropped is said, not filed. */
const KEPT = /\.(flac|wav|mp3)$/i;

/** Where a drop of songs has got, for the line the window shows. */
export interface ImportState {
  readonly into: string;
  readonly done: number;
  readonly of: number;
  readonly finished: boolean;
  readonly problems: readonly string[];
}

/**
 * Songs dragged onto the window (Owen, 2026-10-08): dropped on a playlist (its
 * page, its Library tile, its sidebar row) they join it; dropped anywhere
 * else they join New Songs. Each file is sent to the hub as it is, with a
 * title from its name and its length as the browser reads it.
 */
@Injectable({ providedIn: 'root' })
export class ImportService {
  private readonly hub = inject(HubService);
  private readonly library = inject(LibraryService);

  readonly state = signal<ImportState | null>(null);
  readonly busy = computed(() => this.state()?.finished === false);
  /** Only a hub on a computer takes files (the phone's own hub has no upload door). */
  readonly offered = computed(() => !this.hub.onPhone());

  async importFiles(files: readonly File[], playlistId: string | null): Promise<void> {
    if (files.length === 0 || this.busy()) return;
    const into = playlistId === null ? SINGLES_NAME : (this.library.playlist(playlistId)?.name ?? SINGLES_NAME);
    const problems: string[] = [];
    const kept = files.filter((file) => {
      if (KEPT.test(file.name)) return true;
      problems.push(`${file.name}: B-Sides keeps flac, wav or mp3 audio.`);
      return false;
    });
    let done = 0;
    const show = (finished: boolean): void => this.state.set({ into, done, of: kept.length, finished, problems: [...problems] });
    show(kept.length === 0);
    for (const file of kept) {
      const duration = await durationOf(file);
      const query = new URLSearchParams({ name: file.name, title: titleOf(file.name) });
      if (duration !== null) query.set('duration', String(duration));
      if (playlistId !== null) query.set('playlist', playlistId);
      const outcome = await this.hub.upload<LibraryView>(`/api/import/song?${query.toString()}`, file);
      if (outcome.ok) {
        this.hub.library.set(outcome.value);
        done += 1;
      } else {
        problems.push(`${file.name}: ${refusalText(outcome.refusal)}`);
      }
      show(false);
    }
    show(true);
  }

  dismiss(): void {
    this.state.set(null);
  }
}

/** "oh-banana_soul ballad.flac" reads as "Oh Banana Soul Ballad". */
export function titleOf(name: string): string {
  const bare = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return bare.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase()) || name;
}

/** The file's length as the browser's own decoder reads it; null when it cannot. */
function durationOf(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (value: number | null): void => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => done(null);
    setTimeout(() => done(null), 10_000);
    audio.src = url;
  });
}

function refusalText(refusal: RefusalView): string {
  return refusal.message;
}
