import { inject, Injectable, signal } from '@angular/core';

import type { Playlist, RefusalView } from '@shared/types';

import { LibraryService } from './library.service';

/** A song being dragged: which, from where, and whether it may leave there (an album's songs stay in it). */
export interface SongDrag {
  readonly song: string;
  readonly from: string;
  readonly leaves: boolean;
}

/** How a target under a song drag shows it, for its data-drop: a line before or after a row, into a playlist, or no. */
export type SongMark = 'before' | 'after' | 'into' | 'no';

const SONG_TYPE = 'application/x-bside-song';
/** How near the scroller's top or bottom (px) a drag starts it scrolling, and its fastest step per frame. */
const EDGE_BAND = 64;
const EDGE_STEP = 18;

/**
 * The play order once `song` is dropped before or after `target`; null when nothing would change
 * (dropped on itself, or back where it was).
 */
export function orderAfterDrop(order: readonly string[], song: string, target: string, after: boolean): string[] | null {
  if (song === target || !order.includes(song) || !order.includes(target)) return null;
  const rest = order.filter((id) => id !== song);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  const next = [...rest.slice(0, at), song, ...rest.slice(at)];
  return next.every((id, index) => id === order[index]) ? null : next;
}

/** How far to scroll this frame with the pointer at `y` in a scroller spanning top..bottom: toward the nearer edge, faster closer to it. */
export function edgeScroll(y: number, top: number, bottom: number, band = EDGE_BAND, step = EDGE_STEP): number {
  const reach = Math.min(band, (bottom - top) / 3);
  if (reach <= 0) return 0;
  if (y < top + reach) return -Math.ceil(step * Math.min(1, (top + reach - y) / reach));
  if (y > bottom - reach) return Math.ceil(step * Math.min(1, (y - (bottom - reach)) / reach));
  return 0;
}

/** The nearest ancestor that scrolls up and down (the room, on the desktop). */
function scrollerOf(element: Element | null): Element | null {
  for (let at = element?.parentElement ?? null; at !== null; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if ((overflowY === 'auto' || overflowY === 'scroll') && at.scrollHeight > at.clientHeight) return at;
  }
  return document.scrollingElement;
}

/**
 * Dragging a song (Owen, 2026-10-11: "drag/drop to songs to move their order in the playlist or to
 * move them to a different playlist ... in the left side nav"): onto another row of its playlist,
 * a new place in it (the reorder route, as Move up/down); onto a playlist in the sidebar, a move
 * there (as Move to). The same rules as the buttons: an album's songs reorder but never leave it,
 * and nothing moves into an album. The buttons stay, for the phone and the keyboard.
 */
@Injectable({ providedIn: 'root' })
export class SongDragService {
  private readonly library = inject(LibraryService);

  readonly dragging = signal<SongDrag | null>(null);
  /** The target under the drag now ("s:<song>" a row, "p:<playlist>" the sidebar) and how it shows. */
  readonly at = signal<{ readonly key: string; readonly mark: SongMark } | null>(null);

  private scroller: Element | null = null;
  private pointerY: number | null = null;
  private frame: number | null = null;
  private readonly follow = (event: DragEvent): void => {
    this.pointerY = event.clientY;
  };

  /**
   * Whether a song may be dragged from its playlist to this one: into any other, albums included
   * (Victoria, 2026-10-12; the row's Copy or move menu does the same), never out of an album by a
   * drag, which is too easy to do by accident; the row's menu moves a track out on purpose.
   */
  static allows(from: Playlist | null, to: Playlist | null): boolean {
    return from !== null && to !== null && from.id !== to.id && from.album == null;
  }

  mark(key: string): SongMark | null {
    const at = this.at();
    return at !== null && at.key === key ? at.mark : null;
  }

  /** A sidebar playlist's mark while a song is dragged: 'into' under the pointer, 'no' for every one it cannot go to. */
  markPlaylist(id: string): SongMark | null {
    const drag = this.dragging();
    if (drag === null) return null;
    if (!this.canTake(id)) return 'no';
    return this.mark(`p:${id}`);
  }

