import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, signal } from '@angular/core';

import {
  applyInstallEvent,
  initialInstallRows,
  type CrucibleInstallOutcome,
  type CrucibleInstallPlan,
  type CrucibleInstallRow,
  type CrucibleInstallStatus,
  type LocalCrucibleView,
} from '@shared/crucible-install-wire';
import type { Outcome, RefusalView, ServerView } from '@shared/types';
import type { CrucibleUninstallAvailability, CrucibleUninstallPlan } from '@shared/uninstall-wire';

import { bytesText } from '../../core/format';
import { desktop, HubService } from '../../core/hub.service';
import { PairServerComponent } from '../pair-server/pair-server.component';

/** What the Crucible on this computer offers, flattened for the template. */
type Face =
  /** Still reading this computer. */
  | 'looking'
  /** No Crucible here: offer the install. */
  | 'install'
  /** Installed and not serving: offer to start it. */
  | 'start'
  /** Serving (or published) and B-Side does not use it yet: offer to use it. */
  | 'use'
  /** B-Side uses it. */
  | 'in-use'
  /** Installed and serving, and it published no connection B-Side can read. */
  | 'unpublished'
  /** The installation itself is at fault. */
  | 'problem'
  /** Crucible has no build for this computer. */
  | 'unsupported';

/** Which act is in flight, so its button says so and the others wait. */
type Busy = 'install' | 'start' | 'use' | 'retry' | 'restart' | 'pairing' | 'uninstall-plan' | 'uninstall-run';

/**
 * Get a Crucible: install one on this computer, start or use the one already
 * here, or add one running somewhere else.
 *
 * Ported from Foundry's crucible-doors and install-outcome components (Phase 4:
 * "install crucible on the computer through the electron app setup page, or
 * pick/add a crucible server"). B-Side is for other people too, so the person
 * with nothing installed gets ONE button and is never shown a command: it
 * installs Crucible, starts it, and makes it the server B-Side uses, with the
 * install's rows filling in as it goes (crucible PHASE19 §3.1).
 *
 * Two hosts: the studio's first-run card (`[addByLine]`: also paste an existing
 * server's pairing line) and Settings' servers card (`[manage]`, and the
 * pairing box is the card's own). Installing is the desktop window's alone — it
 * goes over the preload bridge, never the hub — so a phone or a browser tab
 * reads where to do it instead, and can still add an existing server.
 */
