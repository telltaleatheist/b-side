import { Location, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { ConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog.component';
import { CoverComponent } from './components/cover/cover.component';
import { HubPickerComponent } from './components/hub-picker/hub-picker.component';
import { IconComponent, type IconName } from './components/icon/icon.component';
import { MiniPlayerComponent } from './components/mini-player/mini-player.component';
import { NowPlayingComponent } from './components/now-playing/now-playing.component';
import { PlayerBarComponent } from './components/player-bar/player-bar.component';
import { WelcomeComponent } from './components/welcome/welcome.component';
import { SINGLES_NAME, type Playlist } from '@shared/types';

import { albumProgress, type AlbumProgress } from './core/album-progress';
import { HubService } from './core/hub.service';
import { ImportService } from './core/import.service';
import { SwipeDirective, type Swipe } from './core/swipe.directive';
import { LibraryService } from './core/library.service';
import { PeersService, peerId } from './core/peers.service';
import { PlayerService } from './core/player.service';
import { UiService } from './core/ui.service';
import { FoldersService, type DropTarget, type ShelfItem } from './core/folders.service';

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
    IconComponent, MiniPlayerComponent, NowPlayingComponent, PlayerBarComponent, SwipeDirective, WelcomeComponent,
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
        @if (library.playlists().length > 0 || library.folders().length > 0) {
          <!-- Dropped in the open space of the list, an album, playlist or folder leaves its folder for the top. -->
          <div class="side-list" [attr.data-drop]="folders.mark(top)" (dragover)="folders.over($event, top)" (drop)="dropOn($event, top)">
            <span class="side-head">
              <span class="kicker">Playlists</span>
              <button type="button" class="side-add" aria-label="New folder" title="New folder: group albums and playlists" (click)="namingFolder.set(!namingFolder())"><app-icon name="plus" [size]="16" /></button>
            </span>
            @if (namingFolder()) {
              <form class="side-new" (submit)="$event.preventDefault(); makeFolder(folderName.value)">
                <input #folderName type="text" maxlength="120" placeholder="New folder" aria-label="New folder name" (keydown.escape)="namingFolder.set(false)" />
              </form>
            }
            @if (folderRefusal(); as refused) { <span class="side-refusal" role="alert">{{ refused }}</span> }
            <ng-container *ngTemplateOutlet="sideShelf; context: { $implicit: null }" />
          </div>
        }
        @for (offer of peers.offered(); track offer.hostname) {
          <div class="side-offer">
            <span>{{ offer.name ?? offer.hostname.replace('.local', '') }} shared their library with you.</span>
            <span class="side-offer-acts">
              <button type="button" class="primary small" (click)="peers.accept(offer)">Add it</button>
              <button type="button" class="ghost small" (click)="peers.dismiss(offer)">No thanks</button>
            </span>
          </div>
        }
        @for (peer of peers.present(); track peer.url) {
          @if ((peer.library?.playlists?.length ?? 0) > 0) {
            <div class="side-list">
              <span class="kicker">{{ peers.name(peer) }}'s library</span>
              @for (playlist of peer.library?.playlists ?? []; track playlist.id) {
                <a class="side-item" [routerLink]="['/peer', peerId(peer), playlist.id]" routerLinkActive="on">
                  <app-cover class="side-art" [key]="peerId(peer) + playlist.id" [src]="peers.coverUrl(peerId(peer), playlist)" />
                  <span class="side-names">
                    <span class="side-name">{{ playlist.name }}</span>
                    <span class="side-sub">{{ playlist.songs.length }} {{ playlist.songs.length === 1 ? 'song' : 'songs' }}</span>
                    @if (making(playlist); as progress) {
                      <span class="side-progress" [class.sliding]="progress.waiting" [title]="progress.label">
                        <span [style.width.%]="progress.share * 100"></span>
                      </span>
                    }
                  </span>
                </a>
              }
            </div>
          }
        }
        <div class="side-foot">
          <ng-container *ngTemplateOutlet="status" />
        </div>
      </aside>

      <header class="phone-top">
        <span class="wordmark">B-SIDES</span>
        <ng-container *ngTemplateOutlet="status" />
      </header>

      <main class="room" appSwipe="x" [swipeEdge]="30" (swipeMove)="edgeMove($event)" (swipeEnd)="edgeEnd($event)" (swipeCancel)="edgePull.set(0)"
            [class.edge-moving]="edgeHeld()" [style.transform]="edgePull() !== 0 ? 'translateX(' + edgePull() + 'px)' : null"
            [style.opacity]="edgePull() !== 0 ? 1 - Math.min(0.5, Math.abs(edgePull()) / innerWidthPx) : null">
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
                  <p class="detail">Use B-Sides running on a computer: its playlists, its servers. Point the camera at the code in its Settings → Other devices, or type its address.</p>
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
          @if (peers.pairNote(); as note) {
            <div class="pair-note"><span>{{ note }}</span><button type="button" class="ghost small" (click)="peers.pairNote.set(null)">OK</button></div>
          }
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
    @if (hub.kind === 'desktop' && hub.state() !== 'key') { <app-welcome /> }
    @if (dropInto(); as into) {
      <div class="drop-hint" role="status"><app-icon name="queue-add" [size]="20" />Drop to add to <strong>{{ into }}</strong></div>
    }
    @if (player.ready(); as offer) {
      <div class="import-toast" role="status">
        <span><strong>{{ offer.name }}</strong> is ready.</span>
        <button type="button" class="ghost small" (click)="player.playReady()">Play it</button>
        <button type="button" class="ghost small" (click)="player.dismissReady()">Later</button>
      </div>
    }
    @if (importer.state(); as state) {
      <div class="import-toast" role="status">
        <span>{{ state.finished ? 'Added ' + state.done + ' of ' + state.of : 'Adding ' + (state.done + 1) + ' of ' + state.of }} {{ state.of === 1 ? 'song' : 'songs' }} to <strong>{{ state.into }}</strong>{{ state.finished ? '' : '…' }}</span>
        @for (problem of state.problems; track problem) { <span class="import-problem">{{ problem }}</span> }
        @if (state.finished) { <button type="button" class="ghost small" (click)="importer.dismiss()">OK</button> }
      </div>
    }

    <!-- One level of the sidebar's list: its folders (each opening onto the next level), then its albums and playlists. -->
    <ng-template #sideShelf let-parent>
      @for (folder of library.foldersIn(parent); track folder.id) {
        <div class="side-folder" draggable="true" [class.open]="folders.isOpen(folder.id)" [attr.data-drop]="folders.mark(edge(folder.id))"
             (dragstart)="folders.dragStart($event, shelfFolder(folder.id))" (dragend)="folders.dragEnd()"
             (dragover)="folders.over($event, edge(folder.id))" (drop)="dropOn($event, edge(folder.id))">
          <button type="button" class="side-folder-btn" [attr.aria-expanded]="folders.isOpen(folder.id)" (click)="folders.toggle(folder.id)">
            <app-icon name="chevron" [size]="14" class="side-chev" />
            <app-icon name="folder" [size]="18" class="side-folder-icon" />
            <span class="side-name">{{ folder.name }}</span>
          </button>
          <button type="button" class="side-play" aria-label="Play folder" title="Play folder: every album and playlist in it, in order" (click)="player.playFolder(folder.id)"><app-icon name="play" [size]="16" /></button>
        </div>
        @if (folders.isOpen(folder.id)) {
          <div class="side-nest" [attr.data-drop]="folders.mark(inside(folder.id))" (dragover)="folders.over($event, inside(folder.id))" (drop)="dropOn($event, inside(folder.id))">
            <ng-container *ngTemplateOutlet="sideShelf; context: { $implicit: folder.id }" />
            @if (library.foldersIn(folder.id).length === 0 && library.playlistsIn(folder.id).length === 0) {
              <span class="side-empty">Drag albums and playlists here</span>
            }
          </div>
        }
      }
      @for (playlist of library.playlistsIn(parent); track playlist.id) {
        <a class="side-item" [routerLink]="['/library', playlist.id]" routerLinkActive="on" [attr.data-drop-playlist]="playlist.id" [attr.data-drop]="folders.mark(onPlaylist(playlist.id))"
           (dragstart)="folders.dragStart($event, shelfPlaylist(playlist.id))" (dragend)="folders.dragEnd()"
           (dragover)="folders.over($event, onPlaylist(playlist.id))" (drop)="dropOn($event, onPlaylist(playlist.id))">
          <app-cover class="side-art" [key]="playlist.id" [src]="hub.coverUrl(playlist)" />
          <span class="side-names">
            <span class="side-name">{{ playlist.name }}</span>
            <span class="side-sub">{{ playlist.songs.length }} {{ playlist.songs.length === 1 ? 'song' : 'songs' }}</span>
            @if (making(playlist); as progress) {
              <!-- An album being made: how far along, without opening it (Victoria, 2026-10-10). -->
              <span class="side-progress" [class.sliding]="progress.waiting" [title]="progress.label">
                <span [style.width.%]="progress.share * 100"></span>
              </span>
            }
          </span>
        </a>
      }
    </ng-template>

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
    .room { transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1), opacity 320ms ease; }
    .room.edge-moving { transition: none; }
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
    .pair-note { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 16px; font-size: 13px; background: var(--accent-faint); border-bottom: 1px solid var(--border-subtle); }
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
      .side-head { display: flex; align-items: center; justify-content: space-between; }
      .side-head .kicker { padding-bottom: 0; }
      .side-add { width: 28px; height: 28px; padding: 0; border: none; border-radius: 50%; background: transparent; color: var(--text-tertiary); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
      .side-add:hover { background: var(--bg-hover); color: var(--accent); }
      .side-new { padding: 4px 8px; }
      .side-new input { width: 100%; }
      .side-refusal { padding: 2px 12px; font-size: 12px; color: var(--error); }
      /* Folders (Victoria, 2026-10-11): a row that opens and shuts, its contents indented beneath it. */
      .side-folder { display: flex; align-items: center; border-radius: var(--radius-md); cursor: grab; }
      .side-folder:hover { background: var(--bg-hover); }
      .side-folder-btn { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 8px; border: none; background: transparent; color: var(--text-secondary); text-align: left; cursor: pointer; }
      .side-folder-btn:hover { color: var(--text-primary); }
      .side-chev { color: var(--text-muted); transition: transform .15s ease; }
      .side-folder.open .side-chev { transform: rotate(90deg); }
      .side-folder-icon { color: var(--accent); }
      .side-play { width: 32px; height: 32px; flex: none; padding: 0; border: none; border-radius: 50%; background: transparent; color: var(--text-tertiary); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0; }
      .side-folder:hover .side-play, .side-play:focus-visible { opacity: 1; }
      .side-play:hover { color: var(--accent); }
      .side-nest { display: flex; flex-direction: column; gap: 2px; margin-left: 15px; padding-left: 6px; border-left: 1px solid var(--border-subtle); min-height: 12px; }
      .side-empty { padding: 6px 8px; font-size: 11px; color: var(--text-muted); }
      .side-item { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: var(--radius-md); text-decoration: none; color: var(--text-secondary); }
      .side-item:hover { background: var(--bg-hover); }
      .side-item.on { background: var(--bg-active); color: var(--text-primary); }
      .side-art { width: 36px; --cover-radius: 4px; }
      .side-names { display: flex; flex-direction: column; min-width: 0; }
      .side-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .side-sub { font-size: 11px; color: var(--text-muted); }
      .side-progress { display: block; height: 3px; margin-top: 4px; border-radius: 2px; background: var(--bg-hover); overflow: hidden; }
      .side-progress span { display: block; height: 100%; background: var(--accent); border-radius: 2px; transition: width .4s ease; }
      .side-progress.sliding span { width: 30% !important; animation: side-slide 1.4s ease-in-out infinite; }
      @keyframes side-slide { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
      .side-foot { margin-top: auto; padding: 0 8px; }
      .side-offer { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--accent-faint); font-size: 12px; color: var(--text-primary); }
      .side-offer-acts { display: flex; gap: 6px; }
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
  protected readonly peers = inject(PeersService);
  protected readonly peerId = peerId;
  protected readonly ui = inject(UiService);
  // Built with the shell, so a song that lands while another room is open still plays.
  protected readonly player = inject(PlayerService);

  // ── folders in the sidebar (Victoria, 2026-10-11) ───────────────────────────
  protected readonly folders = inject(FoldersService);
  protected readonly namingFolder = signal(false);
  protected readonly folderRefusal = signal<string | null>(null);
  protected readonly top: DropTarget = { kind: 'folder', id: null, edge: false };

  protected edge(id: string): DropTarget {
    return { kind: 'folder', id, edge: true };
  }

  protected inside(id: string): DropTarget {
    return { kind: 'folder', id, edge: false };
  }

  protected onPlaylist(id: string): DropTarget {
    return { kind: 'playlist', id };
  }

  protected shelfFolder(id: string): ShelfItem {
    return { kind: 'folder', id };
  }

  protected shelfPlaylist(id: string): ShelfItem {
    return { kind: 'playlist', id };
  }

  protected dropOn(event: DragEvent, target: DropTarget): void {
    if (this.folders.dragging() === null) return;
    void this.folders.drop(event, target).then((refusal) => this.folderRefusal.set(refusal?.message ?? null));
  }

  protected async makeFolder(name: string): Promise<void> {
    if (name.trim() === '') return;
    const made = await this.library.createFolder(name);
    this.folderRefusal.set('code' in made ? made.message : null);
    if (!('code' in made)) this.namingFolder.set(false);
  }

  /** An album being made (and not interrupted): its progress, for the sidebar's bar. */
  protected making(playlist: Playlist): AlbumProgress | null {
    const album = playlist.album;
    if (album == null || album.working === false || !['planning', 'cover', 'making'].includes(album.stage)) return null;
    return albumProgress(album);
  }

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
    // A folder drag over nowhere it can land (a target stops its own dragover): no mark is shown.
    if (this.folders.dragging() !== null && this.folders.dropAt() !== null) this.folders.dropAt.set(null);
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

  private readonly router = inject(Router);
  private readonly location = inject(Location);
  /** How far the page follows a swipe in from the left edge (px). */
  protected readonly edgePull = signal(0);
  protected readonly edgeHeld = signal(false);
  protected readonly Math = Math;
  protected get innerWidthPx(): number {
    return innerWidth;
  }
  /** Pages visited in this run: back goes through them, as iOS's own back swipe does. */
  private visited = 0;

  constructor() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) this.visited += 1;
    });
  }

  protected edgeMove(swipe: Swipe): void {
    this.edgeHeld.set(true);
    this.edgePull.set(Math.max(0, swipe.dx));
  }

  /** A swipe in from the left edge goes back a page: a playlist back to the Library, else the page before. */
  protected edgeEnd(swipe: Swipe): void {
    const far = swipe.dx > 90 || (swipe.vx ?? 0) > 0.5;
    this.edgeHeld.set(false);
    const url = this.router.url;
    const parent = /^\/(library|cloud)\/[^/]+/.test(url);
    if (!far || swipe.dx <= 0 || (!parent && this.visited <= 1)) {
      this.edgePull.set(0);
      return;
    }
    // The page glides off to the right, the one before comes in from the left.
    this.edgePull.set(innerWidth);
    setTimeout(() => {
      if (parent) void this.router.navigate(['/library']);
      else this.location.back();
      this.edgeHeld.set(true);
      this.edgePull.set(-innerWidth * 0.3);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        this.edgeHeld.set(false);
        this.edgePull.set(0);
      }));
    }, 240);
  }

  /** `crucible@owens-pc-wsl` reads as `owens-pc-wsl`: the machine is what a person recognises. */
  protected serverName(name: string): string {
    return name.replace(/^crucible@/, '');
  }
}
