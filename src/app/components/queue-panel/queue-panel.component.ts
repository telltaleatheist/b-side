import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { ENDED_PHASES, type InstallView, type JobView, type RefusalView, type Take } from '@shared/types';

import { bytesText, clockText, secondsText } from '../../core/format';
import { JobsService } from '../../core/jobs.service';
import { LibraryService } from '../../core/library.service';
import { PlayerService } from '../../core/player.service';
import { SaveMenuComponent } from '../save-menu/save-menu.component';

type Row =
  | { readonly kind: 'take'; readonly number: number; readonly take: Take }
  | { readonly kind: 'job'; readonly number: number; readonly job: JobView };

/**
 * The playing list, oldest first — the order songs play in: this device's takes
 * (songs made and not saved), then every job still generating or that ended
 * without a song. A job that finishes turns into its take in place.
 *
 * Nothing here is kept for long: the hub clears the oldest takes first (FIFO)
 * well before they are a problem. "Save" copies a take into a playlist in the
 * library, which is the only way a song is kept.
 */
@Component({
  selector: 'app-queue-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SaveMenuComponent],
  template: `
    <div class="head">
      <span class="label">Playing list</span>
      <span class="count">{{ library.takes().length }} {{ library.takes().length === 1 ? 'song' : 'songs' }}@if (generatingCount() > 0) {, {{ generatingCount() }} generating}</span>
    </div>
    <p class="hint">Songs play in this order. Only songs you save to a playlist are kept; the oldest here clear on their own.</p>
    <div class="list">
      @for (row of rows(); track row.kind === 'take' ? row.take.id : row.job.key) {
        @if (row.kind === 'take') {
          <div class="item playable" [class.current]="isCurrent(row.take)" (click)="play(row.take, $event)">
            <div class="main">
              <div class="title">
                <span class="num">{{ row.number }}</span>
                @if (isCurrent(row.take)) { <span class="now">{{ player.paused() ? '❚❚' : '▶︎' }}</span> }
                {{ row.take.title }}
              </div>
              <div class="sub">{{ row.take.params.tags ?? '' }}</div>
              <div class="meta">
                {{ clock(row.take.durationS) }}
                @if (row.take.batch; as batch) { · {{ batch.index }} of {{ batch.of }} }
                @if (row.take.params.seed !== null) { · seed {{ row.take.params.seed }} }
                @if (row.take.params.instrumental) { · instrumental }
                @if (savedIn(row.take); as where) { · <span class="saved">saved in {{ where }}</span> }
              </div>
              @if (saving() === row.take.id) {
                <app-save-menu [take]="row.take" (closed)="saving.set(null)" />
              }
              @if (takeRefusal()?.id === row.take.id) {
                <div class="refusal"><code>{{ takeRefusal()!.refusal.code }}</code><span>{{ takeRefusal()!.refusal.message }}</span></div>
              }
            </div>
            <div class="actions">
              <button type="button" class="ghost small" title="Keep this song: save it to a playlist"
                      (click)="saving.set(saving() === row.take.id ? null : row.take.id)">Save</button>
              <button type="button" class="icon" title="Remove from the playing list" (click)="remove(row.take)">×</button>
            </div>
          </div>
        } @else {
          <div class="item" [class.ended]="ended(row.job)">
            <div class="main">
              <div class="title">
                <span class="num">{{ row.number }}</span>
                {{ jobTitle(row.job) }}
              </div>
              <div class="sub">{{ row.job.params.tags ?? '' }}</div>
              @if (!ended(row.job)) {
                <div class="bar" [class.indeterminate]="share(row.job) === null">
                  <span [style.width.%]="(share(row.job) ?? 0) * 100"></span>
                </div>
              }
              <div class="meta">{{ status(row.job) }}</div>
              @if (row.job.install?.line; as line) { <div class="meta mono">{{ line }}</div> }
              @if (row.job.refusal; as refused) {
                <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
              }
              @if (jobRefusal()?.key === row.job.key) {
                <div class="refusal"><code>{{ jobRefusal()!.refusal.code }}</code><span>{{ jobRefusal()!.refusal.message }}</span></div>
              }
            </div>
            <div class="actions">
              @if (cancellable(row.job)) {
                <button type="button" class="ghost small" (click)="cancel(row.job)">Cancel</button>
              }
              @if (ended(row.job)) {
                <button type="button" class="icon" title="Remove from the list" (click)="jobs.dismiss(row.job.key)">×</button>
              }
            </div>
          </div>
        }
      } @empty {
        <p class="empty">Nothing yet. Generated songs line up here and play in turn.</p>
      }
    </div>
  `,
  styles: [`
    :host {
      display: flex; flex-direction: column; gap: 6px; min-height: 0; height: 100%;
      padding: 12px; border-left: 1px solid var(--border-subtle); background: var(--bg-sunken);
    }
    .head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .count { font-size: 11px; color: var(--text-tertiary); }
    .list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding-right: 2px; }
    .item {
      display: flex; gap: 8px; padding: 8px 10px;
      border: 1px solid var(--border-subtle); border-radius: var(--radius-md);
      background: var(--bg-elevated);
    }
    .item.playable { cursor: pointer; }
    .item.playable:hover { border-color: var(--border-default); }
    .item.current { border-color: var(--audio); background: var(--audio-soft); }
    .item.ended { opacity: 0.85; }
    .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .title { font-size: 12.5px; font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; }
    .num { color: var(--text-tertiary); font-weight: 500; margin-right: 4px; font-variant-numeric: tabular-nums; }
    .now { color: var(--audio); margin-right: 4px; font-size: 10px; }
    .sub { font-size: 11.5px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta { font-size: 11.5px; color: var(--text-secondary); }
    .saved { color: var(--ok); }
    .actions { display: flex; align-items: flex-start; gap: 2px; }
    .icon {
      border: 0; background: transparent; color: var(--text-tertiary);
      font-size: 14px; line-height: 1; padding: 3px 5px; border-radius: var(--radius-sm);
    }
    .icon:hover:not(:disabled) { color: var(--accent); background: var(--bg-hover); }
    .empty { font-size: 12px; color: var(--text-tertiary); margin: 6px 0; }
  `],
})
export class QueuePanelComponent {
  protected readonly library = inject(LibraryService);
  protected readonly jobs = inject(JobsService);
  protected readonly player = inject(PlayerService);

