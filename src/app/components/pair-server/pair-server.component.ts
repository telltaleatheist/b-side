import { ChangeDetectionStrategy, Component, inject, OnDestroy, output, signal } from '@angular/core';

import type { PairingProgress, RefusalView } from '@shared/types';

import { HubService } from '../../core/hub.service';

/**
 * Add a Crucible server by typing its address: `owens-pc`, `192.168.1.20`,
 * `http://server:7100`. B-Sides asks the server for a connection and waits for
 * it; a server with open pairing (Crucible's default) answers at once, one
 * that asks for approval shows the code here and on its own console. The
 * token goes into the hub's server list and never comes back here.
 *
 * Once paired the server is remembered, so switching later is one tap in
 * Settings. Used by the studio's first-run card and Settings' servers card.
 */
@Component({
  selector: 'app-pair-server',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="pair" (submit)="$event.preventDefault(); begin()">
      <div class="line">
        <input type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
               placeholder="server name, address or http://server:7100" aria-label="Crucible server address"
               [value]="address()" (input)="address.set($any($event.target).value)" [disabled]="waiting() !== null" />
        @if (waiting() === null) {
          <button type="submit" class="primary" [disabled]="address().trim() === '' || starting()">
            {{ starting() ? 'Connecting…' : 'Connect' }}
          </button>
        } @else {
          <button type="button" class="ghost" (click)="cancel()">Cancel</button>
        }
      </div>
      @if (waiting(); as pending) {
        @if (pending.approvalRequired) {
          <p class="hint">Approve B-Sides on {{ pending.name }}: its console shows code <strong class="mono">{{ pending.userCode }}</strong>.</p>
        } @else {
          <p class="hint">Connecting to {{ pending.name }}…</p>
        }
      }
      @if (connected(); as name) {
        <p class="ok">Connected to {{ name }}.</p>
      }
      @if (refusal(); as refused) {
        <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
      }
    </form>
  `,
  styles: [`
    .pair { display: flex; flex-direction: column; gap: 6px; }
    .line { display: flex; gap: 6px; }
    .line input { flex: 1; min-width: 0; }
    .ok { color: var(--ok); font-size: 12px; margin: 0; }
    @media (max-width: 600px) { .line { flex-direction: column; } }
  `],
})
export class PairServerComponent implements OnDestroy {
  private readonly hub = inject(HubService);

  /** The name the new server was stored under. */
  readonly paired = output<string>();

  protected readonly address = signal('');
  protected readonly starting = signal(false);
  protected readonly waiting = signal<PairingProgress | null>(null);
  protected readonly connected = signal<string | null>(null);
  protected readonly refusal = signal<RefusalView | null>(null);
  private timer: ReturnType<typeof setTimeout> | null = null;

  protected async begin(): Promise<void> {
    this.refusal.set(null);
    this.connected.set(null);
    this.starting.set(true);
    const outcome = await this.hub.call<PairingProgress>('POST', '/api/servers/pair', { address: this.address().trim() });
    this.starting.set(false);
    if (!outcome.ok) {
      this.refusal.set(outcome.refusal);
      return;
    }
    this.waiting.set(outcome.value);
    void this.poll();
  }

  protected cancel(): void {
    const pending = this.waiting();
    this.stop();
    if (pending !== null) void this.hub.call<null>('DELETE', `/api/servers/pair/${encodeURIComponent(pending.id)}`);
  }

  ngOnDestroy(): void {
    this.cancel();
  }

  private async poll(): Promise<void> {
    const pending = this.waiting();
    if (pending === null) return;
    const outcome = await this.hub.call<PairingProgress>('POST', `/api/servers/pair/${encodeURIComponent(pending.id)}`);
    // Cancelled, or another request began, while this one ran.
    if (this.waiting()?.id !== pending.id) return;
    if (!outcome.ok) {
      this.stop();
      this.refusal.set(outcome.refusal);
      return;
    }
    const progress = outcome.value;
    switch (progress.status) {
      case 'pending':
        this.waiting.set(progress);
        this.timer = setTimeout(() => void this.poll(), progress.pollAfterMs);
        return;
      case 'approved':
        this.stop();
        this.address.set('');
        this.connected.set(progress.name);
        this.paired.emit(progress.name);
        return;
      case 'denied':
        this.stop();
        this.refusal.set({ code: 'pairing_denied', message: `${pending.name} turned the connection down.` });
        return;
      case 'expired':
        this.stop();
        this.refusal.set({ code: 'pairing_expired', message: 'The connection request ran out of time. Connect again.' });
        return;
    }
  }

  private stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.waiting.set(null);
  }
}
