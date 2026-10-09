import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { PlayerService } from '../../core/player.service';
import { SwipeDirective, type Swipe } from '../../core/swipe.directive';
import { UiService } from '../../core/ui.service';
import { CoverComponent } from '../cover/cover.component';
import { IconComponent } from '../icon/icon.component';

/**
 * The phone's player: one row above the tabs on every screen. Tap it, or swipe
 * it up, for Now Playing; swipe it left for the next song, right for the one before.
 */
@Component({
  selector: 'app-mini-player',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CoverComponent, IconComponent, SwipeDirective],
  template: `
    @if (player.current(); as item) {
      <div class="row" appSwipe="xy" (swipeMove)="moved($event)" (swipeEnd)="swiped($event)" (swipeCancel)="shift.set(0)"
           [class.moving]="held()" [style.transform]="shift() ? 'translateX(' + shift() + 'px)' : null" [style.opacity]="shift() ? 1 - Math.min(0.7, Math.abs(shift()) / 300) : null">
        <button type="button" class="open" aria-label="Open Now Playing" (click)="ui.nowPlayingOpen.set(true)">
          <app-cover class="art" [key]="item.id + (item.tags ?? '')" [src]="item.art" />
          <span class="names">
            <span class="title">{{ item.title }}</span>
            <span class="sub">{{ player.waiting() ? 'Waiting for the next song…' : (item.tags ?? player.sourceName()) }}</span>
          </span>
        </button>
        <button type="button" class="icon-btn" [attr.aria-label]="player.paused() ? 'Play' : 'Pause'" (click)="player.toggle()">
          <app-icon [name]="player.paused() ? 'play' : 'pause'" [size]="26" />
        </button>
        <button type="button" class="icon-btn" aria-label="Next" [disabled]="!player.hasNext()" (click)="player.next()"><app-icon name="next" /></button>
      </div>
      <div class="line"><span [style.width.%]="player.progress() * 100"></span></div>
    }
  `,
  styles: [`
    :host { display: block; padding: 0 10px; }
    .row { transition: transform 300ms cubic-bezier(0.22, 1, 0.36, 1), opacity 300ms ease; touch-action: none; }
    .row.moving { transition: none; }
    .row {
      display: flex; align-items: center; gap: 4px; padding: 6px;
      background: #1f1b17; border: 1px solid #2e2924; border-radius: 12px;
    }
    .open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 0; border: none; background: transparent; text-align: left; color: inherit; }
    .art { width: 44px; --cover-radius: 6px; }
    .names { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { font-size: 12px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .line { margin: -1px 12px 0; height: 2px; background: #2e2924; border-radius: 2px; overflow: hidden; }
    .line span { display: block; height: 100%; background: var(--accent); }
  `],
})
export class MiniPlayerComponent {
  protected readonly player = inject(PlayerService);
  protected readonly ui = inject(UiService);
  /** How far the row follows a sideways swipe (px). */
  protected readonly shift = signal(0);
  /** A finger on it (or the jump to the far side): it moves without easing. */
  protected readonly held = signal(false);
  protected readonly Math = Math;

  protected moved(swipe: Swipe): void {
    this.held.set(true);
    this.shift.set(swipe.axis === 'x' ? swipe.dx : 0);
  }

  /** Up opens Now Playing; a sideways flick glides the row off, changes the song, and glides it back. */
  protected swiped(swipe: Swipe): void {
    this.held.set(false);
    if (swipe.axis === 'y') {
      this.shift.set(0);
      if (swipe.dy < -30 || (swipe.vy ?? 0) < -0.4) this.ui.nowPlayingOpen.set(true);
      return;
    }
    const forward = swipe.dx < 0;
    if ((Math.abs(swipe.dx) < 70 && Math.abs(swipe.vx ?? 0) < 0.45) || (forward && !this.player.hasNext())) {
      this.shift.set(0);
      return;
    }
    this.shift.set(forward ? -innerWidth : innerWidth);
    setTimeout(() => {
      if (forward) this.player.next();
      else this.player.previous();
      this.held.set(true);
      this.shift.set(forward ? innerWidth * 0.5 : -innerWidth * 0.5);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        this.held.set(false);
        this.shift.set(0);
      }));
    }, 200);
  }
}
