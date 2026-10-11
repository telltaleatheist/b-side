import { inject, Injectable, signal } from '@angular/core';

import { FOLDER_DEPTH, type RefusalView } from '@shared/types';

import { LibraryService } from './library.service';

/** Something on the library's shelf that can be moved: an album or playlist, or a folder. */
export interface ShelfItem {
  readonly kind: 'playlist' | 'folder';
  readonly id: string;
}

/**
 * What a dragged item is over: an album or playlist, or a folder — its row or header (`edge`: a
 * folder dropped near its top or bottom goes beside it rather than into it), or the open space of
 * its contents (`id` null: the top of the library).
 */
export type DropTarget =
  | { readonly kind: 'playlist'; readonly id: string }
  | { readonly kind: 'folder'; readonly id: string | null; readonly edge: boolean };

/** Where a drop puts the dragged item, and how the target shows it. */
interface Landing {
  readonly folder: string | null;
  readonly before: string | null;
  readonly where: 'before' | 'after' | 'into' | 'level';
}

const CLOSED_KEY = 'bside.folders.closed';

/** The key a drop target is marked by while something is dragged over it. */
export function dropKey(target: DropTarget): string {
  return target.kind === 'playlist' ? `p:${target.id}` : `f:${target.id ?? 'top'}:${target.edge ? 'edge' : 'body'}`;
}

/**
 * Folders on the screen (Victoria, 2026-10-11: "group lullaby albums together in their own
 * 'folder' that I can create and drag and drop within the playlist and library"): which are
 * collapsed on this device, dragging albums, playlists and folders into, out of and between
 * them, and the same moves without a drag (Move to folder…), for the phone and the keyboard.
 * The sidebar and the Library page share it, so a folder collapsed in one is collapsed in both.
 */
@Injectable({ providedIn: 'root' })
export class FoldersService {
  private readonly library = inject(LibraryService);

  /** The folders shut on this device (per viewer, so kept in this browser, never on the hub). */
  readonly closed = signal<ReadonlySet<string>>(readClosed());
  readonly dragging = signal<ShelfItem | null>(null);
  /** The target under a drag now (its dropKey) and how it would land. */
  readonly dropAt = signal<{ readonly key: string; readonly where: Landing['where'] } | null>(null);

  isOpen(id: string): boolean {
    return !this.closed().has(id);
  }

  toggle(id: string): void {
    const next = new Set(this.closed());
    if (!next.delete(id)) next.add(id);
    this.closed.set(next);
    try {
      localStorage.setItem(CLOSED_KEY, JSON.stringify([...next]));
    } catch {
      // Not kept (a private window, storage blocked): open again next time.
    }
  }

  /** How the target under the drag shows where it lands ('before', 'into', ...), for its data-drop; null when not under it. */
  mark(target: DropTarget): string | null {
    const at = this.dropAt();
    return at !== null && at.key === dropKey(target) ? at.where : null;
  }

  // ── dragging ──────────────────────────────────────────────────────────────────

  dragStart(event: DragEvent, item: ShelfItem): void {
    event.stopPropagation();
    const data = event.dataTransfer;
    if (data !== null) {
      // Only ours: a link dragged out of the window is not a page to open, and the shell's song-file drop ignores it.
      data.clearData();
      data.setData('application/x-bside-shelf', JSON.stringify(item));
      data.effectAllowed = 'move';
    }
    this.dragging.set(item);
  }

  dragEnd(): void {
    this.dragging.set(null);
    this.dropAt.set(null);
  }

  /** Over a target: allow the drop where it makes sense, and mark where it would land. `axis`: a list (y) or a grid (x). */
  over(event: DragEvent, target: DropTarget, axis: 'x' | 'y' = 'y'): void {
    if (this.dragging() === null) return;
    // Every target answers for itself: a folder over its own contents is not handed on to the folder around them.
    event.stopPropagation();
    const landing = this.landing(event, target, axis);
    if (landing === null) {
      if (this.dropAt() !== null) this.dropAt.set(null);
      return;
    }
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
    const key = dropKey(target);
    const now = this.dropAt();
    if (now?.key !== key || now.where !== landing.where) this.dropAt.set({ key, where: landing.where });
  }

  /** Dropped: the move it means, made. Answers the hub's refusal, if any. */
  async drop(event: DragEvent, target: DropTarget, axis: 'x' | 'y' = 'y'): Promise<RefusalView | null> {
    const item = this.dragging();
    if (item === null) return null;
    event.stopPropagation();
    const landing = this.landing(event, target, axis);
    this.dragEnd();
    if (landing === null) return null;
    event.preventDefault();
    return this.place(item, landing.folder, landing.before);
  }

