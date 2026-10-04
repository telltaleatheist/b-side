import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { ENDED_PHASES, type InstallView, type JobView, type RefusalView, type Song } from '@shared/types';

import { api } from '../../core/bside';
import { ConfirmService } from '../../core/confirm.service';
import { bytesText, clockText, secondsText } from '../../core/format';
import { JobsService } from '../../core/jobs.service';
import { LibraryService } from '../../core/library.service';
import { PlayerService } from '../../core/player.service';

type Row =
  | { readonly kind: 'song'; readonly number: number; readonly song: Song }
  | { readonly kind: 'job'; readonly number: number; readonly job: JobView };

/**
 * The queue, oldest first — the order songs play in. The library's songs come
 * first (they survive restarts), then every job still generating or that ended
 * without a song. A job that finishes turns into its song in place.
 */
@Component({
  selector: 'app-queue-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <span class="label">Queue</span>
      <span class="count">{{ library.songs().length }} {{ library.songs().length === 1 ? 'song' : 'songs' }}@if (generatingCount() > 0) {, {{ generatingCount() }} generating}</span>
    </div>
    <p class="hint">Songs play in this order. Click one to play it.</p>
    @for (problem of library.problems(); track problem) {
      <div class="notice">{{ problem }}</div>
    }
    <div class="list">
      @for (row of rows(); track row.kind === 'song' ? row.song.id : row.job.key) {
        @if (row.kind === 'song') {
          <div class="item playable" [class.current]="player.current()?.id === row.song.id" (click)="play(row.song, $event)">
            <div class="main">
              @if (renaming() === row.song.id) {
                <input type="text" class="rename" maxlength="200" [value]="row.song.title"
                       (keydown.enter)="rename(row.song, $any($event.target).value)"
                       (keydown.escape)="renaming.set(null)"
                       (blur)="rename(row.song, $any($event.target).value)" />
              } @else {
                <div class="title">
                  <span class="num">{{ row.number }}</span>
                  @if (player.current()?.id === row.song.id) { <span class="now">{{ player.paused() ? '❚❚' : '▶︎' }}</span> }
                  {{ row.song.title }}
                </div>
              }
              <div class="sub">{{ row.song.params.tags ?? '' }}</div>
              <div class="meta">
                {{ clock(row.song.durationS) }}
                @if (row.song.batch; as batch) { · {{ batch.index }} of {{ batch.of }} }
                @if (row.song.params.seed !== null) { · seed {{ row.song.params.seed }} }
                @if (row.song.params.instrumental) { · instrumental }
              </div>
              @if (songRefusal()?.id === row.song.id) {
                <div class="refusal"><code>{{ songRefusal()!.refusal.code }}</code><span>{{ songRefusal()!.refusal.message }}</span></div>
              }
            </div>
            <div class="actions">
              <button type="button" class="icon" title="Rename" (click)="renaming.set(row.song.id)">✎</button>
              <button type="button" class="icon" title="Save a copy…" (click)="saveCopy(row.song)">⤓</button>
              <button type="button" class="icon" title="Show in folder" (click)="reveal(row.song)">⌂</button>
              <button type="button" class="icon" title="Delete this song" (click)="remove(row.song)">×</button>
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
                <button type="button" class="icon" title="Remove from the queue" (click)="jobs.dismiss(row.job.key)">×</button>
              }
            </div>
          </div>
        }
      } @empty {
        <p class="empty">Nothing yet. Generated songs line up here, and stay in your library folder.</p>
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
    .rename { padding: 3px 6px; font-size: 12.5px; }
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
  private readonly confirm = inject(ConfirmService);

  protected readonly renaming = signal<string | null>(null);
  protected readonly songRefusal = signal<{ id: string; refusal: RefusalView } | null>(null);
  protected readonly jobRefusal = signal<{ key: string; refusal: RefusalView } | null>(null);

  protected readonly rows = computed<Row[]>(() => {
    const songs = this.library.songs();
    const rows: Row[] = songs.map((song, at) => ({ kind: 'song', number: at + 1, song }));
    this.jobs.jobs().forEach((job, at) => rows.push({ kind: 'job', number: songs.length + at + 1, job }));
    return rows;
  });

  protected readonly generatingCount = computed(() => this.jobs.jobs().filter((job) => !this.ended(job)).length);

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

  protected play(song: Song, event: MouseEvent): void {
    if ((event.target as HTMLElement).closest('button, input')) return;
    this.player.play(song);
  }

  protected async cancel(job: JobView): Promise<void> {
    const refusal = await this.jobs.cancel(job.key);
    this.jobRefusal.set(refusal === null ? null : { key: job.key, refusal });
  }

  protected async rename(song: Song, title: string): Promise<void> {
    if (this.renaming() !== song.id) return;
    this.renaming.set(null);
    if (title.trim() === '' || title.trim() === song.title) return;
    const refusal = await this.library.rename(song.id, title);
    this.songRefusal.set(refusal === null ? null : { id: song.id, refusal });
  }

  protected async saveCopy(song: Song): Promise<void> {
    if (api === null) return;
    const outcome = await api.library.saveCopy(song.id);
    this.songRefusal.set(outcome.ok ? null : { id: song.id, refusal: outcome.refusal });
  }

  protected async reveal(song: Song): Promise<void> {
    if (api === null) return;
    try {
      await api.library.reveal(song.id);
    } catch (error) {
      this.songRefusal.set({ id: song.id, refusal: { code: 'reveal', message: (error as Error).message } });
    }
  }

  protected async remove(song: Song): Promise<void> {
    const yes = await this.confirm.ask({
      title: `Delete "${song.title}"?`,
      message: `Its audio file and its sidecar are deleted from ${this.library.dir()}. This cannot be undone.`,
      confirm: 'Delete song',
      danger: true,
    });
    if (!yes) return;
    const refusal = await this.library.remove(song.id);
    this.songRefusal.set(refusal === null ? null : { id: song.id, refusal });
  }
}
