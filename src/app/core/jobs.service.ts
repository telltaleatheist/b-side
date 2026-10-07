import { computed, inject, Injectable, signal } from '@angular/core';

import { ENDED_PHASES, type GenerateRequest, type JobView, type RefusalView } from '@shared/types';

import { HubService } from './hub.service';

/**
 * This device's jobs, as the hub follows them. A job that finished is not
 * listed: it became a take, and the take is what the playing list shows.
 */
@Injectable({ providedIn: 'root' })
export class JobsService {
  private readonly hub = inject(HubService);

  /** Every job still to show, oldest first: generating ones, and ones that ended without a song. */
  readonly jobs = computed(() => this.hub.jobs().filter((job) => job.phase !== 'done'));
  readonly generating = computed(() => this.jobs().some((job) => !ENDED_PHASES.includes(job.phase)));
  /** A tick while anything is generating, so "waiting 1 min 5 s" moves. */
  readonly now = signal(Date.now());

  constructor() {
    setInterval(() => {
      if (this.generating()) this.now.set(Date.now());
    }, 1000);
  }

  /** Ask for songs; answers the jobs made (each says the playlist it lands in), or why not. */
  async generate(request: GenerateRequest): Promise<JobView[] | RefusalView> {
    const outcome = await this.hub.call<JobView[]>('POST', '/api/jobs', request);
    if (!outcome.ok) return outcome.refusal;
    for (const job of outcome.value) this.hub.upsertJob(job);
    return outcome.value;
  }

  async cancel(key: string): Promise<RefusalView | null> {
    const outcome = await this.hub.call<null>('POST', `/api/jobs/${encodeURIComponent(key)}/cancel`);
    return outcome.ok ? null : outcome.refusal;
  }

  /** Forget an ended job that did not become a song (failed, cancelled, removed, refused). */
  async dismiss(key: string): Promise<void> {
    const outcome = await this.hub.call<null>('DELETE', `/api/jobs/${encodeURIComponent(key)}`);
    if (outcome.ok) this.hub.dropJob(key);
  }
}
