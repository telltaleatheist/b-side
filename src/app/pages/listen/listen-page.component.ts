import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { CoverComponent } from '../../components/cover/cover.component';
import { IconComponent } from '../../components/icon/icon.component';
import { QueuePanelComponent } from '../../components/queue-panel/queue-panel.component';
import { HubService } from '../../core/hub.service';
import { JobsService } from '../../core/jobs.service';
import { LibraryService } from '../../core/library.service';
import { PlayerService } from '../../core/player.service';

/**
 * Listen, the first room: what is on now, the playing list (songs made and not
 * yet saved, plus the ones being made), and the playlists as covers to play.
 */
@Component({
  selector: 'app-listen-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, CoverComponent, IconComponent, QueuePanelComponent],
  template: `
    <div class="page">
      @if (player.current(); as item) {
        <section class="on-air">
          <span class="kicker amber">{{ jobs.generating() ? 'On air · making more' : 'On air' }}</span>
          <div class="hero">
            <app-cover class="hero-art" [key]="item.id + (item.tags ?? '')" [src]="item.art" />
            <div class="hero-text">
              <span class="hero-title">{{ item.title }}</span>
              <span class="hero-sub">{{ item.tags ?? '' }}</span>
              <span class="hero-from mono">from {{ player.sourceName() }}</span>
            </div>
          </div>
        </section>
      } @else {
        <section class="start">
          <h1 class="page-title">Listen</h1>
          <p class="detail">Nothing playing yet. Make a few songs, or play one of your playlists.</p>
          <a class="primary" routerLink="/make"><app-icon name="make" [size]="18" />Make something</a>
        </section>
      }

      <app-queue-panel />

      @if (library.playlists().length > 0) {
        <section class="shelf">
          <div class="shelf-head">
            <h2 class="section-title">Playlists</h2>
            <a routerLink="/library">See all</a>
          </div>
          <div class="row">
            @for (playlist of library.playlists(); track playlist.id) {
              <a class="tile" [routerLink]="['/library', playlist.id]">
                <app-cover class="tile-art" [key]="playlist.id" [src]="hub.coverUrl(playlist)" />
                <span class="tile-name">{{ playlist.name }}</span>
                <span class="tile-sub">{{ playlist.songs.length }} {{ playlist.songs.length === 1 ? 'song' : 'songs' }}</span>
              </a>
            }
          </div>
        </section>
      }
    </div>
  `,
  styles: [`
    .page { max-width: 980px; margin: 0 auto; padding: 18px 20px 28px; display: flex; flex-direction: column; gap: 28px; }
    .kicker.amber { color: var(--audio); }
    .on-air { display: flex; flex-direction: column; gap: 12px; }
    .hero {
      display: flex; gap: 16px; align-items: center; padding: 14px; border-radius: 16px;
      background: linear-gradient(135deg, #1d2a2e, #191512 70%); border: 1px solid #2b3a3d;
    }
    .hero-art { width: 112px; --cover-radius: 10px; }
    .hero-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .hero-title { font-family: var(--font-display); font-weight: 800; font-size: 28px; line-height: 1; overflow-wrap: anywhere; }
    .hero-sub { font-size: 13px; color: var(--text-secondary); }
    .hero-from { font-size: 11px; color: var(--text-tertiary); }
    .start { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
    .start .primary { text-decoration: none; }
    .shelf { display: flex; flex-direction: column; gap: 12px; }
    .shelf-head { display: flex; align-items: baseline; justify-content: space-between; }
    .shelf-head a { font-size: 13px; color: var(--accent); text-decoration: none; }
    .row { display: flex; gap: 14px; overflow-x: auto; padding-bottom: 4px; scroll-snap-type: x mandatory; }
    .tile { display: flex; flex-direction: column; gap: 6px; width: 150px; flex: none; text-decoration: none; color: inherit; scroll-snap-align: start; }
    .tile-art { width: 150px; }
    .tile-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tile-sub { font-size: 12px; color: var(--text-tertiary); }
    @media (min-width: 960px) { .page { padding: 32px 40px; } .hero-art { width: 160px; } .hero-title { font-size: 40px; } }
  `],
})
export class ListenPageComponent {
  protected readonly player = inject(PlayerService);
  protected readonly library = inject(LibraryService);
  protected readonly jobs = inject(JobsService);
  protected readonly hub = inject(HubService);
  protected readonly anything = computed(() => this.library.takes().length > 0 || this.jobs.jobs().length > 0);
}
