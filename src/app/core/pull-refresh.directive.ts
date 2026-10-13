import { Directive, ElementRef, inject, input, output, signal } from '@angular/core';

/** Past this many px the touch is a pull (or not one), rather than a tap. */
const LOCK_PX = 10;
/** How far the hint follows the finger: half the pull, at most this. */
const PULL_MOST_PX = 90;
/** A pull at least this far, let go, refreshes. */
export const PULL_REFRESH_PX = 60;

/**
 * Pull down to refresh, on the phone (Owen, 2026-10-12: a song finished on the desktop still said
 * "making" on the phone; "have drag down refresh to update the page"). Only a pull that starts with
 * the page at its top, and outside `pullEdge` px of the left edge (the back swipe's), counts; any
 * other touch is the page's own scroll. `distance` is how far it is pulled, for the hint; letting go
 * past PULL_REFRESH_PX emits `pullRefresh`.
 */
@Directive({
  selector: '[appPullRefresh]',
  exportAs: 'pullRefresh',
  host: {
    '(touchstart)': 'start($event)',
    '(touchmove)': 'move($event)',
    '(touchend)': 'end()',
    '(touchcancel)': 'cancel()',
  },
})
export class PullRefreshDirective {
  readonly pullEdge = input(0);
  readonly pullRefresh = output<void>();
  readonly distance = signal(0);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private origin: { x: number; y: number } | null = null;
  private pulling = false;

  protected start(event: TouchEvent): void {
    this.cancel();
    const touch = event.touches[0];
    if (event.touches.length !== 1 || touch === undefined || touch.clientX <= this.pullEdge()) return;
    if (this.host.nativeElement.scrollTop > 0 || scrolledAway(event.target as Element | null, this.host.nativeElement)) return;
    this.origin = { x: touch.clientX, y: touch.clientY };
  }

  protected move(event: TouchEvent): void {
    const origin = this.origin;
    const touch = event.touches[0];
    if (origin === null || touch === undefined) return;
    const dx = touch.clientX - origin.x;
    const dy = touch.clientY - origin.y;
    if (!this.pulling) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < LOCK_PX) return;
      // Sideways or upward: the page's, not a pull.
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
        this.origin = null;
        return;
      }
      this.pulling = true;
    }
    if (event.cancelable) event.preventDefault();
    this.distance.set(Math.max(0, Math.min(PULL_MOST_PX, dy / 2)));
  }

  protected end(): void {
    const pulled = this.pulling && this.distance() >= PULL_REFRESH_PX;
    this.cancel();
    if (pulled) this.pullRefresh.emit();
  }

  protected cancel(): void {
    this.origin = null;
    this.pulling = false;
    this.distance.set(0);
  }
}

/** Whether the touch began inside a list scrolled down from its top, within `host` (its scroll comes first). */
function scrolledAway(target: Element | null, host: Element): boolean {
  for (let at = target; at !== null && at !== host; at = at.parentElement) {
    if (at.scrollTop > 0 && at.scrollHeight > at.clientHeight) return true;
  }
  return false;
}
