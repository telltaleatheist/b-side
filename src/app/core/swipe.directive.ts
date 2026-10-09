import { Directive, input, output } from '@angular/core';

/** Where a swipe is while the finger is down, and once it lifts (with its speed in px/ms). */
export interface Swipe {
  readonly axis: 'x' | 'y';
  readonly dx: number;
  readonly dy: number;
  /** Set on the end event: how fast it was moving as it let go. */
  readonly vx?: number;
  readonly vy?: number;
}

/** Past this many px the swipe has an axis, and is ours rather than a tap. */
const LOCK_PX = 10;

/**
 * Touch swipes for the phone (Owen, 2026-10-09: "drag left/drag right/drag down
 * to go back a page, minimize the player"). Emits `swipeMove` while the finger
 * moves along the axis it settled on, and `swipeEnd` when it lifts; the
 * component decides what a swipe means. A vertical swipe inside something
 * scrolled away from its top is that list's scroll, never a swipe. With
 * `swipeEdge`, only a touch that starts within that many px of the left edge counts.
 */
@Directive({
  selector: '[appSwipe]',
  host: {
    '(touchstart)': 'start($event)',
    '(touchmove)': 'move($event)',
    '(touchend)': 'end($event)',
    '(touchcancel)': 'cancel()',
  },
})
export class SwipeDirective {
  /** The axes this element listens to. */
  /** The axes this element listens to; 'down' is the vertical axis, downward only (upward stays a scroll). */
  readonly appSwipe = input<'x' | 'y' | 'xy' | 'down'>('xy');
  readonly swipeEdge = input<number | null>(null);
  /** Claim a vertical swipe even inside something scrolled: a handle, whose pull always means pull. */
  readonly swipeAlways = input(false);
  readonly swipeMove = output<Swipe>();
  readonly swipeEnd = output<Swipe>();
  readonly swipeCancel = output<void>();

  private origin: { x: number; y: number; t: number; scrolled: boolean } | null = null;
  private axis: 'x' | 'y' | null = null;
  private last: { x: number; y: number; t: number } | null = null;
  private previous: { x: number; y: number; t: number } | null = null;

  protected start(event: TouchEvent): void {
    if (event.touches.length !== 1) {
      this.cancel();
      return;
    }
    const touch = event.touches[0] as Touch;
    const edge = this.swipeEdge();
    if (edge !== null && touch.clientX > edge) return;
    const now = performance.now();
    this.origin = { x: touch.clientX, y: touch.clientY, t: now, scrolled: !this.swipeAlways() && scrolledAway(event.target as Element | null) };
    this.axis = null;
    this.last = this.previous = { x: touch.clientX, y: touch.clientY, t: now };
  }

  protected move(event: TouchEvent): void {
    const origin = this.origin;
    if (origin === null) return;
    const touch = event.touches[0] as Touch;
    const dx = touch.clientX - origin.x;
    const dy = touch.clientY - origin.y;
    if (this.axis === null) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK_PX) return;
      const axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      const wanted = this.appSwipe();
      const listens = wanted === 'xy' || wanted === axis || (wanted === 'down' && axis === 'y' && dy > 0);
      // Not an axis (or way) this element listens to, or a list's own scroll: let it go, never block it.
      if (!listens || (axis === 'y' && origin.scrolled)) {
        this.origin = null;
        return;
      }
      this.axis = axis;
    }
    if (event.cancelable) event.preventDefault();
    this.previous = this.last;
    this.last = { x: touch.clientX, y: touch.clientY, t: performance.now() };
    this.swipeMove.emit({ axis: this.axis, dx, dy });
  }

  protected end(_event: TouchEvent): void {
    const origin = this.origin;
    const axis = this.axis;
    this.origin = null;
    this.axis = null;
    if (origin === null || axis === null || this.last === null) return;
    const before = this.previous ?? this.last;
    const span = Math.max(1, this.last.t - before.t);
    this.swipeEnd.emit({
      axis,
      dx: this.last.x - origin.x,
      dy: this.last.y - origin.y,
      vx: (this.last.x - before.x) / span,
      vy: (this.last.y - before.y) / span,
    });
  }

  protected cancel(): void {
    if (this.axis !== null) this.swipeCancel.emit();
    this.origin = null;
    this.axis = null;
  }
}

/** Whether the touch began inside something scrolled down from its top (its scroll comes first). */
function scrolledAway(target: Element | null): boolean {
  for (let at = target; at !== null; at = at.parentElement) {
    if (at.scrollTop > 0 && at.scrollHeight > at.clientHeight) return true;
  }
  return false;
}