  canTake(id: string): boolean {
    const drag = this.dragging();
    return drag !== null && drag.leaves && SongDragService.allows(this.library.playlist(drag.from), this.library.playlist(id));
  }

  start(event: DragEvent, song: string, from: Playlist): void {
    const data = event.dataTransfer;
    if (data !== null) {
      // Only ours: the shell's song-file drop and the folders' drag both ignore it.
      data.clearData();
      data.setData(SONG_TYPE, song);
      data.effectAllowed = 'move';
    }
    this.dragging.set({ song, from: from.id, leaves: from.album == null });
    this.scroller = scrollerOf(event.currentTarget as Element | null);
    this.pointerY = null;
    document.addEventListener('dragover', this.follow, true);
    this.frame = requestAnimationFrame(() => this.scroll());
  }

  end(): void {
    if (this.dragging() === null) return;
    this.dragging.set(null);
    this.at.set(null);
    document.removeEventListener('dragover', this.follow, true);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.scroller = null;
  }

  /** Nowhere it can land under the pointer (a target stops its own dragover): no mark shown. */
  overNothing(): void {
    if (this.dragging() !== null && this.at() !== null) this.at.set(null);
  }

  /** Over a row of the playlist it came from: a line where it would land. */
  overRow(event: DragEvent, playlist: Playlist, target: string): void {
    const drag = this.dragging();
    if (drag === null) return;
    event.stopPropagation();
    if (drag.from !== playlist.id) return this.show(`s:${target}`, 'no');
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
    // On itself: no line (it stays put), but no refusal either.
    this.show(`s:${target}`, target === drag.song ? null : this.half(event));
  }

  /** Dropped on a row: the playlist's new order, or null when it does not change. */
  dropRow(event: DragEvent, playlist: Playlist, target: string): string[] | null {
    const drag = this.dragging();
    if (drag === null) return null;
    event.stopPropagation();
    event.preventDefault();
    const after = this.half(event) === 'after';
    this.end();
    return drag.from === playlist.id ? orderAfterDrop(playlist.songs, drag.song, target, after) : null;
  }

  /** Over a playlist in the sidebar: highlighted when it can take the song, no-drop when not. */
  overPlaylist(event: DragEvent, id: string): void {
    if (this.dragging() === null) return;
    event.stopPropagation();
    if (!this.canTake(id)) {
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'none';
      return this.show(`p:${id}`, 'no');
    }
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
    this.show(`p:${id}`, 'into');
  }

  /** Dropped on a playlist in the sidebar: the song moves there. Answers the hub's refusal, if any. */
  async dropOnPlaylist(event: DragEvent, id: string): Promise<RefusalView | null> {
    const drag = this.dragging();
    if (drag === null) return null;
    event.stopPropagation();
    const can = this.canTake(id);
    this.end();
    if (!can) return null;
    event.preventDefault();
    return this.move(drag.song, drag.from, id);
  }

  /** Into `to`, then out of `from`: the Move to action's own two steps. */
  async move(song: string, from: string, to: string): Promise<RefusalView | null> {
    const added = await this.library.addSong(to, song);
    return added ?? (await this.library.removeSong(from, song));
  }

  private half(event: DragEvent): 'before' | 'after' {
    const box = (event.currentTarget as Element | null)?.getBoundingClientRect();
    return box !== undefined && box.height > 0 && event.clientY - box.top > box.height / 2 ? 'after' : 'before';
  }

  private show(key: string, mark: SongMark | null): void {
    const now = this.at();
    if (mark === null) {
      if (now !== null) this.at.set(null);
    } else if (now?.key !== key || now.mark !== mark) {
      this.at.set({ key, mark });
    }
  }

  /** Near the scroller's top or bottom edge, it scrolls, every frame until the drag ends. */
  private scroll(): void {
    if (this.dragging() === null) return;
    const scroller = this.scroller;
    if (scroller !== null && this.pointerY !== null) {
      const box = scroller === document.scrollingElement ? { top: 0, bottom: innerHeight } : scroller.getBoundingClientRect();
      const by = edgeScroll(this.pointerY, box.top, box.bottom);
      if (by !== 0) scroller.scrollTop += by;
    }
    this.frame = requestAnimationFrame(() => this.scroll());
  }
}
