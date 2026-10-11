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
 * generating when B-Sides quits is followed again on the next launch (its events
 * replay from the start, so nothing is missed).
 *
 * The audio is fetched by the platform's `AudioFetcher`: the SDK on the desktop,
 * a native download straight to disk on the phone (a 35 MB song must never cross
 * the WebView bridge as base64).
 *
 * strip    (Owen, 2026-10-11; strip.ts) an instrumental, on a server that can strip, is
 *          rendered as a held FLAC; once done, a `denoise` job takes it by reference and its
 *          instrumental stem, in the person's format, is what lands. A song on its own is
 *          stripped at once. An album's tracks wait (`waiting`) until nothing of ours is
 *          rendering on that server, then are stripped together in one queue session, so the
 *          separator loads once instead of trading places with YuE2 for every track. A strip
 *          that fails lands the held render as it was made (FLAC: B-Sides has no encoder of its
 *          own, and Crucible no transcode job), and says why. Instrumental versions of library
 *          songs (`versions`) are uploaded and stripped the same way, a playlist's in one session.
 */

import {
  CrucibleRefused,
  CrucibleUnreachable,
  isTaskLineProgress,
  readAudioResult,
  type CrucibleClient,
  type DoneData,
  type InstallingDetails,
  type JobRequest,
  type JobStatus,
} from '@crucible/client';

import { clientFor } from './crucible';
import type { Disk } from './disk';
import { Refusal, refusalOf } from './refusal';
import type { StoredServer } from './servers';
import { denoiseJob, inputNameOf, runStrip, type StripWatch } from './strip';
import { batchSeeds } from '../batch';
import { namedSet, pickSet, planningLyrics, type Planned } from '../planning-sets';
import { styleLine, varyInstrumental } from '../tags';
import {
  ENDED_PHASES,
  SONG_MODEL,
  type ClientKind,
  type GenerateRequest,
  type InstallView,
  type JobView,
  type RefusalView,
  type SongFormat,
  type Song,
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
  /** Times sent again after the server lost it through no fault of the song's (at most RESENDS). */
  resends?: number;
  /** Sent again, with a new seed, after its worker crashed on it (at most once). */
  retried?: boolean;
  /** A held render waiting for (or in) its strip: what its done event said. */
  rendered?: { readonly artifact: string; readonly seed: number; readonly durationS: number | null; readonly effective: unknown };
  /** An instrumental version: the library song, and its audio file to upload. */
  source?: { readonly song: Song; readonly file: string; readonly beside?: boolean };
}

/** What the runner needs to strip songs (strip.ts); without it nothing is stripped. */
export interface StripOptions {
  /** Whether `server` can strip now (a StripGate). */
  can(server: StoredServer, client: CrucibleClient): Promise<boolean>;
  /** A strip the server refused for a reason no song changes (ffmpeg missing): told to the gate. */
  refuse?(server: StoredServer, why: string): void;
  /** A queue session for a run of strips, so the separator loads once; null (or absent): each on its own. */
  session?(server: StoredServer): Promise<{ readonly client: CrucibleClient; close(): Promise<unknown> } | null>;
  /** A library file's bytes, to upload for an instrumental version; absent (the phone): none are made. */
  readFile?(file: string): Promise<Uint8Array | null>;
  /** How often a denoise job is read (tests: a few ms). */
  readonly pollMs?: number;
}

/** A library song to make an instrumental version of, and its audio file. */
export interface VersionAsk {
  readonly song: Song;
  readonly file: string;
  /**
   * One song made instrumental (Owen, 2026-10-11): filed beside its original in the same
   * playlist, titled "<title> (Instrumental)"; a whole playlist's go to their own playlist.
   */
  readonly beside?: boolean;
}

/** A seed B-Sides draws itself, as the server would (0 to MAX_SEED). */
function drawSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

