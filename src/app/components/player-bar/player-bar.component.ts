import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { clockText } from '../../core/format';
import { PlayerService } from '../../core/player.service';
import { CoverComponent } from '../cover/cover.component';
import { IconComponent } from '../icon/icon.component';

/** The desktop's player, across the bottom: what is playing, the controls and the scrubber, where it plays from. */
@Component({
  selector: 'app-player-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CoverComponent, IconComponent],
  template: `
    <div class="now">
      @if (player.current(); as item) {
        <app-cover class="art" [key]="item.id + (item.tags ?? '')" [src]="item.art" />
        <div class="names">
          <span class="title">{{ item.title }}</span>
          <span class="sub">{{ item.tags ?? '' }}</span>
        </div>
      } @else {
        <span class="hint">Nothing playing yet — finished songs play here</span>
      }
    </div>
    <div class="middle">
      <div class="buttons">
        <button type="button" class="icon-btn toggle" aria-label="Shuffle" [class.on]="player.shuffle()" [attr.aria-pressed]="player.shuffle()"
                [title]="player.shuffle() ? 'Shuffle is on' : 'Shuffle'" (click)="player.toggleShuffle()"><app-icon name="shuffle" [size]="18" /></button>
        <button type="button" class="icon-btn" aria-label="Previous" title="Previous (restarts the song after 3 s)"
                [disabled]="!player.hasPrevious()" (click)="player.previous()"><app-icon name="prev" [size]="20" /></button>
        <button type="button" class="play" [attr.aria-label]="player.paused() ? 'Play' : 'Pause'"
                [disabled]="player.current() === null" (click)="player.toggle()">
          <app-icon [name]="player.paused() ? 'play' : 'pause'" [size]="22" />
        </button>
        <button type="button" class="icon-btn" aria-label="Next" [disabled]="!player.hasNext()" (click)="player.next()"><app-icon name="next" [size]="20" /></button>
        <button type="button" class="icon-btn toggle" [class.on]="player.repeat() !== 'off'" [attr.aria-label]="repeatLabel()" [title]="repeatLabel()"
                (click)="player.cycleRepeat()"><app-icon [name]="player.repeat() === 'one' ? 'repeat-one' : 'repeat'" [size]="18" /></button>
      </div>
      <div class="line">
        <span class="mono time">{{ clock(scrubbing() ?? player.time()) }}</span>
        <input type="range" class="scrub" min="0" step="0.1" aria-label="Position in the song"
               [max]="player.duration()" [value]="scrubbing() ?? player.time()"
               [disabled]="player.current() === null"
               (input)="scrubbing.set(+$any($event.target).value)"
               (change)="seek(+$any($event.target).value)" />
        <span class="mono time">{{ clock(player.duration()) }}</span>
      </div>
    </div>
    <div class="source mono">
      @if (player.problem(); as problem) { <span class="problem">{{ problem }}</span> }
      @else if (player.waiting()) { <span>waiting for the next song</span> }
      @else { <span>{{ player.sourceName() }}</span> }
    </div>
  `,
  styles: [`
    :host {
      display: grid; grid-template-columns: minmax(0, 300px) minmax(0, 1fr) minmax(0, 300px); align-items: center; gap: 24px;
      height: var(--player-h); padding: 0 24px;
      border-top: 1px solid var(--border-subtle); background: #151210;
    }
    .now { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .art { width: 52px; }
    .names { display: flex; flex-direction: column; min-width: 0; }
    .title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { font-size: 12px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .middle { display: flex; flex-direction: column; align-items: center; gap: 4px; }
    .buttons { display: flex; align-items: center; gap: 14px; }
    .play {
      width: 44px; height: 44px; border: none; border-radius: 50%; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--accent); color: var(--text-inverse);
    }
    .play:hover:not(:disabled) { background: var(--accent-hover); }
    .play:disabled { opacity: 0.4; }
    .line { display: flex; align-items: center; gap: 10px; width: 100%; max-width: 560px; }
    .scrub { flex: 1; padding: 0; border: none; background: transparent; box-shadow: none; accent-color: var(--text-primary); }
    .time { font-size: 11px; color: var(--text-tertiary); min-width: 34px; text-align: center; }
    .source { justify-self: end; font-size: 11px; color: var(--text-tertiary); text-align: right; }
    .problem { color: var(--warn); }
    .toggle { color: var(--text-tertiary); position: relative; }
    .toggle.on { color: var(--accent); }
    .toggle.on::after { content: ''; position: absolute; bottom: 3px; left: 50%; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: var(--accent); }
  `],
})
export class PlayerBarComponent {
  protected readonly player = inject(PlayerService);
  /** The scrubber's position while it is being dragged; null otherwise. */
  protected readonly scrubbing = signal<number | null>(null);

  protected repeatLabel(): string {
    const mode = this.player.repeat();
    return mode === 'off' ? 'Repeat' : mode === 'all' ? 'Repeating the queue' : 'Repeating this song';
  }

  protected clock(seconds: number): string {
    return clockText(seconds);
  }

  protected seek(seconds: number): void {
    this.player.seek(seconds);
    this.scrubbing.set(null);
  }
}
