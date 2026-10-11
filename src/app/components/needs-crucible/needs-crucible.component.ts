import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';

import { desktop, HubService } from '../../core/hub.service';
import { UiService } from '../../core/ui.service';

/**
 * The one hint beside every act that needs a Crucible server, while none is set
 * up (Owen, 2026-10-11: "it should disable all functions that would require
 * crucible if there isnt a crucible server configured"). Same words everywhere,
 * and one way on: the desktop opens its welcome (install Crucible here, or
 * connect to one); a phone or a browser tab goes to Settings' servers card,
 * where its own pairing is. Draws nothing once a server is set up.
 */
@Component({
  selector: 'app-needs-crucible',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (hub.needsCrucible()) {
      <div class="needs" role="note">
        <span class="words"><strong>No Crucible server yet.</strong> Making songs, writing tags and lyrics, and painting covers happen on a Crucible server; set one up to use them. Listening works without one.</span>
        <button type="button" class="primary small" (click)="setUp()">Set up Crucible</button>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .needs {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 12px 14px; border-radius: var(--radius-lg);
      border: 1px solid var(--warn-soft); background: var(--bg-elevated); font-size: 13px; color: var(--text-secondary);
    }
    .words { flex: 1 1 260px; min-width: 0; }
    .words strong { color: var(--warn); }
  `],
})
export class NeedsCrucibleComponent {
  protected readonly hub = inject(HubService);
  private readonly ui = inject(UiService);
  private readonly router = inject(Router);

  protected setUp(): void {
    if (desktop !== null) {
      this.ui.welcomeClosed.set(false);
      return;
    }
    void this.router.navigate(['/settings']);
  }
}
