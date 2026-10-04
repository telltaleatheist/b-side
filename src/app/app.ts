import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { ConfirmDialogComponent } from './components/confirm-dialog/confirm-dialog.component';
import { PlayerBarComponent } from './components/player-bar/player-bar.component';
import { api } from './core/bside';
import { PlayerService } from './core/player.service';
import { ServersService } from './core/servers.service';

/**
 * The shell: a top row (the name, the two rooms, the server in use), the room,
 * and the player along the bottom — outside the router, so a song keeps playing
 * while Settings is open.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, PlayerBarComponent, ConfirmDialogComponent],
  template: `
    <div class="shell">
      <header class="top">
        <span class="brand">B-Side</span>
        <nav class="rooms">
          <a routerLink="/" routerLinkActive="on" [routerLinkActiveOptions]="{ exact: true }">Studio</a>
          <a routerLink="/settings" routerLinkActive="on">Settings</a>
        </nav>
        <span class="spacer"></span>
        @if (!bridged) {
          <span class="server none">Open B-Side with npm run electron:dev — this is the renderer alone</span>
        } @else if (servers.active(); as active) {
          <span class="server" [title]="active.url"><span class="dot"></span>{{ active.name }}</span>
        } @else if (servers.loaded()) {
          <a class="server none" routerLink="/settings">No Crucible server — add one</a>
        }
      </header>
      <main class="room"><router-outlet /></main>
      <app-player-bar />
    </div>
    <app-confirm-dialog />
  `,
  styles: [`
    :host { display: block; height: 100vh; }
    .shell { display: flex; flex-direction: column; height: 100%; }
    .top {
      display: flex; align-items: center; gap: 18px;
      height: 44px; padding: 0 16px;
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
  `],
})
export class App {
  protected readonly servers = inject(ServersService);
  protected readonly bridged = api !== null;
  // Built with the shell, so a song that lands while Settings is open still plays.
  private readonly player = inject(PlayerService);
}
