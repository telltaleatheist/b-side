import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';

import type { Song, Take } from '@shared/types';

import { HtmlAudioOutput, NativeAudioOutput, type AudioOutput, type QueueItem } from './audio-output';
import { CloudService } from './cloud.service';
import { HubService, isNative } from './hub.service';
import { JobsService } from './jobs.service';
import { LibraryService } from './library.service';
import { OfflineService } from './offline.service';

const STORED_OUTPUT = 'bside.output';

/** What the player plays from: this device's playing list, or one saved playlist. */
export type PlaySource =
  | { readonly kind: 'takes' }
  | { readonly kind: 'playlist'; readonly id: string }
  /** A playlist in the phone's cloud (a B-Side computer): streamed from it, or played from the phone's copy. */
  | { readonly kind: 'cloud'; readonly id: string };

/** One thing the player can play, whichever list it came from. */
export interface PlayItem {
  /** `take:<id>` or `song:<id>`: unique across both lists. */
  readonly key: string;
  readonly kind: 'take' | 'song' | 'cloud';
  readonly id: string;
  readonly title: string;
  readonly tags: string | null;
  readonly durationS: number | null;
  /** The album's painted cover, for a song played from an album; null draws the song's own. */
  readonly art: string | null;
}

function itemOfTake(take: Take): PlayItem {
  return { key: `take:${take.id}`, kind: 'take', id: take.id, title: take.title, tags: take.params.tags, durationS: take.durationS, art: null };
}