@Component({
  selector: 'app-crucible-setup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PairServerComponent],
  template: `
    <div class="setup">
      @if (isDesktop) {
        @switch (face()) {
          @case ('looking') {
            <p class="hint">Looking for Crucible on this computer…</p>
          }
          @case ('install') {
            <div class="door">
              <span class="door-name">Install Crucible on this computer</span>
              @if (plan(); as it) { <span class="hint">{{ it.machine }}</span> }
              <span class="hint">One button: B-Side installs Crucible, starts it and uses it. A first install downloads several gigabytes and can take a while; it keeps going if you close this.</span>
              @if (!installing()) {
                <div class="actions">
                  <button type="button" class="primary" [disabled]="busy() !== null" (click)="install()">Install Crucible</button>
                </div>
              }
            </div>
          }
          @case ('start') {
            <div class="door">
              <span class="door-name">Crucible is installed on this computer and is not running</span>
              <span class="hint">{{ local()?.state?.why }}</span>
              <span class="hint">Starting it starts Crucible's own service, which keeps running after B-Side closes. B-Side then uses it.</span>
              <div class="actions">
                <button type="button" class="primary" [disabled]="busy() !== null" (click)="start()">
                  {{ busy() === 'start' ? 'Starting…' : 'Start Crucible' }}
                </button>
              </div>
            </div>
          }
          @case ('use') {
            <div class="door">
              <span class="door-name">Crucible is on this computer: {{ local()?.published?.name }}</span>
              <span class="hint mono">{{ local()?.published?.url }}</span>
              <div class="actions">
                <button type="button" class="primary" [disabled]="busy() !== null" (click)="useLocal()">
                  {{ busy() === 'use' ? 'Connecting…' : 'Use the Crucible on this computer' }}
                </button>
              </div>
            </div>
          }
          @case ('in-use') {
            <p class="hint">B-Side uses the Crucible on this computer ({{ local()?.published?.registeredAs }}).</p>
          }
          @case ('unpublished') {
            <div class="notice">Crucible is running on this computer but published no connection B-Side can read. {{ local()?.publishedRefusal ?? '' }}</div>
          }
          @case ('problem') {
            <div class="notice">
              {{ problem()?.what }}
              @if (problem()?.why; as why) { <span class="hint why">{{ why }}</span> }
            </div>
          }
          @case ('unsupported') {
            <p class="hint">{{ plan()?.unsupportedWhy }}</p>
          }
        }

        @if (rowsShown()) {
          <ol class="steps">
            @for (row of rows(); track row.id) {
              @if (row.state !== 'skipped') {
                <li [attr.data-state]="row.state">
                  <span class="step-head">
                    <span class="step-name">{{ row.label }}</span>
                    @if (row.state === 'running') { <span class="badge">now</span> }
                    @if (row.state === 'done') { <span class="badge done">done</span> }
                    @if (row.state === 'failed') { <span class="badge stopped">stopped</span> }
                  </span>
                  @if (row.detail) { <span class="hint line">{{ row.detail }}</span> }
                  @if (bytesWords(row); as bytes) { <span class="hint">{{ bytes }}</span> }
                </li>
              }
            }
          </ol>
        }
        @if (finished(); as done) { <p class="ok">{{ done }}</p> }

        @if (outcome(); as it) {
          @if (it.state === 'reboot-pending') {
            <div class="notice">
              Windows needs a restart to finish setting up Crucible's Linux engine. Everything else works in the meantime.
              <div class="actions">
                <button type="button" class="primary small" [disabled]="busy() !== null" (click)="restart()">Restart now</button>
              </div>
            </div>
          } @else if (it.state === 'cannot' || it.state === 'failed') {
            <div class="notice">
              {{ outcomeWords(it) }}
              <div class="actions">
                <button type="button" class="primary small" [disabled]="busy() !== null || installing()" (click)="retry()">
                  {{ busy() === 'retry' ? 'Trying…' : 'Try again' }}
                </button>
              </div>
            </div>
          }
        }

        @if (manage() && statusSaid(); as said) {
          <p class="hint">Crucible's installer on this computer could not say whether it is moving its engine ({{ said.code }}): {{ said.message }}</p>
        }

        @if (manage() && face() !== 'install' && face() !== 'looking' && face() !== 'unsupported' && !installing()) {
          <details class="more" (toggle)="openedMore($any($event.target).open)">
            <summary class="label">Install or update Crucible on this computer</summary>
            <p class="hint">Installs Crucible's newest release. B-Side never installs an older Crucible over a newer one, and says so if this computer already has the newest.</p>
            <div class="actions">
              <button type="button" class="ghost small" [disabled]="busy() !== null" (click)="install()">Install the newest Crucible</button>
            </div>
          </details>
        }

        @if (manage() && uninstallable()?.available) {
          <details class="more" (toggle)="toggleUninstall($any($event.target).open)">
            <summary class="label">Remove Crucible from this computer</summary>
            <label class="check">
              <input type="checkbox" [checked]="purgeWeights()" [disabled]="busy() !== null" (change)="setPurge($any($event.target).checked)" />
              <span>Also delete the downloaded models: tens of gigabytes, and a reinstall downloads every byte again. Off, they are kept and the next install finds them.</span>
            </label>
            @if (uninstallable()?.wslTooOffered) {
              <label class="check">
                <input type="checkbox" [checked]="wslToo()" [disabled]="busy() !== null" (change)="setWslToo($any($event.target).checked)" />
                <span>Also remove the Linux engine inside its WSL guest. The guest itself is never unregistered.</span>
              </label>
            }
            @if (shownPlan(); as it) {
              <div class="plan">
                @for (step of it.steps; track step.name) {
                  <div class="plan-row" [class.fatal]="step.refused?.fatal === true">
                    <span class="act">{{ step.action }}</span>
                    <span class="what">{{ step.what }}@if (step.refused; as no) { <span class="hint"> — {{ no.message }}</span> }</span>
                    @if (step.bytes !== null) { <span class="size">{{ size(step.bytes) }}</span> }
                    @if (step.done) { <span class="size">done</span> }
                  </div>
                }
              </div>
              <p class="hint">{{ planWords() }}</p>
              @if (!it.ok) {
                <div class="notice">One step refused (above, by name). Everything that did finish is gone; nothing was half-removed silently.</div>
              }
              @if (removed() === null) {
                <p class="hint">Removing Crucible removes its token, so every app that uses it, B-Side included, has to connect to it again after a reinstall.</p>
              } @else if (unregistered(); as gone) {
                <p class="hint">{{ gone }} was removed from B-Side's servers: its token went with the uninstall.</p>
              }
            }
            <div class="actions">
              @if (removed() === null) {
                @if (uninstallPlan() === null) {
                  <button type="button" class="ghost small" [disabled]="busy() !== null" (click)="readPlan()">
                    {{ busy() === 'uninstall-plan' ? 'Checking…' : 'Show me what would go' }}
                  </button>
                } @else {
                  <button type="button" class="danger small" [disabled]="busy() !== null" (click)="removeIt()">
                    {{ busy() === 'uninstall-run' ? 'Removing…' : 'Remove Crucible' }}
                  </button>
                }
              }
            </div>
          </details>
        }
      } @else {
        <p class="hint">
          Crucible is installed from the B-Side app on the computer B-Side runs on{{ hostWords() }}.
          From here you can add a Crucible server that is already running somewhere, by its address.
        </p>
      }

      @if (addByLine()) {
        <div class="door">
          <span class="door-name">Use a Crucible server</span>
          <span class="hint">A Crucible running on another computer: type its name or address. B-Side remembers it, and Settings switches between the ones you add.</span>
          <app-pair-server />
          <details>
            <summary class="hint">…or paste its pairing line</summary>
            <form class="line" (submit)="$event.preventDefault(); addPairing()">
              <input type="password" autocomplete="off" spellcheck="false" placeholder="crucible://name@host:7100/#token"
                     [value]="pairing()" (input)="pairing.set($any($event.target).value)" />
              <button type="submit" class="ghost" [disabled]="pairing().trim() === '' || busy() !== null">Add</button>
            </form>
          </details>
        </div>
      }

      @if (refusal(); as refused) {
        <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
      }
    </div>
  `,
  styles: [`
    .setup { display: flex; flex-direction: column; gap: 10px; }
    .door {
      display: flex; flex-direction: column; gap: 6px;
      border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
      padding: 10px 12px; background: var(--bg-sunken);
    }
    .door-name { font-size: 13px; font-weight: 600; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
    .line { display: flex; gap: 6px; }
    .why { display: block; margin-top: 4px; }
    .ok { color: var(--ok); font-size: 12px; margin: 0; }
    .steps { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 8px; }
    .steps li { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
    .steps li[data-state="waiting"] { opacity: 0.45; }
    .steps li[data-state="failed"] .step-name { color: var(--error); }
    .step-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .step-name { font-weight: 600; }
    .line.hint, li .line { overflow-wrap: anywhere; }
    .badge {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: 2px 8px;
    }
    .badge.done { color: var(--ok); background: var(--ok-soft); }
    .badge.stopped { color: var(--error); background: var(--error-soft); }
    .more { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border-subtle); padding-top: 10px; }
    .more > summary { cursor: pointer; }
    .more[open] > * + * { margin-top: 6px; }
    .check { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--text-secondary); }
    .check input { margin-top: 2px; }
    .plan { display: flex; flex-direction: column; gap: 2px; }
    .plan-row { display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; color: var(--text-secondary); }
    .plan-row.fatal, .plan-row.fatal .act { color: var(--error); }
    .act {
      flex: none; min-width: 46px; font-family: var(--font-mono); font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-tertiary);
    }
    .what { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .size { flex: none; font-size: 10.5px; color: var(--text-tertiary); }
    @media (max-width: 600px) { .line { flex-direction: column; } }
  `],
})
export class CrucibleSetupComponent {
  /** Also offer "Add an existing server" by its pairing line (the studio's first-run card). */
  readonly addByLine = input(false);
  /**
   * Also offer to install the newest release over this computer's Crucible, and
   * to remove it (Settings). Not on the first-run card: "remove" beside
   * "install" is a screen arguing with itself.
   */
  readonly manage = input(false);

