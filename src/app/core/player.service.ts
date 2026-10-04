import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';

import type { Song, Take } from '@shared/types';

import { HubService } from './hub.service';
import { JobsService } from './jobs.service';
import { LibraryService } from './library.service';

/** What the player plays from: this device's playing list, or one saved playlist. */
export type PlaySource = { readonly kind: 'takes' } | { readonly kind: 'playlist'; readonly id: string };

/** One thing the player can play, whichever list it came from. */
export interface PlayItem {
  /** `take:<id>` or `song:<id>`: unique across both lists. */
  readonly key: string;
  readonly kind: 'take' | 'song';
  readonly id: string;
  readonly title: string;
  readonly tags: string | null;
  readonly durationS: number | null;
}

function itemOfTake(take: Take): PlayItem {
  return { key: `take:${take.id}`, kind: 'take', id: take.id, title: take.title, tags: take.params.tags, durationS: take.durationS };
}

function itemOfSong(song: Song): PlayItem {
  return { key: `song:${song.id}`, kind: 'song', id: song.id, title: song.title, tags: song.params.tags, durationS: song.durationS };
}

/**
 * The one player, playing through the list it was started from, with the
 * Crucible playground's rules on the playing list:
 *
 *  - a take that just landed plays at once when the player is idle (nothing
 *    loaded) or waiting (the last take ended with nothing after it);
 *  - at the end of a song it moves to the next one; on the playing list, when
 *    there is none yet but a song is generating, it waits for it;
 *  - previous restarts the song when more than 3 s in (or at the first song).
 *
 * The `<audio>` element lives in the DOM (iOS Safari will not play one that is
 * not), and the lock screen / media keys drive it through the Media Session API.
 */
@Injectable({ providedIn: 'root' })
export class PlayerService {
  private readonly hub = inject(HubService);
  private readonly library = inject(LibraryService);
  private readonly jobs = inject(JobsService);

  readonly audio = document.createElement('audio');
  readonly source = signal<PlaySource>({ kind: 'takes' });
  readonly current = signal<PlayItem | null>(null);
  readonly waiting = signal(false);
  readonly paused = signal(true);
  readonly time = signal(0);
  readonly duration = signal(0);
  /** Why the current song would not play, when it would not. */
  readonly problem = signal<string | null>(null);

  /** The list being played, in play order. */
  readonly items = computed<PlayItem[]>(() => {
    const source = this.source();
    if (source.kind === 'takes') return this.library.takes().map(itemOfTake);
    const playlist = this.library.playlist(source.id);
    return playlist === null ? [] : this.library.songsOf(playlist).map(itemOfSong);
  });

  readonly sourceName = computed(() => {
    const source = this.source();
    return source.kind === 'takes' ? 'Playing list' : (this.library.playlist(source.id)?.name ?? 'A deleted playlist');
  });

  private readonly index = computed(() => {
    const current = this.current();
    return current === null ? -1 : this.items().findIndex((item) => item.key === current.key);
  });
  readonly hasPrevious = computed(() => this.current() !== null);
  /** Next is offered while there is a song after this one, or (on the playing list) one generating to wait for. */
  readonly hasNext = computed(
    () => this.current() !== null
      && (this.index() < this.items().length - 1 || (this.source().kind === 'takes' && this.jobs.generating())),
  );

  constructor() {
    this.audio.preload = 'auto';
    this.audio.setAttribute('playsinline', '');
    this.audio.style.display = 'none';
    document.body.appendChild(this.audio);
    const sync = (): void => {
      this.paused.set(this.audio.paused);
      this.time.set(this.audio.currentTime);
      this.duration.set(Number.isFinite(this.audio.duration) ? this.audio.duration : 0);
    };
    for (const name of ['timeupdate', 'play', 'pause', 'loadedmetadata', 'durationchange', 'emptied']) {
      this.audio.addEventListener(name, sync);
    }
    this.audio.addEventListener('ended', () => this.step(1));
    this.audio.addEventListener('error', () => {
      const current = this.current();
      if (current !== null && this.audio.getAttribute('src') !== null) {
        this.problem.set(`${current.title} could not be played (it may have been cleared from the playing list).`);
      }
    });
    // A rename shows in the bar; a song that left its list stops it.
    effect(() => {
      this.items();
      untracked(() => this.refresh());
    });
    this.hub.onTake((take) => {
      if (this.source().kind === 'takes' && (this.current() === null || this.waiting())) this.play(itemOfTake(take), { kind: 'takes' });
    });
    this.wireMediaSession();
  }

  play(item: PlayItem, source: PlaySource = this.source()): void {
    this.source.set(source);
    this.current.set(item);
    this.waiting.set(false);
    this.problem.set(null);
    this.audio.src = this.hub.audioUrl(item.kind === 'take' ? 'takes' : 'songs', item.id);
    this.audio.play().catch((error: unknown) => {
      // Autoplay refused (a browser before any tap), or a load that failed: paused on it; play tries again.
      console.error('[player] could not play', item.key, error);
    });
    this.describe(item);
  }

  /** Play a take from this device's playing list. */
  playTake(take: Take): void {
    this.play(itemOfTake(take), { kind: 'takes' });
  }

  /** Play a playlist from `song` (or from its first song). */
  playPlaylist(playlistId: string, song?: Song): void {
    const playlist = this.library.playlist(playlistId);
    if (playlist === null) return;
    const songs = this.library.songsOf(playlist);
    const first = song ?? songs[0];
    if (first !== undefined) this.play(itemOfSong(first), { kind: 'playlist', id: playlistId });
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

  stop(): void {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.current.set(null);
    this.waiting.set(false);
    this.problem.set(null);
  }

  private refresh(): void {
    const current = this.current();
    if (current === null) return;
    const found = this.items().find((item) => item.key === current.key);
    if (found === undefined) this.stop();
    else if (found.title !== current.title) {
      this.current.set(found);
      this.describe(found);
    }
  }

  private step(direction: 1 | -1): void {
    const items = this.items();
    if (items.length === 0) return;
    const next = items[this.index() + direction];
    if (next !== undefined) {
      this.play(next);
    } else if (direction > 0 && this.source().kind === 'takes') {
      // Nothing after it yet: the next take to land plays the moment it does.
      this.waiting.set(true);
    }
  }

  private describe(item: PlayItem): void {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({ title: item.title, artist: item.tags ?? 'B-Side', album: this.sourceName() });
  }

  private wireMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    session.setActionHandler('play', () => void this.audio.play());
    session.setActionHandler('pause', () => this.audio.pause());
    session.setActionHandler('previoustrack', () => this.previous());
    session.setActionHandler('nexttrack', () => this.next());
    session.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) this.seek(details.seekTime);
    });
  }
}