  protected readonly saving = signal<string | null>(null);
  protected readonly takeRefusal = signal<{ id: string; refusal: RefusalView } | null>(null);
  protected readonly jobRefusal = signal<{ key: string; refusal: RefusalView } | null>(null);

  protected readonly rows = computed<Row[]>(() => {
    const takes = this.library.takes();
    const rows: Row[] = takes.map((take, at) => ({ kind: 'take', number: at + 1, take }));
    this.jobs.jobs().forEach((job, at) => rows.push({ kind: 'job', number: takes.length + at + 1, job }));
    return rows;
  });

  protected readonly generatingCount = computed(() => this.jobs.jobs().filter((job) => !this.ended(job)).length);

  protected isCurrent(take: Take): boolean {
    return this.player.current()?.key === `take:${take.id}`;
  }

  /** The playlists a saved take's song is in, by name. */
  protected savedIn(take: Take): string | null {
    if (take.savedAs === null) return null;
    const names = this.library.holding(take.savedAs).map((playlist) => playlist.name);
    return names.length === 0 ? null : names.join(', ');
  }

  protected clock(seconds: number | null): string {
    return seconds === null ? 'length unknown' : clockText(seconds);
  }

  protected ended(job: JobView): boolean {
    return ENDED_PHASES.includes(job.phase);
  }

  protected jobTitle(job: JobView): string {
    const batch = job.batch > 1 ? ` (${job.index} of ${job.batch})` : '';
    const seed = job.seed === null ? '' : ` · seed ${job.seed}`;
    return `${job.params.instrumental ? 'Instrumental' : 'Song'}${batch}${seed}`;
  }

  /** The bar's fill, 0..1, or null for an indeterminate bar. */
  protected share(job: JobView): number | null {
    const install = job.install;
    if (job.phase === 'installing' && install !== null) {
      return install.bytesTotal ? (install.bytesDone ?? 0) / install.bytesTotal : null;
    }
    if (job.phase === 'running' || job.phase === 'fetching') return job.fraction;
    return null;
  }

  /** The status line, as the Crucible playground words it. */
  protected status(job: JobView): string {
    const waited = secondsText(((job.ended ?? this.jobs.now()) - job.since) / 1000);
    switch (job.phase) {
      case 'submitting':
        return job.message ?? 'Sending the job…';
      case 'installing':
        return `${this.installText(job.install)} (${waited})`;
      case 'queued': {
        const where = job.position === null ? 'in line' : `number ${job.position}${job.of ? ` of ${job.of}` : ''} in line`;
        return `Waiting for the server, ${where} (${waited})${job.message ? ` — ${job.message}` : ''}`;
      }
      case 'running': {
        const said = job.message ? job.message.charAt(0).toUpperCase() + job.message.slice(1) : 'Working';
        const share = job.fraction === null ? '' : `, ${Math.round(job.fraction * 100)}%`;
        return `${said}${share} (${waited})`;
      }
      case 'fetching':
        return job.message ?? 'Fetching the song…';
      case 'done':
        return 'Done';
      case 'cancelled':
        return 'Cancelled.';
      case 'removed':
        return 'It left the server\'s queue without running. Generate again to send it again.';
      case 'refused':
        return 'The server refused it:';
      case 'failed':
        return 'It failed:';
    }
  }

  private installText(install: InstallView | null): string {
    if (install === null) return 'Installing';
    let said = install.ours
      ? 'Downloading what YuE2 needs first, once'
      : 'Waiting for another install on the server to finish';
    if (install.step !== null) said += `: step ${install.step.index} of ${install.step.total}, ${install.step.name}`;
    const done = bytesText(install.bytesDone);
    if (done !== null) {
      const total = bytesText(install.bytesTotal);
      said += `, ${done}${total === null ? ' so far' : ` of ${total}`}`;
    }
    return `${said}. The job starts by itself after it`;
  }

  protected cancellable(job: JobView): boolean {
    if (this.ended(job)) return false;
    if (job.phase === 'installing') return job.install?.ours === true;
    return true;
  }

  protected play(take: Take, event: MouseEvent): void {
    if ((event.target as HTMLElement).closest('button, input, app-save-menu')) return;
    this.player.playTake(take);
  }

  protected async cancel(job: JobView): Promise<void> {
    const refusal = await this.jobs.cancel(job.key);
    this.jobRefusal.set(refusal === null ? null : { key: job.key, refusal });
  }

  protected async remove(take: Take): Promise<void> {
    const refusal = await this.library.removeTake(take);
    this.takeRefusal.set(refusal === null ? null : { id: take.id, refusal });
  }
}
