import { computed, Injectable, signal } from '@angular/core';

import { ENDED_PHASES, type GenerateRequest, type JobView, type RefusalView } from '@shared/types';

import { api } from './bside';

/**
 * The jobs main is following. A job that finished is not listed: it became a
 * library song, and the song is what the queue shows from then on.
 */
@Injectable({ providedIn: 'root' })
export class JobsService {
  private readonly all = signal<JobView[]>([]);

  /** Every job still to show, oldest first: generating ones, and ones that ended without a song. */
  readonly jobs = computed(() => this.all().filter((job) => job.phase !== 'done'));
  readonly generating = computed(() => this.jobs().some((job) => !ENDED_PHASES.includes(job.phase)));
  /** A tick while anything is generating, so "waiting 1 min 5 s" moves. */
  readonly now = signal(Date.now());

  constructor() {
    if (api === null) return;
    void api.jobs.list().then((jobs) => this.all.set(jobs));
    api.jobs.onChanged((job) => this.upsert(job));
    setInterval(() => {
      if (this.generating()) this.now.set(Date.now());
    }, 1000);
  }

  async generate(request: GenerateRequest): Promise<RefusalView | null> {
    if (api === null) return { code: 'no_bridge', message: 'B-Side is open outside its app; nothing can be generated.' };
    const outcome = await api.jobs.generate(request);
    if (!outcome.ok) return outcome.refusal;
    for (const job of outcome.value) this.upsert(job);
    return null;
  }

  async cancel(key: string): Promise<RefusalView | null> {
    if (api === null) return null;
    const outcome = await api.jobs.cancel(key);
    return outcome.ok ? null : outcome.refusal;
  }

  async dismiss(key: string): Promise<void> {
    if (api === null) return;
    await api.jobs.dismiss(key);
    this.all.update((jobs) => jobs.filter((job) => job.key !== key));
  }

  private upsert(job: JobView): void {
    if (job.phase === 'done') {
      this.all.update((jobs) => jobs.filter((other) => other.key !== job.key));
      return;
    }
    this.all.update((jobs) => {
      const at = jobs.findIndex((other) => other.key === job.key);
      if (at < 0) return [...jobs, job].sort((a, b) => a.number - b.number);
      const next = [...jobs];
      next[at] = job;
      return next;
    });
  }
}