  protected readonly hub = inject(HubService);
  protected readonly isDesktop = desktop !== null;

  protected readonly local = signal<LocalCrucibleView | null>(null);
  protected readonly plan = signal<CrucibleInstallPlan | null>(null);
  protected readonly status = signal<CrucibleInstallStatus | null>(null);
  /** The install's rows, seeded from the plan once and filled in by its events. */
  protected readonly rows = signal<CrucibleInstallRow[]>([]);
  /** The sentence a finished run ends on; null until one finishes in this window. */
  protected readonly finished = signal<string | null>(null);
  protected readonly busy = signal<Busy | null>(null);
  protected readonly refusal = signal<RefusalView | null>(null);
  /** Why Crucible's Windows tray could not say where its engine move got to, when it could not. */
  protected readonly statusSaid = signal<RefusalView | null>(null);
  protected readonly pairing = signal('');

  protected readonly uninstallable = signal<CrucibleUninstallAvailability | null>(null);
  protected readonly uninstallPlan = signal<CrucibleUninstallPlan | null>(null);
  protected readonly removed = signal<CrucibleUninstallPlan | null>(null);
  protected readonly unregistered = signal<string | null>(null);
  protected readonly purgeWeights = signal(false);
  protected readonly wslToo = signal(false);

  protected readonly size = (bytes: number): string => bytesText(bytes) ?? '';

