import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';

import type { ServerNeedsView } from '@shared/types';

import { desktop, HubService } from '../../core/hub.service';
import { UiService } from '../../core/ui.service';
import { CrucibleSetupComponent } from '../crucible-setup/crucible-setup.component';

type Step = 'choose' | 'install' | 'connect';

const NEEDS_POLL_MS = 2000;

/**
 * The desktop's first run (Owen, 2026-10-11: "it should ask the user whether they want to
 * install crucible or connect to another crucible server"). Over the app while no Crucible
 * server is set up: two doors, each the existing app-crucible-setup (never a second installer).
 * "Not now" closes it; it comes back on the next start, and from any "Set up Crucible", until a
 * server is set up. Once one is, it stays up to say so, with what B-Sides asked that server for
 * beyond YuE2 (the vocal separator, shared/core/server-needs.ts), until it is closed.
 *
 * The desktop's alone: a phone and a browser tab keep their own pairing (the shell's gate, the
 * Make page and Settings).
 */
@Component({
  selector: 'app-welcome',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CrucibleSetupComponent],
  template: `
    @if (open()) {
      <div class="scrim">
        <div class="welcome card" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
          <span class="kicker">Welcome to B-Sides</span>
          @if (connected(); as server) {
            <h2 class="card-title" id="welcome-title">Ready to make songs</h2>
            <p class="detail">B-Sides uses <strong>{{ server }}</strong>. The song model downloads the first time you make a song.</p>
            @if (needs(); as asked) {
              <p class="need" [attr.data-state]="asked.state">{{ asked.sentence }}</p>
            }
            <div class="actions">
              <button type="button" class="primary" (click)="startMaking()">Start making</button>
              <button type="button" class="ghost" (click)="close()">Close</button>
            </div>
          } @else {
            <h2 class="card-title" id="welcome-title">B-Sides makes songs on Crucible</h2>
            <p class="detail">Crucible is the AI server that runs the song model and the models around it. B-Sides needs one to make anything; your library plays without one.</p>
            @switch (step()) {
              @case ('choose') {
                <div class="doors">
                  <button type="button" class="door" (click)="step.set('install')">
                    <span class="door-name">Install Crucible on this computer</span>
                    <span class="hint">B-Sides installs it, starts it and uses it. A first install downloads several gigabytes.</span>
                  </button>
                  <button type="button" class="door" (click)="step.set('connect')">
                    <span class="door-name">Connect to another Crucible server</span>
                    <span class="hint">One already running on another computer: its name, its address, or its pairing line. A token only if it has one.</span>
                  </button>
                </div>
              }
              @case ('install') {
                <button type="button" class="back ghost small" (click)="step.set('choose')">← Back</button>
                <app-crucible-setup />
              }
              @case ('connect') {
                <button type="button" class="back ghost small" (click)="step.set('choose')">← Back</button>
                <app-crucible-setup [localDoors]="false" [addByLine]="true" />
              }
            }
            <div class="foot">
              <button type="button" class="ghost small" (click)="close()">Not now</button>
              <span class="hint">Settings → Crucible servers sets one up later. Until then, making songs is off.</span>
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    .scrim {
      position: fixed; inset: 0; z-index: 90; display: flex; align-items: flex-start; justify-content: center;
      padding: 48px 16px; overflow-y: auto; background: var(--bg-overlay);
    }
    .welcome { width: min(600px, 100%); display: flex; flex-direction: column; gap: 14px; }
    .doors { display: grid; gap: 10px; }
    .door {
      display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: left;
      padding: 16px; border-radius: var(--radius-lg); border: 1px solid var(--border-default);
      background: var(--bg-sunken); color: var(--text-primary); cursor: pointer;
    }
    .door:hover { border-color: var(--accent); background: var(--accent-faint); }
    .door-name { font-size: 15px; font-weight: 600; }
    .back { align-self: flex-start; }
    .foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; border-top: 1px solid var(--border-subtle); padding-top: 12px; }
    .foot .hint { flex: 1 1 220px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .need { margin: 0; font-size: 13px; color: var(--text-secondary); }
    .need[data-state="ready"] { color: var(--ok); }
    .need[data-state="failed"] { color: var(--warn); }
    @media (max-width: 600px) { .scrim { padding: 16px; } }
  `],
})
export class WelcomeComponent {
  private readonly hub = inject(HubService);
  private readonly ui = inject(UiService);
  private readonly router = inject(Router);

  protected readonly step = signal<Step>('choose');
  protected readonly needs = signal<ServerNeedsView | null>(null);
  /** Opened while no server was set up: it stays up after one is, to say so. */
  private readonly shown = signal(false);

  protected readonly open = computed(() => desktop !== null && this.shown() && !this.ui.welcomeClosed());
  protected readonly connected = computed(() => this.hub.activeServer()?.name ?? null);

  constructor() {
    effect(() => {
      if (this.hub.needsCrucible() && !this.ui.welcomeClosed()) untracked(() => this.shown.set(true));
    });
    // What the server was asked for, while this says so (a few seconds apart; it is one GET).
    const timer = setInterval(() => {
      if (this.open() && this.connected() !== null) void this.readNeeds();
    }, NEEDS_POLL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private async readNeeds(): Promise<void> {
    const outcome = await this.hub.call<ServerNeedsView | null>('GET', '/api/server-needs');
    if (outcome.ok) this.needs.set(outcome.value);
  }

  protected close(): void {
    this.ui.welcomeClosed.set(true);
    this.shown.set(false);
    this.step.set('choose');
  }

  protected startMaking(): void {
    this.close();
    void this.router.navigate(['/make']);
  }
}
