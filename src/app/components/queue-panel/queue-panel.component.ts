import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import type { JobView, RefusalView, Take } from '@shared/types';

import { clockText } from '../../core/format';
import { jobCancellable, jobEnded, jobShare, jobStatus, jobTitle } from '../../core/job-status';
import { JobsService } from '../../core/jobs.service';
import { LibraryService } from '../../core/library.service';
import { PlayerService } from '../../core/player.service';
import { CoverComponent } from '../cover/cover.component';
import { IconComponent } from '../icon/icon.component';
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
  imports: [SaveMenuComponent, CoverComponent, IconComponent],
  template: `
    <div class="head">
      <h2 class="section-title">Playing list</h2>
      <span class="count mono">{{ library.takes().length }} {{ library.takes().length === 1 ? 'song' : 'songs' }}@if (generatingCount() > 0) { · <span class="amber">{{ generatingCount() }} making</span>}</span>
    </div>
    <div class="list">
      @for (row of rows(); track row.kind === 'take' ? row.take.id : row.job.key) {
        @if (row.kind === 'take') {
          <div class="item playable" [class.current]="isCurrent(row.take)" (click)="play(row.take, $event)">
            <app-cover class="art" [key]="row.take.id + (row.take.params.tags ?? '')" />
            <div class="main">
              <div class="title">{{ row.take.title }}</div>
              <div class="sub">{{ row.take.params.tags ?? '' }}</div>
              <div class="meta mono">
                {{ clock(row.take.durationS) }}
                @if (row.take.params.instrumental) { · instrumental }
                @if (savedIn(row.take); as where) { · <span class="saved">in {{ where }}</span> }
              </div>
              @if (saving() === row.take.id) {
                <app-save-menu [take]="row.take" (closed)="saving.set(null)" />
              }
              @if (takeRefusal()?.id === row.take.id) {
                <div class="refusal"><code>{{ takeRefusal()!.refusal.code }}</code><span>{{ takeRefusal()!.refusal.message }}</span></div>
              }
            </div>
            <div class="actions">
              <button type="button" class="icon-btn" aria-label="Save to a playlist" title="Keep this song: save it to a playlist"
                      (click)="saving.set(saving() === row.take.id ? null : row.take.id)"><app-icon name="plus" [size]="20" /></button>
              <button type="button" class="icon-btn" aria-label="Remove from the playing list" title="Remove from the playing list" (click)="remove(row.take)"><app-icon name="close" [size]="18" /></button>
            </div>
          </div>
        } @else {
          <div class="item" [class.ended]="ended(row.job)">
            <div class="art making"><span class="mono">{{ row.number }}</span></div>
            <div class="main">
              <div class="title">{{ jobTitle(row.job) }}</div>
              <div class="sub">{{ row.job.params.tags ?? '' }}</div>
              @if (!ended(row.job)) {
                <div class="bar making-bar" [class.indeterminate]="share(row.job) === null">
                  <span [style.width.%]="(share(row.job) ?? 0) * 100"></span>
                </div>
              }
              <div class="meta" [class.amber]="!ended(row.job)">{{ status(row.job) }}</div>
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
                <button type="button" class="icon-btn" aria-label="Remove from the list" (click)="jobs.dismiss(row.job.key)"><app-icon name="close" [size]="18" /></button>
              }
            </div>
          </div>
        }
      } @empty {
        <p class="empty">Nothing yet. Songs you make line up here and play in turn; only the ones you save are kept.</p>
      }
    </div>
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 10px; }
    .head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .count { font-size: 11px; color: var(--text-tertiary); }
    .amber { color: var(--audio); }
    .list { display: flex; flex-direction: column; gap: 2px; }
    .item { display: flex; align-items: flex-start; gap: 12px; padding: 8px; border-radius: var(--radius-md); }
    .item.playable { cursor: pointer; }
    .item.playable:hover { background: var(--bg-hover); }
    .item.current { background: var(--accent-faint); }
    .item.current .title { color: var(--accent); }
    .item.ended { opacity: 0.85; }
    .art { width: 52px; --cover-radius: 6px; }
    .art.making {
      aspect-ratio: 1; border-radius: 6px; border: 1px dashed var(--audio);
      display: flex; align-items: center; justify-content: center; color: var(--audio); font-size: 12px; flex: none;
    }
    .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .title { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
    .sub { font-size: 12px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta { font-size: 11px; color: var(--text-tertiary); }
    .making-bar > span { background: var(--audio); }
    .saved { color: var(--ok); }
    .actions { display: flex; align-items: center; gap: 0; }
    .empty { font-size: 13px; color: var(--text-tertiary); margin: 6px 0; }
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
    return seconds === null ? '–:––' : clockText(seconds);
  }

  protected ended(job: JobView): boolean {
    return jobEnded(job);
  }

  protected jobTitle(job: JobView): string {
    return jobTitle(job);
  }

  protected share(job: JobView): number | null {
    return jobShare(job);
  }

  protected status(job: JobView): string {
    return jobStatus(job, this.jobs.now());
  }

  protected cancellable(job: JobView): boolean {
    return jobCancellable(job);
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