  private landing(event: DragEvent, target: DropTarget, axis: 'x' | 'y'): Landing | null {
    const item = this.dragging();
    if (item === null) return null;
    const box = (event.currentTarget as Element | null)?.getBoundingClientRect();
    const share = box === undefined || box.width === 0 || box.height === 0 ? 0.5
      : axis === 'y' ? (event.clientY - box.top) / box.height : (event.clientX - box.left) / box.width;

    if (target.kind === 'playlist') {
      const playlist = this.library.playlist(target.id);
      if (playlist === null) return null;
      const level = playlist.folder ?? null;
      if (item.kind === 'folder') {
        // A folder dropped on an album or playlist joins its level (the folders there come first).
        return this.canHold(item.id, level) ? { folder: level, before: null, where: 'level' } : null;
      }
      if (item.id === target.id) return null;
      const after = share > 0.5;
      const beside = this.library.playlistsIn(level).filter((other) => other.id !== item.id);
      const at = beside.findIndex((other) => other.id === target.id);
      return { folder: level, before: after ? (beside[at + 1]?.id ?? null) : target.id, where: after ? 'after' : 'before' };
    }

    const into = target.id;
    if (item.kind === 'playlist') return { folder: into, before: null, where: 'into' };
    if (into === item.id) return null;
    const folder = into === null ? null : this.library.folder(into);
    if (target.edge && folder !== null && (share < 0.25 || share > 0.75)) {
      // Near a folder's top or bottom edge: beside it, among its siblings.
      if (!this.canHold(item.id, folder.parent)) return null;
      const after = share > 0.75;
      const beside = this.library.foldersIn(folder.parent).filter((other) => other.id !== item.id);
      const at = beside.findIndex((other) => other.id === folder.id);
      return { folder: folder.parent, before: after ? (beside[at + 1]?.id ?? null) : folder.id, where: after ? 'after' : 'before' };
    }
    return this.canHold(item.id, into) ? { folder: into, before: null, where: 'into' } : null;
  }

  // ── the same moves without a drag ─────────────────────────────────────────────

  /** Whether a folder can go into `parent`: never inside itself, never deeper than FOLDER_DEPTH. */
  canHold(folderId: string, parent: string | null): boolean {
    if (parent === null) return true;
    let depth = 0;
    for (let at: string | null = parent; at !== null; at = this.library.folder(at)?.parent ?? null) {
      if (at === folderId) return false;
      depth += 1;
    }
    return depth + this.height(folderId) <= FOLDER_DEPTH;
  }

  /** Whether a new folder fits inside this one (it is not already FOLDER_DEPTH deep). */
  roomInside(id: string): boolean {
    let depth = 0;
    for (let at: string | null = id; at !== null; at = this.library.folder(at)?.parent ?? null) depth += 1;
    return depth < FOLDER_DEPTH;
  }

  private height(id: string): number {
    return 1 + Math.max(0, ...this.library.foldersIn(id).map((folder) => this.height(folder.id)));
  }

  /** The folder an item is in now (null: the top). */
  whereIs(item: ShelfItem): string | null {
    return item.kind === 'playlist' ? (this.library.playlist(item.id)?.folder ?? null) : (this.library.folder(item.id)?.parent ?? null);
  }

  /** Put an item in a folder (null: the top), before `before` there or last. */
  place(item: ShelfItem, folder: string | null, before: string | null = null): Promise<RefusalView | null> {
    return item.kind === 'playlist' ? this.library.movePlaylist(item.id, folder, before) : this.library.moveFolder(item.id, folder, before);
  }

  /** Its siblings, itself among them, in order. */
  private siblings(item: ShelfItem): readonly { readonly id: string }[] {
    const level = this.whereIs(item);
    return item.kind === 'playlist' ? this.library.playlistsIn(level) : this.library.foldersIn(level);
  }

  /** Whether an item can move one place earlier (-1) or later (1) among its siblings. */
  canShift(item: ShelfItem, by: -1 | 1): boolean {
    const beside = this.siblings(item);
    const at = beside.findIndex((other) => other.id === item.id);
    return at >= 0 && at + by >= 0 && at + by < beside.length;
  }

  /** One place earlier or later among its siblings, staying in its folder. */
  shift(item: ShelfItem, by: -1 | 1): Promise<RefusalView | null> {
    const beside = this.siblings(item).filter((other) => other.id !== item.id);
    const at = this.siblings(item).findIndex((other) => other.id === item.id);
    // Without itself, the one now at its new place is the one it goes before.
    const before = beside[at + by]?.id ?? null;
    return this.place(item, this.whereIs(item), before);
  }
}

function readClosed(): ReadonlySet<string> {
  try {
    const kept = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(kept) ? kept.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}
