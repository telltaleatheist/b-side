/**
 * jobs — every song being made, followed in main so a renderer reload loses nothing.
 *
 * The flow is the Crucible playground's (crucible/ui/playground.js), through the SDK:
 *
 *   submit   `audio()` (`POST /v1/jobs {type: "audio", model: "yue2-3b", params}`). Jobs are
 *            sent one after another through one line, so the server's queue holds
 *            them in the order they were asked for — across presses, too.
 *   install  a `409 installing` refusal names the install task the server began
 *            (or one already running: `task_busy`). Follow that task's events,
 *            then send the job again — at most INSTALL_ROUNDS times.
 *   follow   the job's events: queued (position), started, warming, progress
 *            (fraction + message), then done / failed / cancelled / removed. A
 *            dropped stream is weather: it reconnects with the last event id, and
 *            says so while it does.
 *   land     on `done`, read the server's effective params (`readAudioResult`),
 *            fetch the audio artifact, and hand it to the take cache: it joins
 *            the playing list of the client that asked for it.
 *
 * Jobs that have a server id are written to `pending.json`, so a job still
 * generating when B-Side quits is followed again on the next launch (its events
 * replay from the start, so nothing is missed).
 *
 * The audio is fetched by the platform's `AudioFetcher`: the SDK on the desktop,
 * a native download straight to disk on the phone (a 35 MB song must never cross
 * the WebView bridge as base64).
 */

import {
  CrucibleRefused,
  CrucibleUnreachable,
  isTaskLineProgress,
  readAudioResult,
  type CrucibleClient,
  type DoneData,
  type InstallingDetails,
  type JobStatus,
} from '@crucible/client';

import { clientFor } from './crucible';
import type { Disk } from './disk';
import { Refusal, refusalOf } from './refusal';
import type { StoredServer } from './servers';
import { batchSeeds } from '../batch';
import {
  ENDED_PHASES,
  SONG_MODEL,
  type ClientKind,
  type GenerateRequest,
  type InstallView,
  type JobView,
  type RefusalView,
  type SongFormat,
  type SongParams,
  type Take,
} from '../types';

const INSTALL_ROUNDS = 5;
const RECONNECT_MS = 2000;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Job {
  view: Mutable<JobView>;
  /** The file format the server renders: the hub's preference when the job was asked for. */
  format: SongFormat;
  server: StoredServer;
  /** Null only for a resumed job whose server has since been removed: it is failed at once. */
  client: CrucibleClient | null;
  /** The install task this job is waiting on, while `phase` is `installing`. */
  taskId: string | null;
  /** Cancelled or dismissed before the server had it: nothing more is sent for it. */
  gone: boolean;
}

/**
 * Fetch a finished job's artifact into `file` and answer its size. A server that
 * cannot be reached is `CrucibleUnreachable`, which the runner retries.
 */
export type AudioFetcher = (server: StoredServer, jobId: string, artifact: string, file: string) => Promise<number>;

/** What a finished job hands the take cache. */
export interface Landed {
  readonly job: JobView;
  readonly server: StoredServer;
  /** Fetch the audio into this file (retrying while the server cannot be reached); answers its size. */
  readonly fill: (file: string) => Promise<number>;
  readonly extension: string;
  readonly seed: number;
  readonly durationS: number | null;
  readonly effective: unknown;
}

export interface JobHooks {
  /** Every change to a job, for the renderer. */
  publish(job: JobView): void;
  /** Keep a finished song as a take in its client's playing list; answers the take. */
  land(landed: Landed): Promise<Take>;
  /** Find a server again by name (to resume a pending job after a restart). */
  server(name: string): StoredServer;
}

