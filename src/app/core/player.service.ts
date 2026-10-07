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
  /** A playlist in the phone's cloud (a B-Sides computer): streamed from it, or played from the phone's copy. */
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
  /** The album's cover, for a song played from an album; null draws the song's own (a playlist's songs keep theirs). */
  readonly art: string | null;
  /** The words it was sung with, in section tags; null for an instrumental. */
  readonly lyrics: string | null;
}

/** One place in the queue. The same song can be in it twice, so each place has its own id. */
export interface QueueEntry {
  readonly qid: string;
  readonly item: PlayItem;
  /** Where it was queued from (a playlist's name, the playing list): the lock screen's album line. */
  readonly from: string;
  /** Came with the list being played (and follows it), rather than added by hand. */
  readonly fromSource: boolean;
  /** Its place before any shuffle: shuffle off puts the queue back in this order. */
  readonly order: number;
}

/** Repeat: off, the whole queue, or the one song. */
export type RepeatMode = 'off' | 'all' | 'one';

function itemOfTake(take: Take): PlayItem {
  return { key: `take:${take.id}`, kind: 'take', id: take.id, title: take.title, tags: take.params.tags, durationS: take.durationS, art: null, lyrics: take.params.instrumental ? null : take.params.lyrics || null };
}

function itemOfSong(song: Song, art: string | null): PlayItem {
  return { key: `song:${song.id}`, kind: 'song', id: song.id, title: song.title, tags: song.params.tags, durationS: song.durationS, art, lyrics: song.params.instrumental ? null : song.params.lyrics || null };
}

