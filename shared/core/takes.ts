/**
 * takes — the generated songs nobody has saved: every client's playing list.
 *
 * A take is two files in the hub's take cache (`<userData>/takes/`), like a
 * library song: `<id>.flac` and `<id>.json`, whose sidecar also names the
 * CLIENT whose playing list it is in. Nothing here is kept for long — Owen,
 * 2026-10-04: "Things only save long term if the user saves them to a
 * playlist". The cache clears oldest first (FIFO), well before it is a problem:
 *
 *   - per client, by count (`TAKES_PER_CLIENT`: a phone and a browser tab keep
 *     fewer than the desktop);
 *   - all takes together, by bytes on the hub's disk (`TAKE_CACHE_BYTES`);
 *   - a whole client at once when it is gone (a closed browser tab: the hub's
 *     client tracker decides that, this store only does the removing).
 *
 * Every take that leaves is reported through `onGone`, so each client's list
 * drops it. The store holds its index in memory (read from the sidecars once at
 * open); the sidecars are the truth and are written atomically.
 *
 * Like `Library`, this takes its folder and its `Disk` rather than asking for
 * either, so it runs on the desktop, on the phone and under a test alike.
 */
import { basename, join, type Disk } from './disk';
import { Refusal } from './refusal';
import type { ClientKind, SongFacts, Take, TakeGoneReason } from '../types';

/** The audio B-Side keeps: what Crucible's song model renders. */
export const AUDIO_FILE = /\.(flac|wav|mp3)$/i;

/** Marks a take sidecar, and its shape's version. */
const TAKE_VERSION = 1;

interface TakeSidecar extends Take {
  readonly bsideTake: number;
  readonly kind: ClientKind;
  /** The server's effective params and measurements, verbatim (the library keeps them on save). */
  readonly effective: unknown;
}

export interface NewTake extends Omit<SongFacts, 'id' | 'file'> {
  readonly client: string;
  readonly kind: ClientKind;
  readonly extension: string;
  /** Write the audio to this file and answer its size (the job runner's fetcher: natively on the phone). */
  readonly fill: (file: string) => Promise<number>;
  readonly effective: unknown;
}

export interface TakeLimits {
  readonly perClient: Readonly<Record<ClientKind, number>>;
  readonly bytes: number;
}

export type GoneListener = (take: Take, reason: TakeGoneReason) => void;

/** `YYYYMMDD-HHMMSS` in local time: ids sort as they were made, and read as when. */
export function stamp(date: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
}

/** An id is a bare file stem: nothing that could climb out of its folder. */
export function checkId(id: string, what: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith('.')) {
    throw new Refusal(`${what}_id_invalid`, `${id} is not a ${what}.`, 404);
  }
  return id;
}

function takeOf(sidecar: TakeSidecar): Take {
  return {
    id: sidecar.id,
    client: sidecar.client,
    title: sidecar.title,
    file: sidecar.file,
    model: sidecar.model,
    params: sidecar.params,
    server: sidecar.server,
    jobId: sidecar.jobId,
    createdAt: sidecar.createdAt,
    durationS: sidecar.durationS,
    batch: sidecar.batch,
    bytes: sidecar.bytes,
    savedAs: sidecar.savedAs,
  };
}

function byAge(a: TakeSidecar, b: TakeSidecar): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

