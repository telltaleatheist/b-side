import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** One song the output can play: `key` is the player's identity for it. */
export interface QueueItem {
  readonly key: string;
  readonly url: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
}

/** What an output tells the player. */
export interface OutputListener {
  /** The song now loaded (it changed by itself at a song's end, or by next/previous). */
  track(key: string): void;
  playing(playing: boolean): void;
  time(seconds: number, duration: number): void;
  /** The last song in the queue ended: nothing more to play until the queue grows. */
  finished(): void;
  error(message: string): void;
}

/**
 * Where sound comes out. It HOLDS THE QUEUE and moves through it by itself, so
 * the next song starts even when nothing else can run: on iOS the WebView is
 * frozen while the screen is locked, and only native code is awake to load the
 * next song (the Bookshelf app's lesson).
 */
export interface AudioOutput {
  /** Replace the queue and play `key` from the start. */
  start(items: readonly QueueItem[], key: string): void;
  /** Replace the queue around what is playing, without interrupting it (a song landed, one was removed). */
  update(items: readonly QueueItem[]): void;
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  /** Previous restarts the song after 3 s, as every player does. */
  previous(): void;
  next(): void;
  stop(): void;
}

const RESTART_AFTER_S = 3;

/**
 * The desktop window and every browser: one `<audio>` element. It lives in the
 * DOM because iOS Safari will not play an element that is not.
 */
export class HtmlAudioOutput implements AudioOutput {
  private readonly audio = document.createElement('audio');
  private items: readonly QueueItem[] = [];
  private current: QueueItem | null = null;

  constructor(private readonly listener: OutputListener) {
    this.audio.preload = 'auto';
    this.audio.setAttribute('playsinline', '');
    this.audio.style.display = 'none';
    document.body.appendChild(this.audio);
    const time = (): void => {
      this.listener.time(this.audio.currentTime, Number.isFinite(this.audio.duration) ? this.audio.duration : 0);
    };
    for (const name of ['timeupdate', 'loadedmetadata', 'durationchange', 'emptied']) this.audio.addEventListener(name, time);
    this.audio.addEventListener('play', () => this.listener.playing(true));
    this.audio.addEventListener('pause', () => this.listener.playing(false));
    this.audio.addEventListener('ended', () => this.step(1, true));
    this.audio.addEventListener('error', () => {
      if (this.current !== null && this.audio.getAttribute('src') !== null) {
        this.listener.error(`${this.current.title} could not be played (it may have been cleared from the playing list).`);
      }
    });
    this.wireMediaSession();
  }

  start(items: readonly QueueItem[], key: string): void {
    this.items = items;
    const item = items.find((other) => other.key === key);
    if (item !== undefined) this.load(item);
  }

  update(items: readonly QueueItem[]): void {
    this.items = items;
  }

  play(): void {
    void this.audio.play().catch((error: unknown) => console.error('[player] play refused', error));
  }

  pause(): void {
    this.audio.pause();
  }

  seek(seconds: number): void {
    this.audio.currentTime = seconds;
  }

  previous(): void {
    if (this.audio.currentTime > RESTART_AFTER_S || this.index() <= 0) {
      this.audio.currentTime = 0;
      return;
    }
    this.step(-1, false);
  }

  next(): void {
    this.step(1, false);
  }

  stop(): void {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.current = null;
  }

  /**
   * Play through one output device ('' = the system default, following
   * whatever the computer is set to). Answers why it could not, or null.
   */
  async setDevice(deviceId: string): Promise<string | null> {
    const element = this.audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof element.setSinkId !== 'function') return 'This window cannot choose an output device.';
    try {
      await element.setSinkId(deviceId);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  private index(): number {
    const current = this.current;
    return current === null ? -1 : this.items.findIndex((item) => item.key === current.key);
  }

  private step(direction: 1 | -1, ended: boolean): void {
    const next = this.items[this.index() + direction];
    if (next !== undefined) this.load(next);
    else if (ended) this.listener.finished();
  }

  private load(item: QueueItem): void {
    this.current = item;
    this.audio.src = item.url;
    this.play();
    this.listener.track(item.key);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: item.title, artist: item.artist, album: item.album });
    }
  }

  private wireMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const session = navigator.mediaSession;
    session.setActionHandler('play', () => this.play());
    session.setActionHandler('pause', () => this.pause());
    session.setActionHandler('previoustrack', () => this.previous());
    session.setActionHandler('nexttrack', () => this.next());
    session.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) this.seek(details.seekTime);
    });
  }
}

/** The iOS app's native queue player (mobile/ios/.../NativeQueuePlugin.swift). */
interface NativeQueuePlugin {
  setQueue(options: { items: QueueItem[]; key: string | null; play: boolean }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { time: number }): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  stop(): Promise<void>;
  addListener(event: 'track', listener: (data: { key: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'state', listener: (data: { playing: boolean }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'time', listener: (data: { time: number; duration: number }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'finished', listener: () => void): Promise<PluginListenerHandle>;
  addListener(event: 'error', listener: (data: { message: string }) => void): Promise<PluginListenerHandle>;
}

const NativeQueue = registerPlugin<NativeQueuePlugin>('NativeQueue');

/**
 * The iOS app: AVPlayer through the native audio stack, so a locked screen
 * neither blips nor stops at the end of a song. The queue lives natively; this
 * only hands it over and mirrors what native reports. A call the bridge refuses
 * is said in the player bar, never swallowed.
 */
export class NativeAudioOutput implements AudioOutput {
  constructor(private readonly listener: OutputListener) {
    void NativeQueue.addListener('track', (data) => this.listener.track(data.key));
    void NativeQueue.addListener('state', (data) => this.listener.playing(data.playing));
    void NativeQueue.addListener('time', (data) => this.listener.time(data.time, data.duration));
    void NativeQueue.addListener('finished', () => this.listener.finished());
    void NativeQueue.addListener('error', (data) => this.listener.error(data.message));
  }

  start(items: readonly QueueItem[], key: string): void {
    this.call(NativeQueue.setQueue({ items: [...items], key, play: true }));
  }

  update(items: readonly QueueItem[]): void {
    this.call(NativeQueue.setQueue({ items: [...items], key: null, play: false }));
  }

  play(): void {
    this.call(NativeQueue.play());
  }

  pause(): void {
    this.call(NativeQueue.pause());
  }

  seek(seconds: number): void {
    this.call(NativeQueue.seek({ time: seconds }));
  }

  previous(): void {
    this.call(NativeQueue.previous());
  }

  next(): void {
    this.call(NativeQueue.next());
  }

  stop(): void {
    this.call(NativeQueue.stop());
  }

  private call(pending: Promise<void>): void {
    pending.catch((error: unknown) => this.listener.error(`The phone's player refused: ${String(error)}`));
  }
}
