/**
 * strip — a library song's voice taken out by Crucible's separator: an "Instrumental version".
 *
 * Owen, 2026-10-11: any song can be made into an instrumental version: its library file is
 * uploaded, the `denoise` job (`vocals-roformer`, `stems: all`) separates it, and the instrumental
 * stem comes back in the person's own format as a new song. Renders are NOT put through it
 * (Owen, 2026-10-12: "vocal sep doesnt work for yue generated audio ... it damages the audio";
 * the level pumps as the voice comes and goes): a render lands as made.
 *
 * What Crucible's 2.0.4 contract says (crucible-pc-1, 2026-10-11), and B-Sides leans on:
 *   - denoise takes any ffmpeg-decodable input at any rate (2.0.2 took only 44.1 kHz WAV/FLAC);
 *   - `format` (wav | flac | mp3) is each stem's container, encoded as an audio job's;
 *   - stems are named from the input's name: `<input>_(vocals)_<checkpoint>.<ext>` and
 *     `<input>_(other)_<checkpoint>.<ext>`; "(other)" is the instrumental. The vocals stem of a clean
 *     song is silent, never missing, and is not read at all here.
 *   - one engine is resident on a card at a time, so a playlist's versions run in one queue
 *     session (jobs.ts).
 */
import { CrucibleRefused, CrucibleUnreachable, type CrucibleClient, type JobInput, type JobRequest, type ServerInfo } from '@crucible/client';

import { Refusal } from './refusal';
import { SEPARATOR_MODEL } from './server-needs';
import type { StoredServer } from './servers';
import type { SongFormat, StripAbility } from '../types';

/** The first Crucible whose separator takes YuE2's 48 kHz songs and encodes its stems (2.0.4). */
export const STRIP_FROM: readonly [number, number, number] = [2, 0, 4];
/**
 * A feature flag in `GET /v1/info` that would say the same without a version (none ships in 2.0.4;
 * this name is B-Sides' guess, asked of crucible-pc-1). Found, it wins over the version.
 */
export const STRIP_FEATURE = 'denoise.any-input';