/**
 * An instrumental's seed and planning set, settled before it is sent (2026-10-11): Crucible has no
 * default planning set (Owen), and planned from YuE2's bare section tags a score can run to its
 * token cap, so every instrumental B-Sides sends names a set (planning-sets.ts). One already named
 * (an album's turn, kept on a remake) stays; otherwise, or when B-Sides no longer has that set, the
 * seed's, drawn here when none was asked so the set and the seed sent agree. Sung songs, and a
 * server whose YuE2 takes no `instrumental`, are left as they are.
 */
export function settleSong(params: SongParams): SongParams {
  if (params.instrumental !== true) return params;
  const seed = params.seed ?? drawSeed();
  const set = params.planning_set !== undefined && namedSet(params.planning_set) !== null ? params.planning_set : pickSet(seed).id;
  return { ...params, seed, planning_set: set };
}

/**
 * A song job, as the playground's `audio` helper builds it, plus `client_ref` (the helper does not
 * send one): `b-sides:<key>` names the song in Crucible's queue and in a restart's sweep (guide §6.3).
 *
 * An instrumental always carries `planning_lyrics` (its set, sized to the aim: planningLyrics, which
 * runs them through the ported check), and never `lyrics`, `planning_set` or a range: Crucible plans
 * them exactly as sent, and the server's own pool and sizing are no longer leaned on (2026-10-11).
 * A sung song sends no range either: Crucible only recorded it against the score, and the library
 * works that out from the score's length itself (library.ts aimOf).
 */
export function songJob(params: SongParams, format: SongFormat, key: string, hold = false): JobRequest {
  const wire: Record<string, unknown> = { format };
  if (params.tags !== undefined) wire['tags'] = params.tags;
  if (params.instrumental === true && params.experiment?.lyrics !== undefined) wire['lyrics'] = params.experiment.lyrics;
  else if (params.instrumental === true) wire['planning_lyrics'] = planningOf(params).lyrics;
  else if (params.lyrics !== undefined) wire['lyrics'] = params.lyrics;
  if (params.instrumental !== undefined) wire['instrumental'] = params.instrumental;
  if (params.cfg !== undefined) wire['cfg'] = params.cfg;
  if (params.seed !== undefined) wire['seed'] = params.seed;
  // Held (Owen, 2026-10-11): a song to strip stays on the server until its separator job has read it.
  return { type: 'audio', model: SONG_MODEL, params: wire, inputs: {}, clientRef: `b-sides:${key}`, ...(hold ? { hold: true } : {}) };
}

/** An instrumental's planning lyrics: its set (else the seed's; settleSong names one), sized to its aim. */
function planningOf(params: SongParams): Planned {
  const set = (params.planning_set === undefined ? null : namedSet(params.planning_set))
    ?? (params.seed === undefined ? null : pickSet(params.seed));
  // A bug in B-Sides, never the person's: every path settles an instrumental before it is sent.
  if (set === null) throw new Error('an instrumental reached the wire with neither a planning set nor a seed; settleSong it first');
  const sized = params.min_duration_s !== undefined || params.max_duration_s !== undefined;
  return planningLyrics(set, sized ? { min: params.min_duration_s ?? null, max: params.max_duration_s ?? null } : null);
}

/** Removed by the server for a reason that is not the song's: a session closing, a restart. */
const RESEND_REASONS: readonly string[] = ['session_closed', 'server_restart'];
/**
 * How many times a song lost to the server (removed for one of RESEND_REASONS, or interrupted
 * by a restart) is sent again before it is a failure. Weather, not the song's fault (Victoria's
 * laptop, 2026-10-10: an out-of-memory restart took the song rendering and the one queued, and
 * the album ended two short); the budget stops a song that brings the server down every time.
 */
const RESENDS = 2;

/**
 * A song whose worker crashed on it (`worker_failed`: Victoria's laptop, 2026-10-10, a CUDA
 * out-of-memory while synthesizing after a composition that ran to its cap) is sent once more
 * with a new seed, since the same seed would likely run away the same way. Only once: a song
 * that crashes its worker twice is a failure, said by name, for "Make the missing tracks".
 */
