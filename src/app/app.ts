import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { ConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog.component';
import { CoverComponent } from './components/cover/cover.component';
import { HubPickerComponent } from './components/hub-picker/hub-picker.component';
import { IconComponent, type IconName } from './components/icon/icon.component';
import { MiniPlayerComponent } from './components/mini-player/mini-player.component';
import { NowPlayingComponent } from './components/now-playing/now-playing.component';
import { PlayerBarComponent } from './components/player-bar/player-bar.component';
import { SINGLES_NAME } from '@shared/types';

import { HubService } from './core/hub.service';
import { ImportService } from './core/import.service';
import { LibraryService } from './core/library.service';
import { PlayerService } from './core/player.service';
import { UiService } from './core/ui.service';

interface Room {
  readonly path: string;
  readonly label: string;
  readonly icon: IconName;
  readonly exact: boolean;
}

/**
 * The shell, Night Deck: the same parts on every screen size, arranged by CSS.
 *
 *   wide (a desktop window, a browser):  sidebar | the room | Now Playing panel
 *                                        the player bar across the bottom
 *   narrow (the phone):                  a slim header, the room, the mini
 *                                        player, the tabs; Now Playing opens
 *                                        full screen from the mini player
 *
 * The player sits outside the router, so a song keeps playing while another
 * room is open. A device with no hub, or with a key the hub refuses, sees the
 * hub picker instead of the room.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:dragover)': 'dragOver($event)',
    '(document:dragleave)': 'dragLeave($event)',
    '(document:drop)': 'drop($event)',
  },
  imports: [
    NgTemplateOutlet, RouterOutlet, RouterLink, RouterLinkActive, ConfirmDialogComponent, HubPickerComponent, CoverComponent,
    IconComponent, MiniPlayerComponent, NowPlayingComponent, PlayerBarComponent,
  ],
  template: `
    <div class="shell">
      <aside class="sidebar">
        <span class="wordmark">B-SIDES</span>
        <nav class="side-rooms" aria-label="Sections">
          @for (room of rooms; track room.path) {
            <a [routerLink]="room.path" routerLinkActive="on" [routerLinkActiveOptions]="{ exact: room.exact }">
              <app-icon [name]="room.icon" [size]="20" />{{ room.label }}
            </a>
          }
        </nav>
        @if (library.playlists().length > 0) {
          <div class="side-list">
            <span class="kicker">Playlists</span>
            @for (playlist of library.playlists(); track playlist.id) {
              <a class="side-item" [routerLink]="['/library', playlist.id]" routerLinkActive="on" [attr.data-drop-playlist]="playlist.id">
                <app-cover class="side-art" [key]="playlist.id" [src]="hub.coverUrl(playlist)" />
                <span class="side-names">
                  <span class="side-name">{{ playlist.name }}</span>
                  <span class="side-sub">{{ playlist.songs.length }} {{ playlist.songs.length === 1 ? 'song' : 'songs' }}</span>
                </span>
              </a>
            }
          </div>
        }
        <div class="side-foot">
          <ng-container *ngTemplateOutlet="status" />
        </div>
      </aside>

      <header class="phone-top">
        <span class="wordmark">B-SIDES</span>
        <ng-container *ngTemplateOutlet="status" />
      </header>

      <main class="room">
        @if (hub.state() === 'key' || hub.state() === 'no-hub') {
          <div class="gate">
            <div class="card">
              <h2 class="card-title">{{ hub.state() === 'key' ? 'This device needs a new B-Sides link' : 'Set up B-Sides' }}</h2>
              @if (hub.state() === 'key') {
                <p class="detail">The B-Sides at {{ hub.address()?.url }} did not accept this device's key (it may have been replaced).</p>
                <app-hub-picker />
              } @else if (hub.kind === 'ios') {
                <div class="choice">
                  <span class="door-name">Use a Crucible server</span>
                  <p class="detail">This phone makes songs on a Crucible server by itself, and keeps your playlists on the phone. You add the server next, by its name or address.</p>
                  <button type="button" class="primary" (click)="hub.usePhone()">Use a Crucible server</button>
                </div>
                <div class="choice">
                  <span class="door-name">Connect to a B-Sides computer</span>
                  <p class="detail">Use B-Sides running on a computer: its playlists, its servers. Paste the link its Settings shows.</p>
                  <app-hub-picker />
                </div>
                <p class="hint">Either way, Settings switches later.</p>
              } @else {
                <p class="detail">This app plays and makes songs through B-Sides running on a computer.</p>
                <app-hub-picker />
              }
            </div>
          </div>
        } @else {
          @if (hub.state() === 'reconnecting' && hub.trouble(); as trouble) {
            <div class="trouble">{{ trouble }}</div>
          }
          <router-outlet />
        }
      </main>

      <aside class="panel"><app-now-playing mode="panel" /></aside>
      <app-player-bar class="bar" />

      <div class="phone-bottom">
        <app-mini-player />
        <nav class="tabs" aria-label="Sections">
          @for (room of rooms; track room.path) {
            <a [routerLink]="room.path" routerLinkActive="on" [routerLinkActiveOptions]="{ exact: room.exact }">
              <app-icon [name]="room.icon" />
              <span>{{ room.label }}</span>
            </a>
          }
        </nav>
      </div>
    </div>

    @if (ui.nowPlayingOpen()) { <app-now-playing mode="sheet" /> }
    <app-confirm-dialog />
    @if (dropInto(); as into) {
      <div class="drop-hint" role="status"><app-icon name="queue-add" [size]="20" />Drop to add to <strong>{{ into }}</strong></div>
    }
    @if (importer.state(); as state) {
      <div class="import-toast" role="status">
        <span>{{ state.finished ? 'Added ' + state.done + ' of ' + state.of : 'Adding ' + (state.done + 1) + ' of ' + state.of }} {{ state.of === 1 ? 'song' : 'songs' }} to <strong>{{ state.into }}</strong>{{ state.finished ? '' : '…' }}</span>
        @for (problem of state.problems; track problem) { <span class="import-problem">{{ problem }}</span> }
        @if (state.finished) { <button type="button" class="ghost small" (click)="importer.dismiss()">OK</button> }
      </div>
    }

    <ng-template #status>
      @switch (hub.state()) {
        @case ('reconnecting') { <span class="server none" [title]="hub.trouble() ?? ''">Reconnecting…</span> }
        @case ('connecting') { <span class="server">Connecting…</span> }
        @default {
          @if (hub.activeServer(); as active) {
            <span class="server" [title]="active.url"><span class="dot"></span>{{ serverName(active.name) }}</span>
          } @else if (hub.loaded()) {
            <a class="server none" routerLink="/settings">No Crucible server</a>
          }
        }
      }
    </ng-template>
  `,
  styles: [`
    .drop-hint, .import-toast {
      position: fixed; left: 50%; bottom: calc(var(--player-h, 80px) + 18px); transform: translateX(-50%); z-index: 80;
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap; max-width: min(560px, calc(100vw - 32px));
      padding: 12px 16px; border-radius: var(--radius-md); background: var(--bg-elevated); color: var(--text-primary);
      border: 1px solid var(--accent); box-shadow: 0 18px 40px rgba(0,0,0,.5); font-size: 14px;
    }
    .drop-hint { pointer-events: none; }
    .import-problem { flex-basis: 100%; font-size: 12px; color: var(--warn); }
    :host ::ng-deep .drop-target { outline: 2px solid var(--accent); outline-offset: -2px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--accent) 10%, transparent); }
    :host { display: block; height: 100vh; }
    .shell {
      height: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: auto minmax(0, 1fr) auto;
      grid-template-areas: "top" "room" "bottom";
      background: var(--bg-base);
    }
    .sidebar, .panel, .bar { display: none; }
    .phone-top {
      grid-area: top; display: flex; align-items: center; justify-content: space-between;
      padding: calc(env(safe-area-inset-top) + 8px) 20px 8px;
    }
    .room { grid-area: room; min-height: 0; overflow-y: auto; position: relative; }
    .phone-bottom { grid-area: bottom; display: flex; flex-direction: column; gap: 6px; padding-top: 6px; background: var(--bg-base); }
    .tabs {
      display: flex; justify-content: space-around;
      padding: 6px 8px calc(env(safe-area-inset-bottom) + 6px);
      border-top: 1px solid var(--border-subtle); background: #100e0c;
    }
    .tabs a {
      display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 64px; padding: 4px 0;
      font-size: 11px; color: var(--text-tertiary); text-decoration: none;
    }
    .tabs a.on { color: var(--accent); }

    .wordmark {
      font-family: var(--font-display); font-weight: 900; font-size: 28px; letter-spacing: 0.02em;
      color: var(--accent); text-shadow: 0 0 18px rgba(34, 211, 238, 0.45);
    }
    .server {
      display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
      font-family: var(--font-mono); font-size: 11px; color: var(--text-tertiary);
      border: 1px solid var(--border-subtle); border-radius: 999px; padding: 4px 10px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-decoration: none;
    }
    .server.none { color: var(--warn); border-color: var(--warn-soft); }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex: none; }

    .gate { padding: 24px 16px; }
    .gate .card { max-width: 560px; margin: 0 auto; }
    .choice { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border-subtle); padding-top: 14px; }
    .choice button { align-self: flex-start; }
    .door-name { font-weight: 600; }
    .trouble { padding: 6px 20px; font-size: 12px; color: var(--warn); background: var(--bg-sunken); border-bottom: 1px solid var(--border-subtle); }

    /* ── wide: the desktop window, a browser ─────────────────────────────── */
    @media (min-width: 960px) {
      .shell {
        grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
        grid-template-rows: minmax(0, 1fr) var(--player-h);
        grid-template-areas: "side room" "bar bar";
      }
      .phone-top, .phone-bottom { display: none; }
      .sidebar {
        grid-area: side; display: flex; flex-direction: column; gap: 22px; min-height: 0; overflow-y: auto;
        padding: 26px 14px 16px; background: #100e0c; border-right: 1px solid var(--border-subtle);
      }
      .sidebar .wordmark { padding: 0 12px; font-size: 30px; }
      .side-rooms { display: flex; flex-direction: column; gap: 2px; }
      .side-rooms a {
        display: flex; align-items: center; gap: 12px; height: 40px; padding: 0 12px; border-radius: var(--radius-md);
        color: var(--text-secondary); font-size: 14px; font-weight: 600; text-decoration: none;
      }
      .side-rooms a:hover { background: var(--bg-hover); color: var(--text-primary); }
      .side-rooms a.on { background: var(--accent-faint); color: var(--accent); }
      .side-list { display: flex; flex-direction: column; gap: 2px; }
      .side-list .kicker { padding: 0 12px 6px; }
      .side-item { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: var(--radius-md); text-decoration: none; color: var(--text-secondary); }
      .side-item:hover { background: var(--bg-hover); }
      .side-item.on { background: var(--bg-active); color: var(--text-primary); }
      .side-art { width: 36px; --cover-radius: 4px; }
      .side-names { display: flex; flex-direction: column; min-width: 0; }
      .side-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .side-sub { font-size: 11px; color: var(--text-muted); }
      .side-foot { margin-top: auto; padding: 0 8px; }
      .bar { grid-area: bar; display: grid; }
    }
    @media (min-width: 1240px) {
      .shell {
        grid-template-columns: var(--sidebar-w) minmax(0, 1fr) var(--panel-w);
        grid-template-areas: "side room panel" "bar bar bar";
      }
      .panel { grid-area: panel; display: flex; flex-direction: column; min-height: 0; background: #12100e; border-left: 1px solid var(--border-subtle); }
      .panel app-now-playing { flex: 1; }
    }
  `],
})
export class App {
  protected readonly hub = inject(HubService);
  protected readonly library = inject(LibraryService);
  protected readonly ui = inject(UiService);
  // Built with the shell, so a song that lands while another room is open still plays.
  private readonly player = inject(PlayerService);

  protected readonly rooms: readonly Room[] = [
    { path: '/', label: 'Listen', icon: 'listen', exact: true },
    { path: '/make', label: 'Make', icon: 'make', exact: false },
    { path: '/library', label: 'Library', icon: 'library', exact: false },
    { path: '/settings', label: 'Settings', icon: 'settings', exact: false },
  ];

  protected readonly importer = inject(ImportService);
  /** While files are dragged over the window: the playlist they would join (null = not dragging). */
  private readonly dropTarget = signal<{ readonly id: string | null; readonly element: Element | null } | null>(null);
  protected readonly dropInto = computed(() => {
    const target = this.dropTarget();
    if (target === null) return null;
    return target.id === null ? SINGLES_NAME : (this.library.playlist(target.id)?.name ?? SINGLES_NAME);
  });

  /** Songs dragged in from the computer: the playlist under the pointer, else New Songs. */
  protected dragOver(event: DragEvent): void {
    if (!this.carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    const element = (event.target as Element | null)?.closest?.('[data-drop-playlist]') ?? null;
    const id = element?.getAttribute('data-drop-playlist') || null;
    const now = this.dropTarget();
    if (now !== null && now.element === element) return;
    now?.element?.classList.remove('drop-target');
    element?.classList.add('drop-target');
    this.dropTarget.set({ id, element });
  }

  protected dragLeave(event: DragEvent): void {
    // Leaving the window itself (not one element for another).
    if (event.relatedTarget === null && (event.clientX <= 0 || event.clientY <= 0 || event.clientX >= innerWidth || event.clientY >= innerHeight)) this.clearDrop();
  }

  protected drop(event: DragEvent): void {
    if (!this.carriesFiles(event)) return;
    // Never let the window open the file itself.
    event.preventDefault();
    const target = this.dropTarget();
    this.clearDrop();
    if (!this.importer.offered()) return;
    const files = Array.from(event.dataTransfer?.files ?? []);
    void this.importer.importFiles(files, target?.id ?? null);
  }

  private clearDrop(): void {
    this.dropTarget()?.element?.classList.remove('drop-target');
    this.dropTarget.set(null);
  }

  private carriesFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
  }

  /** `crucible@owens-pc-wsl` reads as `owens-pc-wsl`: the machine is what a person recognises. */
  protected serverName(name: string): string {
    return name.replace(/^crucible@/, '');
  }
}
