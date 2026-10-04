/**
 * types — the shapes that cross the IPC bridge, compiled by both programs.
 *
 * Main owns every Crucible call, the library on disk and the server registry;
 * the renderer only ever sees these views. A server's TOKEN never crosses: a
 * view carries `hasToken` where the stored entry carries the secret.
 */

/** The one model B-Side makes songs with. */
export const SONG_MODEL = 'yue2-3b';

/** A refusal or failure, in the server's own words where it gave some. */
export interface RefusalView {
  /** The server's named code (`audio_param_missing`, ...) or one of ours (`unreachable`, `no_server`). */
  readonly code: string;
  readonly message: string;
}

/** Every IPC call answers with this, so a refusal reaches the screen with its code intact. */
export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: RefusalView };

// ─────────────────────────────────────────────────────────────────────────────
// Servers
// ─────────────────────────────────────────────────────────────────────────────

/** One Crucible server as the renderer sees it: everything but the token. */
export interface ServerView {
  readonly name: string;
  readonly url: string;
  readonly hasToken: boolean;
  readonly active: boolean;
}

/** Add or edit a server by hand. On an edit, `token: null` keeps the stored one. */
export interface ServerInput {
  readonly name: string;
  readonly url: string;
  readonly token: string | null;
}

/** What `GET /v1/info` said about a server, for the connection test. */
export interface ServerProbe {
  readonly name: string;
  readonly version: string;
  readonly backend: string;
  /** Whether the server offers the `audio` job type at all. */
  readonly audio: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// The song page (from GET /v1/playground)
// ─────────────────────────────────────────────────────────────────────────────

/** One conflict rule as the server states it: the other tag, and why. */
export interface TagConflict {
  readonly tag: string;
  readonly why: string;
}

/** A group of suggested style tags, as the server lists them. */
export interface TagGroup {
  readonly group: string;
  readonly tags: readonly string[];
}

/** A number field's limits, as the server's page states them. */
export interface NumberField {
  readonly default: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly step: number | null;
  readonly hint: string | null;
}

/**
 * The parts of the server's `yue2-3b` playground page B-Side draws. The tag
 * vocabulary, the conflict map and the cfg limits are the server's, read every
 * time the page is opened: B-Side keeps no copy of any of them.
 */
export interface SongPage {
  readonly model: string;
  readonly name: string;
  /** `ready`, `download` (its first job installs what it lacks) or `unavailable`. */
  readonly standing: string;
  readonly available: boolean;
  readonly reason: string | null;
  readonly downloadBytes: number | null;
  readonly tagsPlaceholder: string | null;
  readonly tagsHint: string | null;
  readonly suggestions: readonly TagGroup[];
  /** Lower-cased tag -> the tags it contradicts. */
  readonly conflicts: Readonly<Record<string, readonly TagConflict[]>>;
  readonly lyricsPlaceholder: string | null;
  readonly lyricsHint: string | null;
  /** Whether this server's YuE2 takes `instrumental`. */
  readonly instrumental: boolean;
  readonly cfg: NumberField | null;
  readonly seed: NumberField | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Params and presets
// ─────────────────────────────────────────────────────────────────────────────

/** The form's own fields: what a preset keeps. Never a seed. */
export interface SongForm {
  readonly tags: string;
  readonly lyrics: string;
  readonly instrumental: boolean;
  readonly cfg: number | null;
}

/** What one job sends as `params`: the form plus the seed, both as the server spells them. */
export interface SongParams {
  readonly tags?: string;
  readonly lyrics?: string;
  readonly instrumental?: boolean;
  readonly cfg?: number;
  readonly seed?: number;
}

/** A preset as the server stores it. `params` is whatever was saved, possibly by the web playground. */
export interface Preset {
  readonly name: string;
  readonly params: Readonly<Record<string, string | number | boolean>>;
  readonly savedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Jobs
// ─────────────────────────────────────────────────────────────────────────────

export type JobPhase =
  | 'submitting'
  | 'installing'
  | 'queued'
  | 'running'
  | 'fetching'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'removed'
  | 'refused';

export const ENDED_PHASES: readonly JobPhase[] = ['done', 'failed', 'cancelled', 'removed', 'refused'];

/** A first-use install the server started for a refused job (409 `installing`). */
export interface InstallView {
  /** False when another client's install is the one running (`task_busy`): not ours to cancel. */
  readonly ours: boolean;
  readonly step: { readonly name: string; readonly index: number; readonly total: number } | null;
  readonly bytesDone: number | null;
  readonly bytesTotal: number | null;
  readonly line: string | null;
}

/** One generation, as main follows it. */
export interface JobView {
  /** B-Side's own id for the row, stable before the server has given one. */
  readonly key: string;
  readonly number: number;
  /** Place in its batch, 1-based, and the batch size. */
  readonly index: number;
  readonly batch: number;
  readonly server: string;
  readonly jobId: string | null;
  readonly phase: JobPhase;
  readonly position: number | null;
  readonly of: number | null;
  readonly fraction: number | null;
  readonly message: string | null;
  readonly install: InstallView | null;
  readonly refusal: RefusalView | null;
  readonly params: SongParams;
  /** The seed the server reported, else the one sent, else null. */
  readonly seed: number | null;
  /** Once done: the library song it became. */
  readonly songId: string | null;
  /** Epoch ms. */
  readonly since: number;
  readonly ended: number | null;
}

export interface GenerateRequest {
  readonly params: SongParams;
  /** How many in a row; with a seed they get seed, seed+1, ... */
  readonly count: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Library
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One finished song on disk: `<id>.flac` (or `.wav`) beside `<id>.json`, the
 * sidecar this describes. `album` is the seam for album and cover-art work,
 * which is a later phase: it is written as null and nothing reads it yet.
 */
export interface Song {
  readonly id: string;
  readonly title: string;
  /** The audio file's name inside the library folder. */
  readonly file: string;
  readonly model: string;
  readonly params: {
    readonly tags: string | null;
    readonly lyrics: string | null;
    readonly instrumental: boolean;
    readonly cfg: number | null;
    readonly seed: number | null;
  };
  readonly server: { readonly name: string; readonly url: string };
  readonly jobId: string;
  readonly createdAt: string;
  readonly durationS: number | null;
  readonly batch: { readonly index: number; readonly of: number } | null;
  readonly album: string | null;
}

export interface LibraryView {
  readonly dir: string;
  readonly songs: readonly Song[];
  /** Sidecars that could not be read, each with why: shown, never deleted. */
  readonly problems: readonly string[];
}

export interface AppSettingsView {
  readonly libraryDir: string;
  readonly defaultLibraryDir: string;
}

/** The URL scheme main serves library audio on (range requests, so the scrubber seeks). */
export const SONG_SCHEME = 'bside-song';

export function songUrl(song: Song): string {
  return `${SONG_SCHEME}://library/${encodeURIComponent(song.file)}`;
}
