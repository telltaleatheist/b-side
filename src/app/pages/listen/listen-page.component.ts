import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { Playlist } from '@shared/types';

import { CoverComponent } from '../../components/cover/cover.component';
import { IconComponent } from '../../components/icon/icon.component';
import { QueuePanelComponent } from '../../components/queue-panel/queue-panel.component';
import { ConfirmService } from '../../core/confirm.service';
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

      @for (playlist of making(); track playlist.id) {
        <section class="making">
          <app-cover class="making-art" [key]="playlist.id" [src]="hub.coverUrl(playlist)" />
          <a class="making-text" [routerLink]="['/library', playlist.id]">
            <span class="kicker amber">Making an album</span>
            <span class="making-name">{{ playlist.name }}</span>
            <span class="making-sub">{{ playlist.songs.length }} {{ playlist.songs.length === 1 ? 'track' : 'tracks' }} so far · {{ playlist.album?.ask?.minutes }} min album</span>
          </a>
          <div class="making-actions">
            <button type="button" class="ghost small" (click)="stop(playlist)">Stop</button>
            <button type="button" class="icon-btn" [attr.aria-label]="'Stop and delete ' + playlist.name" title="Stop and delete" (click)="remove(playlist)"><app-icon name="trash" [size]="18" /></button>
          </div>
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
    .making { display: flex; align-items: center; gap: 14px; padding: 12px; border: 1px solid #5a4126; border-radius: 14px; background: #1d1711; }
    .making-art { width: 64px; }
    .making-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; text-decoration: none; color: inherit; }
    .making-name { font-family: var(--font-display); font-weight: 800; font-size: 22px; line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .making-sub { font-size: 12px; color: var(--text-tertiary); }
    .making-actions { display: flex; align-items: center; gap: 4px; }
    .making-actions .icon-btn { color: var(--audio); }
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
  private readonly confirm = inject(ConfirmService);
  /** Albums being made right now: each with its Stop. */
  protected readonly making = computed(() => this.library.playlists().filter((playlist) => {
    const stage = playlist.album?.stage;
    return stage === 'planning' || stage === 'cover' || stage === 'making';
  }));

  /** Stop making it: no more tracks, the ones on the server cancelled; what is made stays. */
  protected async stop(playlist: Playlist): Promise<void> {
    await this.hub.call<unknown>('POST', `/api/albums/${encodeURIComponent(playlist.id)}/stop`);
  }

  /** Stop it and throw it away. */
  protected async remove(playlist: Playlist): Promise<void> {
    const yes = await this.confirm.ask({
      title: `Stop and delete "${playlist.name}"?`,
      message: 'It stops being made, its tracks on the server are cancelled, and what was made is deleted. This cannot be undone.',
      confirm: 'Stop and delete',
      danger: true,
    });
    if (!yes) return;
    await this.library.deletePlaylist(playlist.id);
  }
}