/**
 * The one player, with a queue as any music player has (Owen, 2026-10-06):
 * playing a playlist or an album puts it in the queue in place of what was
 * there; Play next and Add to queue put songs in it from anywhere; it can be
 * reordered, trimmed, shuffled and repeated. The queue follows the list it was
 * started from: a take or an album's track that lands joins its end, and a song
 * deleted from that list leaves it (one removed by hand stays out).
 *
 * The Crucible playground's rules on the playing list still hold:
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
  /** Everything queued, in play order: what played, what is playing, what comes next. */
  readonly queue = signal<readonly QueueEntry[]>([]);
  /** The queue entry playing now. */
  readonly currentId = signal<string | null>(null);
  readonly current = computed<PlayItem | null>(() => this.currentEntry()?.item ?? null);
  readonly shuffle = signal(false);
  readonly repeat = signal<RepeatMode>('off');
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
      const remoteArt = (remote.album ? this.cloud.coverUrl(remote) : null);
      return this.cloud.songsOf(remote).map((song) => ({ ...itemOfSong(song, remoteArt), key: `cloud:${song.id}`, kind: 'cloud' as const }));
    }
    if (playlist === null) return [];
    const art = (playlist.album ? this.hub.coverUrl(playlist) : null);
    return this.library.songsOf(playlist).map((song) => itemOfSong(song, art));
  });

  readonly sourceName = computed(() => {
    const source = this.source();
    if (source.kind === 'takes') return 'Playing list';
    if (source.kind === 'cloud') return this.cloud.playlist(source.id)?.name ?? 'A playlist no longer in the cloud';
    return this.library.playlist(source.id)?.name ?? 'A deleted playlist';
  });

  private readonly currentEntry = computed(() => {
    const id = this.currentId();
    return id === null ? null : (this.queue().find((entry) => entry.qid === id) ?? null);
  });
  private readonly index = computed(() => {
    const id = this.currentId();
    return id === null ? -1 : this.queue().findIndex((entry) => entry.qid === id);
  });
  /** Songs of the source list removed from the queue by hand: following the list does not bring them back. */
  private dismissed = new Set<string>();
  private nextOrder = 0;
  private nextQid = 0;
  /** Playing an album that is still being made: at its end, wait for the next track, as on the playing list. */
  private readonly albumFilling = computed(() => {
    const source = this.source();
    if (source.kind !== 'playlist') return false;
    const album = this.library.playlist(source.id)?.album;
    const stage = album?.stage;
    return (stage === 'planning' || stage === 'cover' || stage === 'making') && album?.working !== false;
  });
  /** Songs this device just asked for (job keys): the first to land plays, in its playlist. */
  private readonly awaited = new Set<string>();
  /** An album this device just asked for: it starts playing the moment its first track lands. */
  private readonly autoplay = signal<string | null>(null);
  readonly hasPrevious = computed(() => this.current() !== null);
  /** What plays after the current song, in order (Now Playing's "Up next"). */
  readonly upNext = computed<readonly QueueEntry[]>(() => this.queue().slice(this.index() + 1));
  /** 0..1 through the current song, for the mini player's line. */
  readonly progress = computed(() => (this.duration() > 0 ? Math.min(1, this.time() / this.duration()) : 0));
  /** Next is offered while there is a song after this one, or (on the playing list) one generating to wait for. */
  readonly hasNext = computed(
    () => this.current() !== null
      && (this.index() < this.queue().length - 1 || this.repeat() !== 'off'
        || (this.source().kind === 'takes' && this.jobs.generating()) || this.albumFilling()),
  );

  constructor() {
    const listener = {
      track: (qid: string): void => {
        this.currentId.set(this.queue().some((entry) => entry.qid === qid) ? qid : null);
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
    // the queue follows it; a song that left the list leaves the queue.
    effect(() => {
      const items = this.items();
      untracked(() => {
        this.follow(items);
        // Waiting at the end, and a song just joined: play it.
        if (this.waiting()) {
          const next = this.queue()[this.index() + 1];
          if (next !== undefined) this.playEntry(next);
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
    this.hub.onSongFiled((job) => {
      if (!this.awaited.delete(job.key) || job.playlist == null || job.songId == null) return;
      // The first of a new ask plays at once; the rest of its batch join the queue as they land
      // (the queue follows the playlist), cutting in only when nothing is playing.
      const playlist = this.library.playlist(job.playlist);
      const song = this.library.songs().find((other) => other.id === job.songId);
      if (playlist === null || song === undefined) return;
      if (this.current() === null || this.waiting() || this.awaitedFresh) {
        this.awaitedFresh = false;
        this.playPlaylist(playlist.id, song);
      }
    });
    this.hub.onTake((take) => {
      // Nothing playing: a song made here plays at once. (Waiting at the end is the effect above.)
      if (this.current() === null && (this.source().kind === 'takes' || this.queue().length === 0)) {
        this.play(itemOfTake(take), { kind: 'takes' });
      }
    });
  }

  /** Play `item` from `source`: the queue becomes that list, from the start, playing `item`. */
  play(item: PlayItem, source: PlaySource = this.source()): void {
    this.source.set(source);
    this.dismissed = new Set();
    const name = this.sourceName();
    const items = this.items();
    const list = items.some((other) => other.key === item.key) ? items : [item];
    let entries = list.map((other) => this.entry(other, name, true));
    const chosen = entries.find((entry) => entry.item.key === item.key) as QueueEntry;
    if (this.shuffle()) entries = [chosen, ...shuffled(entries.filter((entry) => entry !== chosen))];
    this.queue.set(entries);
    this.playEntry(chosen, true);
  }

  /** Play one place in the queue (a click in Up next): the queue stays as it is. */
  playEntry(entry: QueueEntry, restart = true): void {
    this.currentId.set(entry.qid);
    this.waiting.set(false);
    this.problem.set(null);
    if (restart) this.output.start(this.outputQueue(), entry.qid);
  }

  /** Put songs right after the one playing. Nothing playing: they play now. */
  playNext(items: readonly PlayItem[], from: string): void {
    this.insert(items, from, this.index() + 1);
  }

  /** Put songs at the end of the queue. Nothing playing: they play now. */
  addToQueue(items: readonly PlayItem[], from: string): void {
    this.insert(items, from, this.queue().length);
  }

  /** Take one place out of the queue. The song playing moves on to the next (or stops). */
  remove(qid: string): void {
    const entries = this.queue();
    const at = entries.findIndex((entry) => entry.qid === qid);
    if (at < 0) return;
    const gone = entries[at] as QueueEntry;
    if (gone.fromSource) this.dismissed.add(gone.item.key);
    const rest = entries.filter((entry) => entry.qid !== qid);
    if (qid === this.currentId()) {
      const next = rest[at];
      this.queue.set(rest);
      if (next !== undefined) this.playEntry(next);
      else this.stop();
      return;
    }
    this.queue.set(rest);
    this.output.update(this.outputQueue());
  }

  /** Move a song within Up next: `from` and `to` count from the first song after the one playing. */
  moveUpNext(from: number, to: number): void {
    const base = this.index() + 1;
    const entries = [...this.queue()];
    const [moved] = entries.splice(base + from, 1);
    if (moved === undefined) return;
    entries.splice(base + Math.max(0, Math.min(to, entries.length - base)), 0, moved);
    this.queue.set(entries);
    this.output.update(this.outputQueue());
  }

  /** Empty Up next; the song playing plays on. */
  clearUpNext(): void {
    const entries = this.queue();
    const keep = entries.slice(0, this.index() + 1);
    for (const entry of entries.slice(this.index() + 1)) if (entry.fromSource) this.dismissed.add(entry.item.key);
    this.queue.set(keep);
    this.output.update(this.outputQueue());
  }

  /** Shuffle on mixes what comes next; off puts it back in its order. */
  toggleShuffle(): void {
    const on = !this.shuffle();
    this.shuffle.set(on);
    const base = this.index() + 1;
    const entries = this.queue();
    const after = entries.slice(base);
    const mixed = on ? shuffled(after) : [...after].sort((a, b) => a.order - b.order);
    this.queue.set([...entries.slice(0, base), ...mixed]);
    this.output.update(this.outputQueue());
  }

  /** Off, then the whole queue, then the one song, then off. */
  cycleRepeat(): void {
    const next: RepeatMode = this.repeat() === 'off' ? 'all' : this.repeat() === 'all' ? 'one' : 'off';
    this.repeat.set(next);
    this.output.setRepeat(next);
  }

  /** Play a take from this device's playing list. */
  playTake(take: Take): void {
    this.play(itemOfTake(take), { kind: 'takes' });
  }

  /**
   * Play through one output device on this computer ('' = the system default)
   * and remember it, so B-Sides keeps to that route whatever the computer's
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
    this.outputProblem.set(problem === null ? null : `B-Sides could not play through the chosen output (${problem}); it is using the system default.`);
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
      this.outputProblem.set('The chosen output is not connected; B-Sides is using the system default until it is back.');
    } else {
      await this.useOutput(wanted, false);
    }
  }

  /** Whether the next awaited song may cut in on what is playing: yes for the first of a new ask. */
  private awaitedFresh = false;

  /** Play the first of these songs (job keys) the moment it lands, in the playlist it is filed into. */
  playWhenMade(keys: readonly string[]): void {
    this.awaited.clear();
    for (const key of keys) this.awaited.add(key);
    this.awaitedFresh = true;
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
      this.play({ ...itemOfSong(first, (playlist.album ? this.cloud.coverUrl(playlist) : null)), key: `cloud:${first.id}`, kind: 'cloud' }, { kind: 'cloud', id: playlistId });
    }
  }

  /**
   * A playlist's songs as queue items (all of them, or just `songs`), for Play
   * next and Add to queue: a local playlist, or one in the cloud (`cloud`).
   */
  itemsOf(playlistId: string, cloud: boolean, songs?: readonly Song[]): PlayItem[] {
    if (cloud) {
      const remote = this.cloud.playlist(playlistId);
      if (remote === null) return [];
      const art = (remote.album ? this.cloud.coverUrl(remote) : null);
      return (songs ?? this.cloud.songsOf(remote)).map((song) => ({ ...itemOfSong(song, art), key: `cloud:${song.id}`, kind: 'cloud' as const }));
    }
    const playlist = this.library.playlist(playlistId);
    if (playlist === null) return [];
    const art = (playlist.album ? this.hub.coverUrl(playlist) : null);
    return (songs ?? this.library.songsOf(playlist)).map((song) => itemOfSong(song, art));
  }

  /** Play a playlist from `song` (or from its first song). */
  playPlaylist(playlistId: string, song?: Song): void {
    const playlist = this.library.playlist(playlistId);
    if (playlist === null) return;
    const first = song ?? this.library.songsOf(playlist)[0];
    if (first !== undefined) this.play(itemOfSong(first, (playlist.album ? this.hub.coverUrl(playlist) : null)), { kind: 'playlist', id: playlistId });
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
    this.currentId.set(null);
    this.waiting.set(false);
    this.problem.set(null);
    this.paused.set(true);
  }

  private entry(item: PlayItem, from: string, fromSource: boolean): QueueEntry {
    return { qid: `q${this.nextQid++}`, item, from, fromSource, order: this.nextOrder++ };
  }

  private insert(items: readonly PlayItem[], from: string, at: number): void {
    if (items.length === 0) return;
    const added = items.map((item) => this.entry(item, from, false));
    const entries = [...this.queue()];
    entries.splice(at, 0, ...added);
    this.queue.set(entries);
    if (this.current() === null || this.waiting()) this.playEntry(added[0] as QueueEntry);
    else this.output.update(this.outputQueue());
  }

  /** The output's queue: each place in the queue at the URL this device plays it from. */
  private outputQueue(): QueueItem[] {
    return this.queue().map(({ qid, item, from }) => ({
      key: qid,
      url: item.kind === 'song'
        ? this.offline.urlOf(item.id) ?? this.hub.audioUrl('songs', item.id)
        : item.kind === 'cloud'
          ? this.offline.urlOf(item.id) ?? this.cloud.audioUrl(item.id)
          : this.hub.audioUrl('takes', item.id),
      title: item.title,
      artist: item.tags ?? 'B-Sides',
      album: from,
    }));
  }

  /**
   * The source list changed: its songs in the queue take their new names, the
   * ones gone from it leave, and new ones join the end (unless removed by hand).
   */
  private follow(items: PlayItem[]): void {
    const entries = this.queue();
    if (entries.length === 0) return;
    const now = new Map(items.map((item) => [item.key, item]));
    const kept = entries
      .filter((entry) => !entry.fromSource || now.has(entry.item.key))
      .map((entry) => (entry.fromSource ? { ...entry, item: now.get(entry.item.key) as PlayItem } : entry));
    const held = new Set(entries.filter((entry) => entry.fromSource).map((entry) => entry.item.key));
    const name = this.sourceName();
    const joined = items.filter((item) => !held.has(item.key) && !this.dismissed.has(item.key)).map((item) => this.entry(item, name, true));
    const next = [...kept, ...joined];
    const playing = this.currentId();
    this.queue.set(next);
    if (playing !== null && !next.some((entry) => entry.qid === playing)) {
      this.stop();
      return;
    }
    this.output.update(this.outputQueue());
  }
}

/** A copy in random order (Fisher-Yates). */
function shuffled<T>(list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