  /** An install is running here: this window's press, or a move Crucible's tray started by itself. */
  protected readonly installing = computed(() => this.busy() === 'install' || this.busy() === 'retry' || this.status()?.running === true);

  protected readonly outcome = computed<CrucibleInstallOutcome | null>(() => this.status()?.outcome ?? null);

  /** Whether this window ran an install (its rows stay up afterwards, a failed row included). */
  private readonly ranHere = signal(false);

  /**
   * The rows: while anything installs, and after a run pressed here. A move the
   * tray ran by itself ends without B-Side's `done` (it did not register or
   * measure anything), so its rows go when it does and its outcome is the readout.
   */
  protected readonly rowsShown = computed(() => this.installing() || this.ranHere());

  /**
   * The one act to offer. A stopped Crucible is offered Start even when B-Side
   * already uses it — that is exactly when songs cannot be made. "No
   * installation record" with a published connection is a Crucible somebody
   * set up by hand: it is used, not installed over.
   */
  protected readonly face = computed<Face>(() => {
    const local = this.local();
    if (local === null) return 'looking';
    if (local.platform === 'other') return 'unsupported';
    const published = local.published;
    const served: Face = published === null ? 'unpublished' : published.active ? 'in-use' : 'use';
    switch (local.state.kind) {
      case 'absent':
        return published === null ? 'install' : served;
      case 'stopped':
      case 'unreachable':
        return 'start';
      case 'problem':
        return 'problem';
      case 'running':
      case 'unhealthy':
        return served;
    }
  });

  protected readonly hostWords = computed(() => {
    const host = this.hub.info()?.hostname;
    return host === undefined ? '' : ` (${host})`;
  });

  protected readonly problem = computed(() => {
    const state = this.local()?.state;
    return state?.kind === 'problem' ? { what: state.what, why: state.why } : null;
  });

  protected readonly shownPlan = computed(() => this.removed() ?? this.uninstallPlan());

