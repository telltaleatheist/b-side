import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { ConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog.component';
import { HubPickerComponent } from './components/hub-picker/hub-picker.component';
import { PlayerBarComponent } from './components/player-bar/player-bar.component';
import { HubService } from './core/hub.service';
import { PlayerService } from './core/player.service';

/**
 * The shell: a top row (the name, the rooms, the hub's state, the server in
 * use), the room, and the player along the bottom — outside the router, so a
 * song keeps playing while another room is open. A device with no hub, or with
 * a key the hub refuses, sees the hub picker instead of the rooms.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, PlayerBarComponent, ConfirmDialogComponent, HubPickerComponent],
  template: `
    <div class="shell">
      <header class="top">
        <span class="brand">B-Side</span>
        <nav class="rooms">
          <a routerLink="/" routerLinkActive="on" [routerLinkActiveOptions]="{ exact: true }">Studio</a>
          <a routerLink="/playlists" routerLinkActive="on">Playlists</a>
          <a routerLink="/settings" routerLinkActive="on">Settings</a>
        </nav>
        <span class="spacer"></span>
        @switch (hub.state()) {
          @case ('reconnecting') { <span class="server none" [title]="hub.trouble() ?? ''">Reconnecting to the hub…</span> }
          @case ('connecting') { <span class="server">Connecting…</span> }
          @default {
            @if (hub.activeServer(); as active) {
              <span class="server" [title]="active.url"><span class="dot"></span>{{ active.name }}</span>
            } @else if (hub.loaded()) {
              <a class="server none" routerLink="/settings">No Crucible server — add one</a>
            }
          }
        }
      </header>
      @if (hub.state() === 'key' || hub.state() === 'no-hub') {
        <main class="room gate">
          <div class="card">
            <h2 class="card-title">{{ hub.state() === 'key' ? 'This device needs a new B-Side link' : 'Connect to B-Side' }}</h2>
            <p class="detail">
              @if (hub.state() === 'key') {
                The B-Side at {{ hub.address()?.url }} did not accept this device's key (it may have been replaced).
              } @else {
                This app plays and makes songs through B-Side running on a computer.
              }
            </p>
            <app-hub-picker />
          </div>
        </main>
      } @else {
        @if (hub.state() === 'reconnecting' && hub.trouble(); as trouble) {
          <div class="trouble">{{ trouble }}</div>
        }
        <main class="room"><router-outlet /></main>
      }
      <app-player-bar />
    </div>
    <app-confirm-dialog />
  `,
  styles: [`
    :host { display: block; height: 100vh; }
    .shell { display: flex; flex-direction: column; height: 100%; }
    .top {
      display: flex; align-items: center; gap: 18px;
      /* The phone draws under the notch: the safe-area inset is 0 everywhere else. */
      height: calc(44px + env(safe-area-inset-top)); padding: env(safe-area-inset-top) 16px 0;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-sunken);
    }
    .brand { font-family: var(--font-display); font-weight: 700; font-size: 15px; letter-spacing: -0.02em; color: var(--accent); }
    .rooms { display: flex; gap: 4px; }
    .rooms a {
      padding: 5px 10px; border-radius: var(--radius-sm);
      color: var(--text-secondary); text-decoration: none; font-size: 12.5px; font-weight: 500;
    }
    .rooms a:hover { background: var(--bg-hover); color: var(--text-primary); }
    .rooms a.on { background: var(--accent-faint); color: var(--accent); }
    .spacer { flex: 1; }
    .server { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); }
    .server.none { color: var(--warn); text-decoration: none; }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }
    .room { flex: 1; min-height: 0; overflow: hidden; }
    .room.gate { overflow-y: auto; padding: 24px 16px; }
    .gate .card { max-width: 560px; margin: 0 auto; }
    .trouble { padding: 6px 16px; font-size: 12px; color: var(--warn); background: var(--bg-sunken); border-bottom: 1px solid var(--border-subtle); }
    @media (max-width: 600px) {
      .top { gap: 10px; padding: 0 10px; }
      .brand { display: none; }
    }
  `],
})
export class App {
  protected readonly hub = inject(HubService);
  // Built with the shell, so a song that lands while another room is open still plays.
  private readonly player = inject(PlayerService);
}