export class TakeStore {
  private readonly takes = new Map<string, TakeSidecar>();
  private readonly goneListeners: GoneListener[] = [];
  /** Writes and removals, one at a time: eviction reads the index the last write left. */
  private line: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly disk: Disk,
    readonly dir: string,
    private readonly limits: TakeLimits,
  ) {}

  onGone(listener: GoneListener): void {
    this.goneListeners.push(listener);
  }

  /**
   * Read the cache. A sidecar that will not read, or whose audio is missing, is
   * a broken cache entry, not a song anyone saved: it is removed, and said so.
   */
  async open(): Promise<void> {
    await this.disk.mkdir(this.dir);
    const names = (await this.disk.list(this.dir)) ?? [];
    for (const name of names) {
      if (name.endsWith('.writing')) {
        // A write the last run never finished.
        await this.disk.remove(join(this.dir, name));
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      try {
        const text = await this.disk.readText(join(this.dir, name));
        const sidecar = JSON.parse(text ?? '') as TakeSidecar;
        if (sidecar.bsideTake !== TAKE_VERSION || sidecar.id !== id) throw new Error('not a B-Side take sidecar');
        if (!(await this.disk.exists(this.audioFile(sidecar)))) throw new Error(`its audio ${sidecar.file} is missing`);
        this.takes.set(id, sidecar);
      } catch (err) {
        console.error(`[takes] ${name} is a broken cache entry (${(err as Error).message}); removing it`);
        await this.disk.remove(join(this.dir, name));
      }
    }
    // Audio whose sidecar is gone (a crash between the two removals).
    const known = new Set([...this.takes.values()].map((take) => take.file));
    for (const name of names) {
      if (AUDIO_FILE.test(name) && !known.has(name)) {
        console.error(`[takes] ${name} has no sidecar; removing it`);
        await this.disk.remove(join(this.dir, name));
      }
    }
    await this.serial(() => this.enforceBytes());
  }

  /** One client's playing list, oldest first (the order it plays in). */
  list(client: string): Take[] {
    return [...this.takes.values()].filter((take) => take.client === client).sort(byAge).map(takeOf);
  }

  /** Every client that has takes, with its kind: for the client tracker at startup. */
  clients(): Map<string, ClientKind> {
    const found = new Map<string, ClientKind>();
    for (const take of this.takes.values()) found.set(take.client, take.kind);
    return found;
  }

  get(id: string): Take {
    return takeOf(this.sidecar(id));
  }

  /** The take's sidecar fields the library keeps when it is saved. */
  effective(id: string): unknown {
    return this.sidecar(id).effective;
  }

  audioPath(id: string): string {
    return this.audioFile(this.sidecar(id));
  }

  async add(input: NewTake): Promise<Take> {
    return this.serial(async () => {
      const extension = input.extension.toLowerCase();
      if (!AUDIO_FILE.test(`.${extension}`)) {
        throw new Refusal('song_format', `B-Side keeps flac, wav or mp3 audio, not .${input.extension}.`);
      }
      const base = `${stamp(new Date(input.createdAt))}-${input.params.seed ?? 'noseed'}`;
      let id = base;
      for (let n = 2; this.takes.has(id); n += 1) id = `${base}-${n}`;
      const sidecar: TakeSidecar = {
        bsideTake: TAKE_VERSION,
        id,
        client: input.client,
        kind: input.kind,
        title: input.title,
        file: `${id}.${extension}`,
        model: input.model,
        params: input.params,
        server: input.server,
        jobId: input.jobId,
        createdAt: input.createdAt,
        durationS: input.durationS,
        batch: input.batch,
        bytes: 0,
        savedAs: null,
        effective: input.effective,
      };
      // Audio first, then the sidecar: a crash between leaves audio with no sidecar, which open() clears.
      // The audio arrives under a temporary name, so a half-fetched song never sits under its own.
      const audio = this.audioFile(sidecar);
      const bytes = await input.fill(`${audio}.writing`);
      await this.disk.move(`${audio}.writing`, audio);
      const filed: TakeSidecar = { ...sidecar, bytes };
      await this.disk.writeText(this.sidecarFile(id), `${JSON.stringify(filed, null, 2)}\n`);
      this.takes.set(id, filed);
      await this.enforceClient(input.client, input.kind, id);
      await this.enforceBytes(id);
      return takeOf(filed);
    });
  }

  /** Record that a take was saved to the library as `songId`, so a second save reuses that song. */
  async markSaved(id: string, songId: string): Promise<Take> {
    return this.serial(async () => {
      const sidecar: TakeSidecar = { ...this.sidecar(id), savedAs: songId };
      await this.disk.writeText(this.sidecarFile(id), `${JSON.stringify(sidecar, null, 2)}\n`);
      this.takes.set(id, sidecar);
      return takeOf(sidecar);
    });
  }

  /** Take one take off its playing list (the person removed it). Only its own client may. */
  async remove(id: string, client: string): Promise<void> {
    await this.serial(async () => {
      const sidecar = this.sidecar(id);
      if (sidecar.client !== client) throw new Refusal('take_not_yours', `${id} is in another device's playing list.`, 403);
      await this.drop(sidecar, 'removed');
    });
  }

  /** Clear a whole client's playing list (a browser tab that closed). */
  async removeClient(client: string, reason: TakeGoneReason): Promise<void> {
    await this.serial(async () => {
      for (const sidecar of [...this.takes.values()].filter((take) => take.client === client)) {
        await this.drop(sidecar, reason);
      }
    });
  }

  totalBytes(): number {
    let total = 0;
    for (const take of this.takes.values()) total += take.bytes;
    return total;
  }

  // ───────────────────────────────────────────────────────────────────────────

  private sidecar(id: string): TakeSidecar {
    const found = this.takes.get(checkId(id, 'take'));
    if (found === undefined) throw new Refusal('take_missing', `The take ${id} is no longer in the playing list.`, 404);
    return found;
  }

  private sidecarFile(id: string): string {
    return join(this.dir, `${checkId(id, 'take')}.json`);
  }

  private audioFile(sidecar: TakeSidecar): string {
    return join(this.dir, basename(sidecar.file));
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.line.then(work);
    this.line = next.catch(() => undefined);
    return next;
  }

  /** The sidecar goes first: a crash between leaves audio with no sidecar, which open() clears. */
  private async drop(sidecar: TakeSidecar, reason: TakeGoneReason): Promise<void> {
    await this.disk.remove(this.sidecarFile(sidecar.id));
    await this.disk.remove(this.audioFile(sidecar));
    this.takes.delete(sidecar.id);
    const take = takeOf(sidecar);
    for (const listener of this.goneListeners) listener(take, reason);
  }

  /** A client over its count: its oldest go, never the take just added. */
  private async enforceClient(client: string, kind: ClientKind, keep: string): Promise<void> {
    const cap = this.limits.perClient[kind];
    const own = [...this.takes.values()].filter((take) => take.client === client).sort(byAge);
    for (const sidecar of own.slice(0, Math.max(0, own.length - cap))) {
      if (sidecar.id !== keep) await this.drop(sidecar, 'client_cap');
    }
  }

  /** The cache over its bytes: the oldest takes of anybody go, never the take just added. */
  private async enforceBytes(keep?: string): Promise<void> {
    const oldest = [...this.takes.values()].sort(byAge);
    let total = this.totalBytes();
    for (const sidecar of oldest) {
      if (total <= this.limits.bytes) return;
      if (sidecar.id === keep) continue;
      total -= sidecar.bytes;
      await this.drop(sidecar, 'disk_budget');
    }
  }
}