  /** The kept and freed sizes are the plan's own sums, never recomputed here. */
  protected readonly planWords = computed(() => {
    const plan = this.shownPlan();
    if (plan === null) return '';
    const kept = `${plan.dryRun ? 'Would keep' : 'Kept'} ${this.size(plan.kept.weightsBytes)} of models.`;
    return plan.dryRun ? `Nothing has been touched yet. ${kept}` : `Freed ${this.size(plan.removedBytes)}. ${kept}`;
  });

  constructor() {
    if (desktop === null) return;
    const bridge = desktop.crucible;
    // Listening for the component's whole life: an install outlives the press,
    // and a move Crucible's tray started by itself arrives without one.
    const detach = bridge.onInstallEvent((event) => {
      this.rows.update((rows) => applyInstallEvent(rows, event));
      if (event.event === 'done') this.finished.set(this.doneWords(event.backend));
      if (event.event === 'failed') this.finished.set(null);
    });
    const detachSettled = bridge.onInstallSettled(() => void this.read());
    inject(DestroyRef).onDestroy(() => {
      detach();
      detachSettled();
    });
    void this.read();
  }

  /**
   * This computer, the install plan (its rows are the skeleton events fill in)
   * and where an install already got to — asked together, because a window
   * opened halfway through a move must not draw empty rows under "running".
   */
  private async read(askUninstall = true): Promise<void> {
    const bridge = desktop?.crucible;
    if (bridge === undefined) return;
    const [local, plan] = await Promise.all([bridge.local(), bridge.installPlan()]);
    if (!this.take(plan)) return;
    this.plan.set(plan.value);
    if (this.rows().length === 0) this.rows.set(initialInstallRows(plan.value.steps));
    if (!this.take(local)) return;
    this.local.set(local.value);
    // A tray that will not say where its engine move got to is a fact worth a
    // sentence — said quietly, in Settings, because it blocks none of the doors
    // and is not something B-Side or the person can repair from here. The
    // first-run card does not talk about Crucible's plumbing at all.
    const status = await bridge.installStatus();
    this.status.set(status.ok ? status.value : null);
    this.statusSaid.set(status.ok ? null : status.refusal);
    if (this.manage() && askUninstall) await this.askUninstall();
  }

  /** One install run, start to finish: Install, or Try again. */
  private async run(kind: 'install' | 'retry', call: () => Promise<Outcome<null>>): Promise<void> {
    const plan = this.plan();
    if (plan === null) return;
    this.busy.set(kind);
    this.ranHere.set(true);
    this.refusal.set(null);
    this.finished.set(null);
    this.rows.set(initialInstallRows(plan.steps));
    const outcome = await call();
    this.busy.set(null);
    this.take(outcome);
    await this.read();
  }

  protected install(): Promise<void> {
    return this.run('install', () => desktop!.crucible.install());
  }

  protected retry(): Promise<void> {
    return this.run('retry', () => desktop!.crucible.installRetry());
  }

  protected async start(): Promise<void> {
    this.busy.set('start');
    this.refusal.set(null);
    const outcome = await desktop!.crucible.start();
    this.busy.set(null);
    if (this.take(outcome) && !outcome.value.started) {
      // Launched and not answering yet is not a failure: it is said in Crucible's own words.
      this.refusal.set({ code: 'crucible_starting', message: outcome.value.detail });
    }
    await this.read();
  }

  protected async useLocal(): Promise<void> {
    this.busy.set('use');
    this.refusal.set(null);
    const outcome = await desktop!.crucible.useLocal();
    this.busy.set(null);
    if (this.take(outcome)) this.hub.servers.set(outcome.value);
    await this.read();
  }

  protected async restart(): Promise<void> {
    this.busy.set('restart');
    this.refusal.set(null);
    const outcome = await desktop!.crucible.restartWindows();
    this.take(outcome);
    // On success Windows is about to restart; the button stays pressed.
    if (!outcome.ok) this.busy.set(null);
  }

