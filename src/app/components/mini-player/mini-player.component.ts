import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { PlayerService } from '../../core/player.service';
import { UiService } from '../../core/ui.service';
import { CoverComponent } from '../cover/cover.component';
import { IconComponent } from '../icon/icon.component';

/** The phone's player: one row above the tabs on every screen; tap it for Now Playing. */
@Component({
  selector: 'app-mini-player',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CoverComponent, IconComponent],
  template: `
    @if (player.current(); as item) {
      <div class="row">
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
}