const RETRY_CODES: readonly string[] = ['worker_failed'];

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
  readonly seed: number | null;
  readonly durationS: number | null;
  readonly effective: unknown;
  /**
   * Its strip (Owen, 2026-10-11): `jobId` the denoise job its stem came from; `failed` why a strip
   * failed (the render landed as made); `of` the library song an instrumental version was made from.
   * Absent: not stripped.
   */
  readonly strip?: { readonly jobId?: string; readonly failed?: string; readonly of?: string; readonly beside?: boolean };
}

export interface JobHooks {
  /** Every change to a job, for the renderer. */
  publish(job: JobView): void;
  /** A job ended without a song (failed, refused, removed, cancelled): an album skips the track. */
  ended?(job: JobView): void;
  /** A job's song is made and is being fetched: it is off the server's line (single songs going next). */
  fetching?(job: JobView): void;
  /** An album's track is rendered and waits for its strip: its render is off the server (the album may send more). */
  rendered?(job: JobView): void;
  /** Keep a finished song: as a take, and filed into its playlist when it has one (answers the song then). */
  land(landed: Landed): Promise<{ readonly take: Take; readonly songId: string | null }>;
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
    /** A client for a server; the real one, or a test's stand-in. */
    private readonly connect: (server: StoredServer) => CrucibleClient = clientFor,
    /** Stripping songs' voices (strip.ts); null: nothing is stripped. */
    private readonly strips: StripOptions | null = null,
  ) {}

  /** Servers whose waiting strips are running now, as one batch. */
  private readonly stripping = new Set<string>();
  /** Instrumental versions, one run after another per server (each run its own session). */
  private readonly versionLines = new Map<string, Promise<void>>();

  /**
   * One client's jobs still rendering on the server (sent, waiting or running), not those made and
   * waiting for or in their strip: an album keeps this many on the server, and sends more as each
   * render ends, though its strip comes later.
   */
  rendering(client: string): number {
    return [...this.jobs.values()].filter((job) => job.view.client === client && !this.ended(job) && !this.pastRender(job) && job.view.phase !== 'fetching').length;
  }

  /** One client's jobs, oldest first. */
  /** Every album track on a server now (not ended), whichever album's. */
  albumJobs(): JobView[] {
    return [...this.jobs.values()]
      .filter((job) => job.view.album !== null && !ENDED_PHASES.includes(job.view.phase))
      .map((job) => ({ ...job.view }));
  }

  /**
   * Songs made on their own (not an album's) on `server` that the server has yet to finish: being
   * sent, waiting or rendering. One being fetched is not counted: the server is done with it.
   * Albums hold back for these when single songs go next (Victoria, 2026-10-11).
   */
  singlesWaiting(server: string): number {
    return [...this.jobs.values()].filter((job) => job.view.album == null && job.view.server === server
      && job.view.phase !== 'fetching' && !ENDED_PHASES.includes(job.view.phase)).length;
  }

  /** Name songs still on their way (a title written while they render); one already landed keeps its own. */
  retitle(keys: readonly string[], title: string): void {
    for (const key of keys) {
      const job = this.jobs.get(key);
      if (job === undefined || job.view.takeId !== null || ENDED_PHASES.includes(job.view.phase)) continue;
      job.view.title = title;
      this.publish(job);
    }
  }

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
    album: { readonly id: string; readonly track: number } | null = null,
    playlist: string | null = null,
  ): JobView[] {
    const seeds = batchSeeds(typeof request.params.seed === 'number' ? request.params.seed : null, request.count);
    const client = this.connect(server);
    // Every song's tags in YuE2's official form, whoever wrote them (styleLine): what is sent is what is kept.
    // The lead (Owen, 2026-10-11) goes into them, first; Crucible knows no `lead`, so it is not kept apart.
    const { lead, ...given } = request.params;
    const tags = given.tags ?? (lead !== undefined && lead.trim() !== '' ? '' : undefined);
    const base: SongParams = tags !== undefined && typeof given.instrumental === 'boolean'
      ? { ...given, tags: styleLine(tags, given.instrumental, lead) }
      // A server whose YuE2 takes no `instrumental` (older ones): the lead is put first, as typed.
      : lead !== undefined && lead.trim() !== '' ? { ...given, tags: [lead.trim(), tags].filter((part) => part !== '' && part !== undefined).join(', ') } : given;
    const exact = given.experiment?.tags;
    const made: Job[] = seeds.map((seed, at) => {
      const asked: Mutable<SongParams> = { ...base, ...(exact !== undefined ? { tags: exact } : {}) };
      delete asked.seed;
      if (seed !== null) asked.seed = seed;
      // An instrumental's seed and set, settled now so the job shows them from the start.
      const settled = settleSong(asked);
      // Each instrumental its own key and tempo, from its seed (Owen, 2026-10-11); a listening test's exact tags stay exact.
      const params = settled.instrumental === true && settled.tags !== undefined && settled.seed !== undefined && settled.experiment?.tags === undefined
        ? { ...settled, tags: varyInstrumental(settled.tags, settled.seed) }
        : settled;
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
          seed: params.seed ?? null,
          title: request.title ?? null,
          takeId: null,
          since: Date.now(),
          ended: null,
          album,
          playlist,
          songId: null,
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

  /**
   * Make an instrumental version of each library song (Owen, 2026-10-11): uploaded, stripped, and
   * landed under its own title into `playlist`. One run per call, in one queue session when it is
   * more than one song (a playlist's), after the server's runs asked for before it.
   */
  versions(server: StoredServer, asker: { readonly id: string; readonly kind: ClientKind }, asks: readonly VersionAsk[], format: SongFormat, playlist: string): JobView[] {
    if (this.strips?.readFile === undefined) {
      throw new Refusal('strip_unavailable', 'Instrumental versions are made on a B-Sides computer; this device cannot send a song to the server.');
    }
    const client = this.connect(server);
    const made: Job[] = asks.map((ask, at) => {
      this.numbered += 1;
      const made = ask.song.params;
      const params: SongParams = {
        ...(made.tags !== null ? { tags: made.tags } : {}),
        ...(made.lyrics !== null && !made.instrumental ? { lyrics: made.lyrics } : {}),
        instrumental: true,
        ...(made.cfg !== null ? { cfg: made.cfg } : {}),
        ...(made.seed !== null ? { seed: made.seed } : {}),
      };
      const job: Job = {
        server, client, format, taskId: null, gone: false, source: { song: ask.song, file: ask.file, ...(ask.beside === true ? { beside: true } : {}) },
        view: {
          key: crypto.randomUUID(), client: asker.id, clientKind: asker.kind, number: this.numbered, index: at + 1, batch: asks.length,
          server: server.name, jobId: null, phase: 'submitting', position: null, of: null, fraction: null,
          message: 'Waiting its turn for the separator', install: null, refusal: null, params, seed: made.seed,
          title: ask.song.title, takeId: null, since: Date.now(), ended: null, album: null, playlist, songId: null,
          strip: { state: 'stripping', format, jobId: null, of: ask.song.id },
        },
      };
      this.jobs.set(job.view.key, job);
      this.publish(job);
      return job;
    });
    const line = (this.versionLines.get(server.name) ?? Promise.resolve()).then(() => this.runVersions(made));
    this.versionLines.set(server.name, line.catch(() => undefined));
    return made.map((job) => ({ ...job.view }));
  }

  async cancel(key: string): Promise<null> {
    const job = this.jobs.get(key);
    if (job === undefined || this.ended(job)) return null;
    if (job.view.strip != null && (job.view.strip.of != null || this.pastRender(job))) {
      // Its render is done (or there is none): the strip, or its turn for one, is what is cancelled.
      job.gone = true;
      // Waiting for its turn (an album track's batch, a version not begun): it ends now. One running
      // sees `gone` and takes its denoise job off the server itself.
      if (job.view.strip.state === 'waiting' || (job.view.strip.of != null && job.view.phase === 'submitting')) {
        this.release(job);
        this.finish(job, 'cancelled');
      }
      return null;
    }
    if (job.view.phase === 'installing') {
      if (job.taskId === null || job.view.install?.ours !== true) {
        throw new Refusal('install_not_ours', 'This install was started by another client; it is not B-Sides\'s to cancel.');
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

  /** Follow again the jobs that were generating when B-Sides last quit. */
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
      const job: Job = { server, client: this.connect(server), format: 'flac', taskId: null, gone: false, view: { ...view, message: 'Following it again after a restart' } };
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
    if (job.client === null) throw new Refusal('unknown_server', `B-Sides no longer has the server ${job.view.server}.`);
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
    else this.hooks.ended?.({ ...job.view });
    void this.savePending();
    // A render ending may be the last on its server: the album tracks waiting to be stripped go now.
    this.flushStrips(job.view.server);
  }

  /** The jobs the server has and that have not ended: what a restart must pick up. */
  private savePending(): Promise<void> {
    this.saving = this.saving.then(() => this.writePending());
    return this.saving;
  }

  private async writePending(): Promise<void> {
    const entries: PendingEntry[] = [...this.jobs.values()]
      // An instrumental version is not followed again after a restart (it is asked for again): its
      // job is a denoise, whose events land no render.
      .filter((job) => job.view.jobId !== null && !this.ended(job) && job.view.strip?.of == null)
      .map((job) => ({ view: { ...job.view } }));
    try {
      await this.disk.writeText(this.pendingFile, `${JSON.stringify(entries, null, 2)}\n`);
    } catch (err) {
      console.error(`[jobs] could not record pending jobs in ${this.pendingFile}:`, err);
    }
  }

  private async submit(job: Job): Promise<void> {
    const client = this.clientOf(job);
    // Stripped (Owen, 2026-10-11): an instrumental, on a server that can, is rendered lossless and
    // held; the separator's stem comes back in the person's format. Decided once, on first sending.
    if (job.view.strip === undefined && job.view.params.instrumental === true && this.strips !== null) {
      const can = await this.strips.can(job.server, client).catch(() => false);
      job.view.strip = can ? { state: 'rendering', format: job.format, jobId: null } : null;
    }
    const strip = job.view.strip ?? null;
    let jobId: string | null = null;
    for (let round = 0; jobId === null; round += 1) {
      if (job.gone) return;
      try {
        // The guard every path passes (a single, a preset, an album track, a remake, a resend, a
        // retry, a job resumed from pending.json, the phone's hub): an instrumental goes with its set.
        job.view.params = settleSong(job.view.params);
        if (job.view.params.seed !== undefined) job.view.seed = job.view.params.seed;
        jobId = await client.submit(songJob(job.view.params, strip === null ? job.format : 'flac', job.view.key, strip !== null));
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
              if (this.retry(job, event.data.error.code)) return;
              this.finish(job, 'failed', { code: event.data.error.code, message: event.data.error.message });
              return;
            case 'cancelled':
              this.finish(job, 'cancelled');
              return;
            case 'removed':
              // Lost to something else (QUEUE.md: a session closing, a server restart): sent again
              // rather than gone from the playing list. Any other removal is the end of it.
              if (RESEND_REASONS.includes(event.data.reason) && this.resend(job, 'The server dropped it from its line')) return;
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
   * Send a song the server lost (not through its own fault) again, within RESENDS. Answers
   * whether it was sent; false once the budget is spent, and the caller ends it.
   */
  private resend(job: Job, why: string): boolean {
    const resends = job.resends ?? 0;
    if (resends >= RESENDS) return false;
    job.resends = resends + 1;
    job.view.jobId = null;
    job.view.phase = 'submitting';
    job.view.message = `${why}; sending it again`;
    this.publish(job);
    void this.submit(job);
    return true;
  }

  /** Send a song its worker crashed on again, once, with a new seed (RETRY_CODES). */
  private retry(job: Job, code: string): boolean {
    if (!RETRY_CODES.includes(code) || job.retried === true) return false;
    job.retried = true;
    const { seed: _crashed, planning_set: set, ...params } = job.view.params;
    // A song on its own takes the new seed's set too, as Crucible's pick did; an album's track keeps its turn's.
    job.view.params = job.view.album != null && set !== undefined ? { ...params, planning_set: set } : params;
    job.view.seed = null;
    job.view.jobId = null;
    job.view.phase = 'submitting';
    job.view.message = `${job.view.server} crashed making it; trying once more with a new seed`;
    this.publish(job);
    void this.submit(job);
    return true;
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
      case 'interrupted':
        // The server went down with it (a crash, an out-of-memory kill, a deploy): weather.
        if (this.resend(job, `${job.view.server} restarted while making it`)) return true;
        this.finish(job, 'failed', status.error ?? {
          code: 'job_interrupted',
          message: `${job.view.server} restarted while making this song, ${RESENDS + 1} times. Generate again.`,
        });
        return true;
      case 'failed':
        if (status.error !== null && this.retry(job, status.error.code)) return true;
        this.finish(job, 'failed', status.error ?? {
          code: 'job_failed',
          message: `${job.view.server} stopped while making this song (it failed). Generate again.`,
        });
        return true;
      case 'cancelled':
        this.finish(job, 'cancelled');
        return true;
      case 'removed':
        // Read after the stream dropped: the same rule as the `removed` event it would have carried.
        if (status.removal !== null && RESEND_REASONS.includes(status.removal.reason)
          && this.resend(job, 'The server dropped it from its line')) return true;
        this.finish(job, 'removed', status.removal === null
          ? { code: 'removed', message: `${job.view.server} removed this song before it was fetched.` }
          : { code: `removed_${status.removal.reason}`, message: status.removal.message });
        return true;
      default:
        return false;
    }
  }

  /** `done`: fetch the audio and file it. A fetch the server cannot answer is retried, saying so. */
  private async land(job: Job, done: DoneData): Promise<void> {
    const jobId = job.view.jobId as string;
    let rendered: NonNullable<Job['rendered']>;
    try {
      const result = readAudioResult(done);
      job.view.seed = result.seed;
      rendered = { artifact: result.artifact, seed: result.seed, durationS: result.audioSeconds, effective: (done.extra as Record<string, unknown>)['audio'] };
    } catch (error) {
      this.finish(job, 'failed', refusalOf(error));
      return;
    }
    const strip = job.view.strip ?? null;
    if (strip === null) {
      await this.deliver(job, { fill: this.filler(job, jobId, rendered.artifact), extension: extensionOf(rendered.artifact), seed: rendered.seed, durationS: rendered.durationS, effective: rendered.effective });
      return;
    }
    job.rendered = rendered;
    // Every song, an album's track too, is stripped at once and delivered, so it can be heard as soon
    // as it is made (Owen, 2026-10-11: "the goal is to get the user listening asap"); the album sends
    // its next track once this one is in. The cost is a reload of YuE2 after each strip.
    await this.stripRendered(job, this.clientOf(job));
  }

  /** Whether a job's render is behind it: made and waiting for its strip, or in it (or never had one). */
  private pastRender(job: Job): boolean {
    const state = job.view.strip?.state;
    return state === 'waiting' || state === 'stripping';
  }

  /** A held render no longer needed on the server: its hold let go (in the background). */
  private release(job: Job): void {
    const renderId = job.rendered === undefined ? null : job.view.jobId;
    if (renderId === null || job.client === null) return;
    void job.client.releaseArtifacts(renderId).catch((err: unknown) => console.error(`[strip] could not let go of ${renderId} on ${job.view.server}:`, err));
  }

  /** Fetch `artifact` of `jobId` into a file, retrying while the server cannot be reached. */
  private filler(job: Job, jobId: string, artifact: string): (file: string) => Promise<number> {
    return async (file) => {
      for (;;) {
        try {
          return await this.fetchAudio(job.server, jobId, artifact, file);
        } catch (error) {
          if (!(error instanceof CrucibleUnreachable)) throw error;
          job.view.message = 'Fetching the song: the server is not answering, trying again';
          this.publish(job);
          await pause(RECONNECT_MS);
        }
      }
    };
  }

  /** The song is made: fetch it and hand it to the take cache. */
  private async deliver(job: Job, landed: Omit<Landed, 'job' | 'server'>): Promise<void> {
    job.view.phase = 'fetching';
    job.view.fraction = 1;
    job.view.message = 'Fetching the song';
    this.publish(job);
    this.hooks.fetching?.({ ...job.view });
    try {
      const { take, songId } = await this.hooks.land({ ...landed, job: { ...job.view }, server: job.server });
      job.view.takeId = take.id;
      job.view.songId = songId;
      job.view.message = null;
      this.finish(job, 'done');
    } catch (error) {
      this.finish(job, 'failed', refusalOf(error));
    }
  }

  /** How a strip run shows on its job. */
  private watch(job: Job): StripWatch {
    return {
      progress: (fraction, message) => {
        job.view.phase = 'running';
        job.view.fraction = fraction;
        job.view.message = message;
        this.publish(job);
      },
      sent: (jobId) => {
        if (job.view.strip != null) job.view.strip = { ...job.view.strip, jobId };
        this.publish(job);
      },
      gone: () => job.gone,
    };
  }

  /**
   * Strip a held render through `client` (a session's in a batch) and land its instrumental stem. A
   * strip that fails lands the render as made, and says why; the song is never lost to it.
   */
  private async stripRendered(job: Job, client: CrucibleClient): Promise<void> {
    const rendered = job.rendered as NonNullable<Job['rendered']>;
    const renderId = job.view.jobId as string;
    const strip = job.view.strip as NonNullable<JobView['strip']>;
    job.view.strip = { ...strip, state: 'stripping' };
    this.watch(job).progress(null, 'Taking out stray voices');
    let landed: Omit<Landed, 'job' | 'server'>;
    try {
      // Chained (crucible-pc-1, 2026-10-11): the held render is the separator's input by reference,
      // nothing is uploaded. Named for its own extension, as the stems are named from it.
      const input = { artifact: { jobId: renderId, name: rendered.artifact } };
      const done = await runStrip(client, denoiseJob(input, inputNameOf(rendered.artifact), strip.format, job.view.key), this.watch(job), strip.jobId, this.strips?.pollMs);
      landed = { fill: this.filler(job, done.jobId, done.stem), extension: extensionOf(done.stem), seed: rendered.seed, durationS: rendered.durationS, effective: rendered.effective, strip: { jobId: done.jobId } };
    } catch (error) {
      if (job.gone) {
        this.release(job);
        this.finish(job, 'cancelled');
        return;
      }
      const why = refusalOf(error).message;
      console.error(`[strip] ${job.view.server} could not strip ${renderId}; it is kept as made (${rendered.artifact}): ${why}`);
      if (error instanceof CrucibleRefused && error.code === 'ffmpeg_missing') this.strips?.refuse?.(job.server, why);
      landed = { fill: this.filler(job, renderId, rendered.artifact), extension: extensionOf(rendered.artifact), seed: rendered.seed, durationS: rendered.durationS, effective: rendered.effective, strip: { failed: why } };
    }
    try {
      await this.deliver(job, landed);
    } finally {
      this.release(job);
    }
  }

  /**
   * An album's tracks waiting for their strips on `server` go once nothing of ours is rendering
   * there (crucible-pc-1, 2026-10-11: one engine on a card at a time, ~20 s to trade YuE2 for the
   * separator): all of them, in one queue session, so the separator loads once.
   */
  private flushStrips(server: string): void {
    if (this.stripping.has(server)) return;
    const on = [...this.jobs.values()].filter((job) => job.view.server === server && !this.ended(job) && job.view.strip?.of == null);
    const waiting = on.filter((job) => job.view.strip?.state === 'waiting' && !job.gone);
    if (waiting.length === 0 || on.some((job) => !this.pastRender(job))) return;
    this.stripping.add(server);
    void this.stripBatch(server, (waiting[0] as Job).server)
      .catch((err: unknown) => console.error(`[strip] the strips waiting on ${server} stopped:`, err))
      .finally(() => {
        this.stripping.delete(server);
        this.flushStrips(server);
      });
  }

  private async stripBatch(name: string, server: StoredServer): Promise<void> {
    const next = (): Job | undefined => [...this.jobs.values()]
      .find((job) => job.view.server === name && job.view.strip?.state === 'waiting' && !job.gone && !this.ended(job));
    const session = await this.openSession(server, next());
    try {
      for (let job = next(); job !== undefined; job = next()) await this.stripRendered(job, session?.client ?? this.clientOf(job));
    } finally {
      await session?.close().catch(() => undefined);
    }
  }

  /** A queue session for a run of strips; null when there is none to be had (each strip goes on its own). */
  private async openSession(server: StoredServer, first: Job | undefined): Promise<{ readonly client: CrucibleClient; close(): Promise<unknown> } | null> {
    if (this.strips?.session === undefined) return null;
    if (first !== undefined) this.watch(first).progress(null, 'Waiting for the separator\'s turn on the server');
    return this.strips.session(server).catch((err: unknown) => {
      console.error(`[strip] no queue session on ${server.name}; stripping each song on its own:`, err);
      return null;
    });
  }

  /** Instrumental versions, one after another, in one session when there are several. */
  private async runVersions(jobs: readonly Job[]): Promise<void> {
    const live = jobs.filter((job) => !job.gone);
    if (live.length === 0) return;
    const session = live.length > 1 ? await this.openSession(live[0]!.server, live[0]) : null;
    try {
      for (const job of jobs) if (!job.gone && !this.ended(job)) await this.stripVersion(job, session?.client ?? this.clientOf(job));
    } finally {
      await session?.close().catch(() => undefined);
    }
  }

  /** Upload a library song, strip it, and land its instrumental stem as a new song. */
  private async stripVersion(job: Job, client: CrucibleClient): Promise<void> {
    const source = job.source as NonNullable<Job['source']>;
    const strip = job.view.strip as NonNullable<JobView['strip']>;
    let landed: Omit<Landed, 'job' | 'server'>;
    try {
      this.watch(job).progress(null, 'Sending the song to the server');
      const bytes = await this.strips?.readFile?.(source.file);
      if (bytes == null) throw new Refusal('song_missing', `${source.song.title}'s audio file is not in the library folder.`);
      const name = inputNameOf(source.file);
      // Uploaded (crucible-pc-1, 2026-10-11): a library song has no held render to chain from.
      const uploaded = await client.upload(bytes, { filename: name });
      const done = await runStrip(client, denoiseJob({ blobId: uploaded.blobId }, name, strip.format, job.view.key), this.watch(job), null, this.strips?.pollMs);
      job.view.jobId = done.jobId;
      landed = {
        fill: this.filler(job, done.jobId, done.stem), extension: extensionOf(done.stem), seed: source.song.params.seed,
        durationS: source.song.durationS, effective: null,
        strip: { jobId: done.jobId, of: source.song.id, ...(source.beside === true ? { beside: true } : {}) },
      };
    } catch (error) {
      if (job.gone) this.finish(job, 'cancelled');
      else {
        if (error instanceof CrucibleRefused && error.code === 'ffmpeg_missing') this.strips?.refuse?.(job.server, refusalOf(error).message);
        this.finish(job, 'failed', refusalOf(error));
      }
      return;
    }
    await this.deliver(job, landed);
  }
}

/** A file name's extension, lower-cased, without its dot. */
function extensionOf(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1).toLowerCase();
}
