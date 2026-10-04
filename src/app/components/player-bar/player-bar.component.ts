import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { clockText } from '../../core/format';
import { PlayerService } from '../../core/player.service';

/** The bar along the bottom: previous, play/pause, next, the scrubber, the title. */
@Component({
  selector: 'app-player-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="buttons">
      <button type="button" class="round" title="Previous (restarts the song after 3 s)"
              [disabled]="!player.hasPrevious()" (click)="player.previous()"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 2h2v12H3zM14 2v12L6 8z" fill="currentColor"/></svg></button>
      <button type="button" class="round play" [title]="player.paused() ? 'Play' : 'Pause'"
              [disabled]="player.current() === null" (click)="player.toggle()">
        @if (player.paused()) { <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 2v12l10-6z" fill="currentColor"/></svg> } @else { <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 2h4v12H3zM9 2h4v12H9z" fill="currentColor"/></svg> }
      </button>
      <button type="button" class="round" title="Next"
              [disabled]="!player.hasNext()" (click)="player.next()"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M11 2h2v12h-2zM2 2v12l8-6z" fill="currentColor"/></svg></button>
    </div>
    <div class="middle">
      <div class="title" [class.idle]="player.current() === null">{{ title() }}</div>
      <div class="line">
        <input type="range" class="scrub" min="0" step="0.1"
               aria-label="Position in the song"
               [max]="player.duration()"
               [value]="scrubbing() ?? player.time()"
               [disabled]="player.current() === null"
               (input)="scrubbing.set(+$any($event.target).value)"
               (change)="seek(+$any($event.target).value)" />
        <span class="time">{{ clock(scrubbing() ?? player.time()) }} / {{ clock(player.duration()) }}</span>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: flex; align-items: center; gap: 16px;
      height: 72px; padding: 0 20px;
      border-top: 1px solid var(--border-default);
      background: var(--bg-elevated);
    }
    .buttons { display: flex; align-items: center; gap: 6px; }
    .round {
      width: 36px; height: 36px; padding: 0;
      border-radius: 999px;
      display: inline-flex; align-items: center; justify-content: center;
      font-size: 14px; line-height: 1;
    }
    .round.play { width: 44px; height: 44px; color: var(--accent); border-color: var(--accent); font-size: 15px; }
    .middle { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .title { font-size: 12.5px; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .title.idle { color: var(--text-tertiary); }
    .line { display: flex; align-items: center; gap: 10px; }
    .scrub { flex: 1; padding: 0; border: none; background: transparent; accent-color: var(--accent); box-shadow: none; }
    .time { font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; min-width: 90px; text-align: right; }
  `],
})
export class PlayerBarComponent {
  protected readonly player = inject(PlayerService);
  /** The scrubber's position while it is being dragged; null otherwise. */
  protected readonly scrubbing = signal<number | null>(null);

  protected readonly title = computed(() => {
    const song = this.player.current();
    if (song === null) return 'Nothing playing yet — finished songs play here';
    const waiting = this.player.waiting() ? ' — waiting for the next song to finish' : '';
    const problem = this.player.problem();
    if (problem !== null) return problem;
    return `${song.title}${song.tags ? ` — ${song.tags}` : ''} · ${this.player.sourceName()}${waiting}`;
  });

  protected clock(seconds: number): string {
    return clockText(seconds);
  }

  protected seek(seconds: number): void {
    this.player.seek(seconds);
    this.scrubbing.set(null);
  }
}
