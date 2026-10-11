import { DestroyRef, Directive, ElementRef, inject, input, type OnInit } from '@angular/core';

/** Where each box's height is kept: `b-sides.height.<field>`. */
const STORED_HEIGHT = 'b-sides.height.';

/**
 * A text box that keeps the height it was dragged to (Victoria, 2026-10-11: Make's text boxes
 * "can be resized by dragging, but they snap back to the default height after each creation").
 * `appRememberHeight="describe"` names the box; its height is kept in localStorage under that
 * name and put back whenever the box is drawn again, so it survives the form resetting.
 *
 * Only a drag is kept: the browser writes a dragged height into the box's own style, so a size
 * that differs from the one put back here is the person's. A box hidden (height 0) is ignored.
 */
@Directive({ selector: 'textarea[appRememberHeight]' })
export class RememberHeightDirective implements OnInit {
  readonly appRememberHeight = input.required<string>();
  private readonly box = inject<ElementRef<HTMLTextAreaElement>>(ElementRef).nativeElement;
  private readonly destroyRef = inject(DestroyRef);
  /** The height last put back or kept: the same again is not a drag. */
  private known = '';

  ngOnInit(): void {
    const kept = this.read();
    if (kept !== null) {
      this.box.style.height = kept;
      this.known = kept;
    }
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => this.resized());
    watch.observe(this.box);
    this.destroyRef.onDestroy(() => watch.disconnect());
  }

  private resized(): void {
    const height = this.box.style.height;
    if (height === '' || height === this.known || this.box.offsetHeight === 0) return;
    this.known = height;
    try {
      localStorage.setItem(STORED_HEIGHT + this.appRememberHeight(), height);
    } catch {
      // Storage blocked (a private window): the box still resizes, it just is not kept.
    }
  }

  private read(): string | null {
    try {
      const kept = localStorage.getItem(STORED_HEIGHT + this.appRememberHeight());
      return kept !== null && /^\d+(\.\d+)?px$/.test(kept) ? kept : null;
    } catch {
      return null;
    }
  }
}