function itemOfSong(song: Song, art: string | null): PlayItem {
  return { key: `song:${song.id}`, kind: 'song', id: song.id, title: song.title, tags: song.params.tags, durationS: song.durationS, art };
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
 * The sound itself comes out of an `AudioOutput` that holds the queue — the
 * `<audio>` element on the desktop and in a browser, AVPlayer in the iOS app —
 * so the next song starts even while the phone's WebView is frozen. This
 * service keeps the output's queue in step with the list and mirrors what it
 * reports.
 */
@Injectable({ providedIn: 'root' })
export class PlayerService {
  private readonly hub = inject(HubService);
  private readonly library = inject(LibraryService);
  private readonly jobs = inject(JobsService);
  private readonly offline = inject(OfflineService);
  private readonly cloud = inject(CloudService);

  readonly source = signal<PlaySource>({ kind: 'takes' });
  readonly current = signal<PlayItem | null>(null);
  readonly waiting = signal(false);
  readonly paused = signal(true);
  readonly time = signal(0);
  readonly duration = signal(0);
  /** Why the current song would not play, when it would not. */
  readonly problem = signal<string | null>(null);

  private readonly output: AudioOutput;
  /** The output device chosen on this computer ('' = the system default). Desktop and browsers only. */
  readonly outputDevice = signal('');
  /** Why the chosen device is not the one playing, when it is not. */
  readonly outputProblem = signal<string | null>(null);

  /** The list being played, in play order. */
  readonly items = computed<PlayItem[]>(() => {
    const source = this.source();
    if (source.kind === 'takes') return this.library.takes().map(itemOfTake);
    const playlist = this.library.playlist(source.id);
    if (source.kind === 'cloud') {
      const remote = this.cloud.playlist(source.id);
      if (remote === null) return [];
      const remoteArt = this.cloud.coverUrl(remote);
      return this.cloud.songsOf(remote).map((song) => ({ ...itemOfSong(song, remoteArt), key: `cloud:${song.id}`, kind: 'cloud' as const }));
    }
    if (playlist === null) return [];
    const art = this.hub.coverUrl(playlist);
    return this.library.songsOf(playlist).map((song) => itemOfSong(song, art));
  });

  readonly sourceName = computed(() => {
    const source = this.source();
    if (source.kind === 'takes') return 'Playing list';
    if (source.kind === 'cloud') return this.cloud.playlist(source.id)?.name ?? 'A playlist no longer in the cloud';
    return this.library.playlist(source.id)?.name ?? 'A deleted playlist';
  });

  private readonly index = computed(() => {
    const current = this.current();
    return current === null ? -1 : this.items().findIndex((item) => item.key === current.key);
  });
  /** Playing an album that is still being made: at its end, wait for the next track, as on the playing list. */
  private readonly albumFilling = computed(() => {
    const source = this.source();
    if (source.kind !== 'playlist') return false;
    const stage = this.library.playlist(source.id)?.album?.stage;
    return stage === 'planning' || stage === 'cover' || stage === 'making';
  });
  /** An album this device just asked for: it starts playing the moment its first track lands. */
  private readonly autoplay = signal<string | null>(null);
  readonly hasPrevious = computed(() => this.current() !== null);
  /** What plays after the current song, in order (Now Playing's "Up next"). */
  readonly upNext = computed<PlayItem[]>(() => this.items().slice(this.index() + 1));
  /** 0..1 through the current song, for the mini player's line. */
  readonly progress = computed(() => (this.duration() > 0 ? Math.min(1, this.time() / this.duration()) : 0));
  /** Next is offered while there is a song after this one, or (on the playing list) one generating to wait for. */
  readonly hasNext = computed(
    () => this.current() !== null
      && (this.index() < this.items().length - 1 || (this.source().kind === 'takes' && this.jobs.generating()) || this.albumFilling()),
  );

  constructor() {
    const listener = {
      track: (key: string): void => {
        const found = this.items().find((item) => item.key === key) ?? null;
        this.current.set(found);
        this.waiting.set(false);
        this.problem.set(null);
      },
      playing: (playing: boolean): void => this.paused.set(!playing),
      time: (seconds: number, duration: number): void => {
        this.time.set(seconds);
        this.duration.set(duration);
      },
      finished: (): void => {
        // Nothing after it yet: on the playing list, or an album still being made,
        // the next song to land plays the moment it does.
        if (this.source().kind === 'takes' || this.albumFilling()) this.waiting.set(true);
        this.paused.set(true);
      },
      error: (message: string): void => this.problem.set(message),
    };
    this.output = isNative ? new NativeAudioOutput(listener) : new HtmlAudioOutput(listener);
    if (!isNative) {
      let stored = '';
      try {
        stored = localStorage.getItem(STORED_OUTPUT) ?? '';
      } catch {
        // Not kept: the system default.
      }
      if (stored !== '') void this.useOutput(stored, false);
      // A device unplugged while chosen: fall back to the default and say so; plugged back in, use it again.
      navigator.mediaDevices?.addEventListener('devicechange', () => void this.checkOutput());
    }

    // The list changed under the player (a take landed or cleared, a playlist was edited):
    // the output's queue follows; a song that left the list stops.
    effect(() => {
      const items = this.items();
      untracked(() => {
        this.follow(items);
        // Waiting at the end of an album being made, and its next track just landed: play it.
        if (this.waiting() && this.source().kind === 'playlist') {
          const next = items[this.index() + 1] ?? (this.current() === null ? items[0] : undefined);
          if (next !== undefined) this.play(next);
        }
      });
    });
    // An album just asked for: play it as soon as it has a song.
    effect(() => {
      const id = this.autoplay();
      if (id === null) return;
      const playlist = this.library.playlist(id);
      if (playlist === null || playlist.songs.length === 0) return;
      untracked(() => {
        this.autoplay.set(null);
        this.playPlaylist(id);
      });
    });
    this.hub.onTake((take) => {
      if (this.source().kind !== 'takes') return;
      if (this.current() === null || this.waiting()) this.play(itemOfTake(take), { kind: 'takes' });
    });
  }

  play(item: PlayItem, source: PlaySource = this.source()): void {
    this.source.set(source);
    this.current.set(item);
    this.waiting.set(false);
    this.problem.set(null);
    this.output.start(this.queue(), item.key);
  }

  /** Play a take from this device's playing list. */
  playTake(take: Take): void {
    this.play(itemOfTake(take), { kind: 'takes' });
  }

  /**
   * Play through one output device on this computer ('' = the system default)
   * and remember it, so B-Side keeps to that route whatever the computer's
   * default becomes.
   */
  async useOutput(deviceId: string, remember = true): Promise<void> {
    if (!(this.output instanceof HtmlAudioOutput)) return;
    if (remember) {
      try {
        if (deviceId === '') localStorage.removeItem(STORED_OUTPUT);
        else localStorage.setItem(STORED_OUTPUT, deviceId);
      } catch {
        // Kept for this run only.
      }
    }
    this.outputDevice.set(deviceId);
    const problem = await this.output.setDevice(deviceId);
    this.outputProblem.set(problem === null ? null : `B-Side could not play through the chosen output (${problem}); it is using the system default.`);
    if (problem !== null) await this.output.setDevice('');
  }

  /** The chosen device is still there? Else the default, said; back again, it is used again. */
  private async checkOutput(): Promise<void> {
    const wanted = this.outputDevice();
    if (wanted === '' || !(this.output instanceof HtmlAudioOutput)) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const there = devices.some((device) => device.kind === 'audiooutput' && device.deviceId === wanted);
    if (!there) {
      await this.output.setDevice('');
      this.outputProblem.set('The chosen output is not connected; B-Side is using the system default until it is back.');
    } else {
      await this.useOutput(wanted, false);
    }
  }

  /** Start an album this device just asked for the moment its first track lands. */
  playWhenReady(albumId: string): void {
    this.autoplay.set(albumId);
  }

  /** Play a cloud playlist from `song` (or its first song). */
  playCloud(playlistId: string, song?: Song): void {
    const playlist = this.cloud.playlist(playlistId);
    if (playlist === null) return;
    const first = song ?? this.cloud.songsOf(playlist)[0];
    if (first !== undefined) {
      this.play({ ...itemOfSong(first, this.cloud.coverUrl(playlist)), key: `cloud:${first.id}`, kind: 'cloud' }, { kind: 'cloud', id: playlistId });
    }
  }

  /** Play a playlist from `song` (or from its first song). */
  playPlaylist(playlistId: string, song?: Song): void {
    const playlist = this.library.playlist(playlistId);
    if (playlist === null) return;
    const first = song ?? this.library.songsOf(playlist)[0];
    if (first !== undefined) this.play(itemOfSong(first, this.hub.coverUrl(playlist)), { kind: 'playlist', id: playlistId });
  }

  toggle(): void {
    if (this.current() === null) return;
    if (this.paused()) this.output.play();
    else this.output.pause();
  }

  seek(seconds: number): void {
    this.output.seek(seconds);
  }

  previous(): void {
    this.output.previous();
  }

  next(): void {
    this.output.next();
  }

  stop(): void {
    this.output.stop();
    this.current.set(null);
    this.waiting.set(false);
    this.problem.set(null);
    this.paused.set(true);
  }

  /** The output's queue: the list being played, each song at the URL this device plays it from. */
  private queue(): QueueItem[] {
    const album = this.sourceName();
    return this.items().map((item) => ({
      key: item.key,
      url: item.kind === 'song'
        ? this.offline.urlOf(item.id) ?? this.hub.audioUrl('songs', item.id)
        : item.kind === 'cloud'
          ? this.offline.urlOf(item.id) ?? this.cloud.audioUrl(item.id)
          : this.hub.audioUrl('takes', item.id),
      title: item.title,
      artist: item.tags ?? 'B-Side',
      album,
    }));
  }

  private follow(items: PlayItem[]): void {
    const current = this.current();
    if (current === null) return;
    const found = items.find((item) => item.key === current.key);
    if (found === undefined) {
      this.stop();
      return;
    }
    if (found.title !== current.title) this.current.set(found);
    this.output.update(this.queue());
  }
}