/** Whether `version` (2.0.4, 2.0.4.dev1, 2.1.0+abc) is at least `least`. Unreadable: no. */
export function versionAtLeast(version: string, least: readonly number[]): boolean {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (parts === null) return false;
  const have = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  for (let at = 0; at < least.length; at += 1) {
    const a = have[at] ?? 0;
    const b = least[at] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** Whether a server can strip, from what its `GET /v1/info` says, and why not in a sentence. */
export function stripVerdict(info: Pick<ServerInfo, 'features' | 'jobTypes'> & { readonly server: { readonly version: string } }): StripAbility {
  if (!info.jobTypes.includes('denoise')) {
    return { can: false, why: 'Its vocal separator (Crucible\'s denoise job) is not installed or not turned on yet.' };
  }
  if (info.features.includes(STRIP_FEATURE) || versionAtLeast(info.server.version, STRIP_FROM)) return { can: true, why: null };
  return { can: false, why: `It runs Crucible ${info.server.version}; taking the voice out of a song needs ${STRIP_FROM.join('.')} or newer.` };
}

interface Known extends StripAbility {
  readonly at: number;
}

/** How long a server's answer is trusted before it is asked again (an update, the separator installed). */
const RECHECK_MS = 10 * 60_000;

/**
 * Whether each server can strip, asked of its `/v1/info` at most every RECHECK_MS. A server that
 * cannot is said ONCE in the log (and again only when that changes): songs then come out as they
 * always did, with no error and no warning per song.
 */
export class StripGate {
  private readonly known = new Map<string, Known>();

  constructor(
    private readonly log: (line: string) => void = (line) => console.log(line),
    private readonly recheckMs = RECHECK_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private keyOf(server: StoredServer): string {
    return `${server.name} ${server.url}`;
  }

  /** What was last found for `server`, or null when it has not been asked. */
  ability(server: StoredServer): StripAbility | null {
    const known = this.known.get(this.keyOf(server));
    return known === undefined ? null : { can: known.can, why: known.why };
  }

  async can(server: StoredServer, client: CrucibleClient): Promise<boolean> {
    return (await this.check(server, client)).can;
  }

  async check(server: StoredServer, client: CrucibleClient): Promise<StripAbility> {
    const key = this.keyOf(server);
    const known = this.known.get(key);
    if (known !== undefined && this.now() - known.at < this.recheckMs) return { can: known.can, why: known.why };
    let found: StripAbility;
    try {
      found = stripVerdict(await client.info());
    } catch (error) {
      found = { can: false, why: `B-Sides could not ask it (${error instanceof Error ? error.message : String(error)}).` };
    }
    this.set(server, found);
    return found;
  }

  /** A strip the server refused for a reason no song will change (ffmpeg missing): none is tried until the recheck. */
  refuse(server: StoredServer, why: string): void {
    this.set(server, { can: false, why });
  }

  private set(server: StoredServer, found: StripAbility): void {
    const key = this.keyOf(server);
    const before = this.known.get(key);
    this.known.set(key, { ...found, at: this.now() });
    if (before?.can === found.can && before.why === found.why) return;
    this.log(found.can
      ? `[strip] ${server.name} takes the voice out of instrumentals`
      : `[strip] ${server.name} cannot take the voice out of songs; they are kept as rendered. ${found.why}`);
  }
}

/** The instrumental among a separation's stems: "(other)" (vocals-roformer's), else the one stem that is not a voice. */
export function instrumentalStem(stems: readonly string[], primary: string | null = null): string | null {
  const named = stems.find((name) => /\((other|instrumental|no[ _-]?vocals?)\)/i.test(name));
  if (named !== undefined) return named;
  const rest = stems.filter((name) => name !== primary && !/\((vocals?|dry)\)/i.test(name));
  return rest.length === 1 ? (rest[0] as string) : null;
}

/** The denoise job: every stem, encoded as the person keeps songs. `input` names its file (the stems are named from it). */
export function denoiseJob(input: JobInput, inputName: string, format: SongFormat, key: string): JobRequest {
  return {
    type: 'denoise',
    model: SEPARATOR_MODEL,
    params: { stems: 'all', format },
    inputs: { [inputName]: input },
    clientRef: `b-sides:strip:${key}`,
  };
}


/** What a strip run tells the job it is for. */
export interface StripWatch {
  /** The run's place: a fraction (null: not known) and a sentence. */
  progress(fraction: number | null, message: string): void;
  /** The denoise job's id, once the server has it. */
  sent(jobId: string): void;
  /** The song was cancelled: the run stops (and takes its job off the server). */
  gone(): boolean;
}

/** A finished strip: the denoise job and its instrumental stem's name. */
export interface Stripped {
  readonly jobId: string;
  readonly stem: string;
}

const POLL_MS = 1500;
const INSTALL_ROUNDS = 3;
const ENDED = ['failed', 'cancelled', 'interrupted', 'removed'];

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send `request` and follow it to its stem. A separator the server has yet to install answers
 * `409 installing`: its task is waited for and the job sent again. The job's status is read every
 * POLL_MS (a strip is short; a dropped stream costs nothing this way). Throws a Refusal naming why.
 * `existing`: a denoise job sent before (a restart): followed, not sent again, while it lives.
 */
export async function runStrip(client: CrucibleClient, request: JobRequest, watch: StripWatch, existing: string | null = null, pollMs = POLL_MS): Promise<Stripped> {
  const { jobId, artifacts } = await runSeparation(client, request, watch, existing, pollMs, 'Taking out the voice');
  const stem = instrumentalStem(artifacts);
  if (stem === null) throw new Refusal('strip_no_stem', `The separator answered without an instrumental stem (it gave ${artifacts.join(', ') || 'nothing'}).`);
  return { jobId, stem };
}

/** A separation sent and followed to its artifacts; `doing` is its sentence while it runs. */
async function runSeparation(client: CrucibleClient, request: JobRequest, watch: StripWatch, existing: string | null, pollMs: number, doing: string): Promise<{ readonly jobId: string; readonly artifacts: readonly string[] }> {
  let jobId = existing;
  if (jobId !== null) {
    const alive = await client.job(jobId).then((status) => !ENDED.includes(status.status), () => false);
    if (!alive) jobId = null;
  }
  for (let round = 0; jobId === null; round += 1) {
    if (watch.gone()) throw new Refusal('strip_cancelled', 'Cancelled.');
    try {
      jobId = await client.submit(request);
    } catch (error) {
      const details = error instanceof CrucibleRefused ? (error.details as { task_id?: unknown } | null) : null;
      if (!(error instanceof CrucibleRefused) || error.code !== 'installing' || typeof details?.task_id !== 'string' || round >= INSTALL_ROUNDS) throw error;
      watch.progress(null, 'Installing the vocal separator first, once');
      for (;;) {
        await pause(pollMs);
        const task = await client.task(details.task_id).catch(() => null);
        if (task === null || task.state === 'running') continue;
        if (task.state !== 'done') throw new Refusal('strip_install_failed', `The server could not install its vocal separator: ${task.error?.message ?? task.state}.`);
        break;
      }
    }
  }
  watch.sent(jobId);
  for (;;) {
    if (watch.gone()) {
      await client.cancel(jobId).catch(() => undefined);
      throw new Refusal('strip_cancelled', 'Cancelled.');
    }
    let status;
    try {
      status = await client.job(jobId);
    } catch (error) {
      if (!(error instanceof CrucibleUnreachable)) throw error;
      watch.progress(null, `${doing}: the server is not answering, trying again`);
      await pause(pollMs);
      continue;
    }
    if (status.status === 'done') return { jobId, artifacts: status.artifacts };
    if (ENDED.includes(status.status)) {
      throw new Refusal(status.error?.code ?? 'strip_failed', `The separator's job ${status.status}: ${status.error?.message ?? status.removal?.message ?? 'no reason given'}.`);
    }
    if (status.status === 'queued') watch.progress(null, status.position === null ? 'Waiting for the separator' : `Waiting for the separator, number ${status.position} in line`);
    else watch.progress(status.progress > 0 ? status.progress : null, doing);
    await pause(pollMs);
  }
}

/** The file name a render is given as the separator's input: its own extension, so ffmpeg knows it. */
export function inputNameOf(artifact: string): string {
  const dot = artifact.lastIndexOf('.');
  return `song${dot < 0 ? '.flac' : artifact.slice(dot).toLowerCase()}`;
}