  protected async addPairing(): Promise<void> {
    this.busy.set('pairing');
    const outcome = await this.hub.call<ServerView[]>('POST', '/api/servers/pairing', { line: this.pairing() });
    this.busy.set(null);
    this.refusal.set(outcome.ok ? null : outcome.refusal);
    if (outcome.ok) {
      this.pairing.set('');
      this.hub.servers.set(outcome.value);
    }
  }

  /** The "Install or update" fold re-reads this computer when it opens, so its button acts on what is there now. */
  protected openedMore(open: boolean): void {
    if (open) void this.read();
  }

  // ── removing Crucible ──────────────────────────────────────────────────────

  private async askUninstall(): Promise<void> {
    const outcome = await desktop!.crucible.uninstallAvailability();
    // A proof that could not be taken is not a proof: the door is drawn only on a yes.
    this.uninstallable.set(outcome.ok ? outcome.value : null);
  }

  /** Closing the fold throws its plan away: a Remove button over yesterday's rows confirms nothing anybody read. */
  protected toggleUninstall(open: boolean): void {
    if (open) return;
    this.uninstallPlan.set(null);
    this.removed.set(null);
    this.unregistered.set(null);
    void this.askUninstall();
  }

  /** A box moved: the plan on screen was priced for the other flags, so it goes. The next press asks again. */
  protected setPurge(on: boolean): void {
    this.purgeWeights.set(on);
    this.uninstallPlan.set(null);
  }

  protected setWslToo(on: boolean): void {
    this.wslToo.set(on);
    this.uninstallPlan.set(null);
  }

  /** The dry run: the same plan, unperformed. Touches nothing. */
  protected async readPlan(): Promise<void> {
    this.busy.set('uninstall-plan');
    this.refusal.set(null);
    const outcome = await desktop!.crucible.uninstallDryRun({ purgeWeights: this.purgeWeights(), wslToo: this.wslToo() });
    this.busy.set(null);
    if (this.take(outcome)) this.uninstallPlan.set(outcome.value);
  }

  /** The real run, with the flags the plan on screen was priced for (moving a box cleared it). */
  protected async removeIt(): Promise<void> {
    this.busy.set('uninstall-run');
    this.refusal.set(null);
    const outcome = await desktop!.crucible.uninstall({ purgeWeights: this.purgeWeights(), wslToo: this.wslToo() });
    this.busy.set(null);
    if (this.take(outcome)) {
      this.removed.set(outcome.value.plan);
      this.unregistered.set(outcome.value.unregistered);
    }
    // The removal's own rows stay up until the fold is closed, which asks again
    // whether there is anything left to remove.
    await this.read(false);
  }

  // ── words ──────────────────────────────────────────────────────────────────

  protected bytesWords(row: CrucibleInstallRow): string | null {
    if (row.bytesDone === null) return null;
    const done = this.size(row.bytesDone);
    return row.bytesTotal === null ? done : `${done} of ${this.size(row.bytesTotal)}`;
  }

  /** The outcome's own sentence (crucible PHASE19 §2.2); `cannot` is framed with what it means. */
  protected outcomeWords(outcome: CrucibleInstallOutcome): string {
    const said = outcome.sentence ?? 'Crucible did not say why.';
    return outcome.state === 'cannot'
      ? `This computer can't run Crucible's Linux engine, so it stays on the Windows engine: ${said}`
      : said;
  }

  /** The last sentence, from the backend the engine REPORTED; null means nothing measured it. */
  private doneWords(backend: string | null): string {
    const engine = backend === 'cuda-linux' ? ' on the Linux engine'
      : backend === 'llama-windows' ? ' on the Windows engine'
      : backend === 'mlx-darwin' ? ' on Apple silicon'
      : backend !== null ? ` (${backend})` : '';
    return `Done: Crucible is running${engine}, and B-Side uses it. The song model downloads the first time you press Generate.`;
  }

  /** Apply an outcome's refusal; answers whether it was a success. */
  private take<T>(outcome: Outcome<T>): outcome is { readonly ok: true; readonly value: T } {
    if (!outcome.ok) this.refusal.set(outcome.refusal);
    return outcome.ok;
  }
}