interface PendingEntry {
  readonly view: JobView;
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isInstalling(error: unknown): error is CrucibleRefused & { details: InstallingDetails } {
  if (!(error instanceof CrucibleRefused) || error.code !== 'installing') return false;
  const details = error.details as Partial<InstallingDetails> | null;
  return details !== null && typeof details === 'object' && typeof details.task_id === 'string';
}

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private numbered = 0;
  /** The submission line: each job is sent once the one before it has been answered. */
  private line: Promise<void> = Promise.resolve();
  /** pending.json writes, one at a time (they share one temporary file). */
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly hooks: JobHooks,
    private readonly disk: Disk,
    private readonly pendingFile: string,
    private readonly fetchAudio: AudioFetcher,
  ) {}

  /** One client's jobs, oldest first. */
  list(client: string): JobView[] {
    return [...this.jobs.values()]
      .filter((job) => job.view.client === client)
      .map((job) => ({ ...job.view }))
      .sort((a, b) => a.number - b.number);
  }

  /** Whose job `key` is, so the hub can refuse another device's cancel. */
  owner(key: string): string | null {
    return this.jobs.get(key)?.view.client ?? null;
  }

  /** Queue `count` jobs on `server` for the device `asker`; with a seed they get seed, seed+1, ... */
  generate(
    server: StoredServer,
    asker: { readonly id: string; readonly kind: ClientKind },
    request: GenerateRequest,
    format: SongFormat,
  ): JobView[] {
    const seeds = batchSeeds(typeof request.params.seed === 'number' ? request.params.seed : null, request.count);
    const client = clientFor(server);
    const made: Job[] = seeds.map((seed, at) => {
      const params: Mutable<SongParams> = { ...request.params };
      delete params.seed;
      if (seed !== null) params.seed = seed;
      this.numbered += 1;
      const job: Job = {
        server,
        client,
        format,
        taskId: null,
        gone: false,
        view: {
          key: crypto.randomUUID(),
          client: asker.id,
          clientKind: asker.kind,
          number: this.numbered,
          index: at + 1,
          batch: seeds.length,
          server: server.name,
          jobId: null,
          phase: 'submitting',
          position: null,
          of: null,
          fraction: null,
          message: null,
          install: null,
          refusal: null,
          params,
          seed,
          takeId: null,
          since: Date.now(),
          ended: null,
        },
      };
      this.jobs.set(job.view.key, job);
      this.publish(job);
      return job;
    });
    for (const job of made) {
      // A submit that throws fails its own job and never stops the line behind it.
      this.line = this.line
        .then(() => this.submit(job))
        .catch((error: unknown) => this.finish(job, 'failed', refusalOf(error)));
    }
    return made.map((job) => ({ ...job.view }));
  }

  async cancel(key: string): Promise<null> {
    const job = this.jobs.get(key);
    if (job === undefined || this.ended(job)) return null;
    if (job.view.phase === 'installing') {
      if (job.taskId === null || job.view.install?.ours !== true) {
        throw new Refusal('install_not_ours', 'This install was started by another client; it is not B-Side\'s to cancel.');
      }
      await this.clientOf(job).cancelTask(job.taskId);
      return null;
    }
    if (job.view.jobId === null) {
      // Not on the server yet: it never will be.
      job.gone = true;
      this.finish(job, 'cancelled');
      return null;
    }
    await this.clientOf(job).cancel(job.view.jobId);
    return null;
  }

  dismiss(key: string): void {
    const job = this.jobs.get(key);
    if (job === undefined || !this.ended(job)) return;
    job.gone = true;
    this.jobs.delete(key);
    void this.savePending();
  }

  /**
   * A client that is gone (a closed browser tab): cancel what it still has
   * generating, and forget the rest. Nobody is left to hear any of it.
   */
  async forgetClient(client: string): Promise<void> {
    for (const job of [...this.jobs.values()].filter((other) => other.view.client === client)) {
      if (!this.ended(job)) {
        try {
          await this.cancel(job.view.key);
        } catch (err) {
          console.error(`[jobs] could not cancel ${job.view.key} for the closed client ${client}:`, err);
        }
      }
      job.gone = true;
      this.jobs.delete(job.view.key);
    }
    await this.savePending();
  }

  /** Follow again the jobs that were generating when B-Side last quit. */
  async resume(): Promise<void> {
    let entries: PendingEntry[];
    try {
      const text = await this.disk.readText(this.pendingFile);
      if (text === null) return;
      entries = JSON.parse(text) as PendingEntry[];
    } catch (err) {
      console.error(`[jobs] ${this.pendingFile} could not be read; nothing resumed:`, err);
      return;
    }
    for (const entry of entries) {
      const view = entry.view;
      if (view.jobId === null || ENDED_PHASES.includes(view.phase)) continue;
      if (typeof view.client !== 'string' || typeof view.clientKind !== 'string') {
        console.error(`[jobs] pending job ${view.key} names no client (written before the hub); not resumed`);
        continue;
      }
      this.numbered = Math.max(this.numbered, view.number);
      let server: StoredServer;
      try {
        server = this.hooks.server(view.server);
      } catch (err) {
        const job: Job = { server: { name: view.server, url: '', token: '' }, client: null, format: 'flac', taskId: null, gone: false, view: { ...view } };
        this.jobs.set(view.key, job);
        job.view.refusal = refusalOf(err);
        this.finish(job, 'failed');
        continue;
      }
      // Already on the server: its format was sent then; the file's extension says which.
      const job: Job = { server, client: clientFor(server), format: 'flac', taskId: null, gone: false, view: { ...view, message: 'Following it again after a restart' } };
      this.jobs.set(view.key, job);
      this.publish(job);
      // It may have ended while nobody followed it (a restart on either side): ask before following.
      void this.endedOnServer(job, view.jobId).then((ended) => (ended ? undefined : this.follow(job)));
    }
  }

  // ───────────────────────────────────────────────────────────────────────────

  private ended(job: Job): boolean {
    return ENDED_PHASES.includes(job.view.phase);
  }

  private clientOf(job: Job): CrucibleClient {
    if (job.client === null) throw new Refusal('unknown_server', `B-Side no longer has the server ${job.view.server}.`);
    return job.client;
  }

  private publish(job: Job): void {
    this.hooks.publish({ ...job.view });
  }

  private finish(job: Job, phase: JobView['phase'], refusal?: RefusalView): void {
    job.view.phase = phase;
    if (refusal !== undefined) job.view.refusal = refusal;
    job.view.ended = Date.now();
    job.view.install = null;
    this.publish(job);
    // A finished job IS its take now; the playing list shows the take, so the job is done with.
    if (phase === 'done') this.jobs.delete(job.view.key);
    void this.savePending();
  }

  /** The jobs the server has and that have not ended: what a restart must pick up. */
  private savePending(): Promise<void> {
    this.saving = this.saving.then(() => this.writePending());
    return this.saving;
  }

  private async writePending(): Promise<void> {
    const entries: PendingEntry[] = [...this.jobs.values()]
      .filter((job) => job.view.jobId !== null && !this.ended(job))
      .map((job) => ({ view: { ...job.view } }));
    try {
      await this.disk.writeText(this.pendingFile, `${JSON.stringify(entries, null, 2)}\n`);
    } catch (err) {
      console.error(`[jobs] could not record pending jobs in ${this.pendingFile}:`, err);
    }
  }

  private async submit(job: Job): Promise<void> {
    const client = this.clientOf(job);
    let jobId: string | null = null;
    for (let round = 0; jobId === null; round += 1) {
      if (job.gone) return;
      try {
        jobId = await client.audio({ model: SONG_MODEL, ...job.view.params, format: job.format });
      } catch (error) {
        if (job.gone) return;
        if (!isInstalling(error) || round >= INSTALL_ROUNDS) {
          this.finish(job, 'refused', refusalOf(error));
          return;
        }
        const outcome = await this.followInstall(job, error.details);
        if (job.gone) return;
        if (outcome !== 'done') {
          if (outcome === 'cancelled') this.finish(job, 'cancelled');
          else this.finish(job, 'failed', outcome);
          return;
        }
        job.view.phase = 'submitting';
        job.view.install = null;
        job.taskId = null;
        this.publish(job);
      }
    }
    if (job.gone) {
      // Cancelled while the submit was on the wire: take it back off the server.
      await client.cancel(jobId).catch((err: unknown) => console.error(`[jobs] could not cancel ${jobId}:`, err));
      return;
    }
    job.view.jobId = jobId;
    job.view.phase = 'queued';
    this.publish(job);
    await this.savePending();
    void this.follow(job);
  }

  /** Follow an install task to its end: `done`, `cancelled`, or the refusal that ended it. */
  private async followInstall(job: Job, details: InstallingDetails): Promise<'done' | 'cancelled' | RefusalView> {
    job.taskId = details.task_id;
    const step = details.step;
    const install: Mutable<InstallView> = {
      ours: details.reason !== 'task_busy',
      step: step !== null && step.name !== null && step.index !== null && step.total !== null
        ? { name: step.name, index: step.index, total: step.total }
        : null,
      bytesDone: null,
      bytesTotal: null,
      line: null,
    };
    job.view.phase = 'installing';
    job.view.install = install;
    job.view.message = details.message;
    this.publish(job);

    let last: number | undefined;
    while (!job.gone) {
      try {
        for await (const event of this.clientOf(job).taskEvents(details.task_id, last === undefined ? {} : { lastEventId: last })) {
          last = event.id;
          switch (event.event) {
            case 'step':
              install.step = { name: event.data.name, index: event.data.index, total: event.data.total };
              install.bytesDone = null;
              install.bytesTotal = null;
              install.line = null;
              break;
            case 'progress':
              if (isTaskLineProgress(event.data)) {
                install.line = event.data.line;
              } else {
                install.bytesDone = event.data.bytesDone;
                install.bytesTotal = event.data.bytesTotal;
              }
              break;
            case 'done':
              return 'done';
            case 'cancelled':
              return 'cancelled';
            case 'failed':
              return {
                code: event.data.code,
                message: `Installing what ${SONG_MODEL} needs failed: ${event.data.message}. Generate again to retry.`,
              };
            default:
              break;
          }
          job.view.install = { ...install };
          this.publish(job);
        }
      } catch (error) {
        if (!(error instanceof CrucibleUnreachable)) return refusalOf(error);
      }
      job.view.message = 'Lost the server while it installs; reconnecting';
      this.publish(job);
      await pause(RECONNECT_MS);
    }
    return 'cancelled';
  }

  private async follow(job: Job): Promise<void> {
    const jobId = job.view.jobId;
    if (jobId === null) return;
    let last: number | undefined;
    while (!job.gone && !this.ended(job)) {
      try {
        for await (const event of this.clientOf(job).events(jobId, last === undefined ? {} : { lastEventId: last })) {
          last = event.id;
          switch (event.event) {
            case 'queued':
              job.view.phase = 'queued';
              job.view.position = event.data.position;
              job.view.of = event.data.of;
              break;
            case 'started':
              job.view.phase = 'running';
              job.view.message = null;
              break;
            case 'warming':
              job.view.phase = 'running';
              job.view.message = event.data.message;
              break;
            case 'waiting':
              job.view.message = event.data.message;
              break;
            case 'progress':
              job.view.phase = 'running';
              job.view.fraction = event.data.fraction;
              if (event.data.message) job.view.message = event.data.message;
              break;
            case 'done':
              await this.land(job, event.data);
              return;
            case 'failed':
              this.finish(job, 'failed', { code: event.data.error.code, message: event.data.error.message });
              return;
            case 'cancelled':
              this.finish(job, 'cancelled');
              return;
            case 'removed':
              job.view.message = event.data.message;
              this.finish(job, 'removed', { code: `removed_${event.data.reason}`, message: event.data.message });
              return;
            default:
              break;
          }
          this.publish(job);
        }
      } catch (error) {
        if (!(error instanceof CrucibleUnreachable)) {
          this.finish(job, 'failed', refusalOf(error));
          return;
        }
      }
      if (job.gone || this.ended(job)) return;
      if (await this.endedOnServer(job, jobId)) return;
      job.view.message = 'Lost the server; reconnecting';
      this.publish(job);
      await pause(RECONNECT_MS);
    }
  }

  /**
   * The stream dropped: ask the job itself before following it again. A server
   * that restarted mid-job (a deploy) marks it failed or interrupted but may
   * keep no event history to replay, so its stream would stay silent forever
   * and the job would read "reconnecting" for good. Answers whether it ended.
   * A `done` job is left to the stream, whose replay carries what landing needs.
   */
  private async endedOnServer(job: Job, jobId: string): Promise<boolean> {
    let status: JobStatus;
    try {
      status = await this.clientOf(job).job(jobId);
    } catch (error) {
      if (error instanceof CrucibleUnreachable) return false;
      this.finish(job, 'failed', refusalOf(error));
      return true;
    }
    switch (status.status) {
      case 'failed':
      case 'interrupted':
        this.finish(job, 'failed', status.error ?? {
          code: `job_${status.status}`,
          message: `${job.view.server} stopped while making this song (it ${status.status === 'interrupted' ? 'restarted' : 'failed'}). Generate again.`,
        });
        return true;
      case 'cancelled':
        this.finish(job, 'cancelled');
        return true;
      case 'removed':
        this.finish(job, 'removed', { code: 'removed', message: `${job.view.server} removed this song before it was fetched.` });
        return true;
      default:
        return false;
    }
  }

  /** `done`: fetch the audio and file it. A fetch the server cannot answer is retried, saying so. */
  private async land(job: Job, done: DoneData): Promise<void> {
    const jobId = job.view.jobId as string;
    job.view.phase = 'fetching';
    job.view.fraction = 1;
    job.view.message = 'Fetching the song';
    this.publish(job);
    try {
      const result = readAudioResult(done);
      job.view.seed = result.seed;
      const fill = async (file: string): Promise<number> => {
        for (;;) {
          try {
            return await this.fetchAudio(job.server, jobId, result.artifact, file);
          } catch (error) {
            if (!(error instanceof CrucibleUnreachable)) throw error;
            job.view.message = 'Fetching the song: the server is not answering, trying again';
            this.publish(job);
            await pause(RECONNECT_MS);
          }
        }
      };
      const extension = result.artifact.slice(result.artifact.lastIndexOf('.') + 1);
      const take = await this.hooks.land({
        job: { ...job.view },
        server: job.server,
        fill,
        extension,
        seed: result.seed,
        durationS: result.audioSeconds,
        effective: (done.extra as Record<string, unknown>)['audio'],
      });
      job.view.takeId = take.id;
      job.view.message = null;
      this.finish(job, 'done');
    } catch (error) {
      this.finish(job, 'failed', refusalOf(error));
    }
  }
}
