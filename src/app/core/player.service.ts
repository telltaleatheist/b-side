import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';

import { songUrl, type Song } from '@shared/types';

import { JobsService } from './jobs.service';
import { LibraryService } from './library.service';

/**
 * The one player, in the order the queue lists songs (oldest first), with the
 * Crucible playground's rules:
 *
 *  - a song a job just finished plays at once when the player is idle (nothing
 *    loaded) or waiting (the last song ended with nothing after it);
 *  - at the end of a song it moves to the next finished one; when there is none
 *    yet it waits, and plays the next one the moment it lands;
 *  - previous restarts the song when more than 3 s in (or at the first song).
 */
@Injectable({ providedIn: 'root' })
export class PlayerService {
  private readonly library = inject(LibraryService);
  private readonly jobs = inject(JobsService);

  readonly audio = new Audio();
  readonly current = signal<Song | null>(null);
  readonly waiting = signal(false);
  readonly paused = signal(true);
  readonly time = signal(0);
  readonly duration = signal(0);

  private readonly index = computed(() => {
    const current = this.current();
    return current === null ? -1 : this.library.songs().findIndex((song) => song.id === current.id);
  });
  readonly hasPrevious = computed(() => this.current() !== null);
  /** Next is offered while there is a song after this one, or one still generating to wait for. */
  readonly hasNext = computed(
    () => this.current() !== null && (this.index() < this.library.songs().length - 1 || this.jobs.generating()),
  );

  constructor() {
    this.audio.preload = 'auto';
    const sync = (): void => {
      this.paused.set(this.audio.paused);
      this.time.set(this.audio.currentTime);
      this.duration.set(Number.isFinite(this.audio.duration) ? this.audio.duration : 0);
    };
    for (const name of ['timeupdate', 'play', 'pause', 'loadedmetadata', 'durationchange', 'emptied']) {
      this.audio.addEventListener(name, sync);
    }
    this.audio.addEventListener('ended', () => this.step(1));
    // A rename shows in the bar; a delete of the playing song stops it.
    effect(() => {
      this.library.songs();
      untracked(() => this.refresh());
    });
    this.library.onLanded((song) => {
      if (this.current() === null || this.waiting()) this.play(song);
    });
  }

  play(song: Song): void {
    this.current.set(song);
    this.waiting.set(false);
    this.audio.src = songUrl(song);
    this.audio.play().catch((error: unknown) => {
      // A load that fails leaves the player paused on it; the play button tries again.
      console.error('[player] could not play', song.file, error);
    });
  }

  toggle(): void {
    if (this.current() === null) return;
    if (this.audio.paused) void this.audio.play();
    else this.audio.pause();
  }

  seek(seconds: number): void {
    this.audio.currentTime = seconds;
  }

  previous(): void {
    if (this.audio.currentTime > 3 || this.index() <= 0) {
      this.audio.currentTime = 0;
      return;
    }
    this.step(-1);
  }

  next(): void {
    this.step(1);
  }

  private refresh(): void {
    const current = this.current();
    if (current === null) return;
    const found = this.library.songs().find((song) => song.id === current.id);
    if (found === undefined) this.stop();
    else this.current.set(found);
  }

  stop(): void {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.current.set(null);
    this.waiting.set(false);
  }

  private step(direction: 1 | -1): void {
    const songs = this.library.songs();
    if (songs.length === 0) return;
    const next = songs[this.index() + direction];
    if (next !== undefined) {
      this.play(next);
    } else if (direction > 0) {
      // Nothing after it yet: the next song to land plays the moment it does.
      this.waiting.set(true);
    }
  }
}
