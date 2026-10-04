/**
 * types — the shapes the hub's API speaks, compiled by both programs.
 *
 * Main (the hub) owns every Crucible call, the take cache, the library on disk
 * and the server registry; every client only ever sees these views. A server's
 * TOKEN never crosses: a view carries `hasToken` where the stored entry carries
 * the secret.
 */

/** The one model B-Side makes songs with. */
export const SONG_MODEL = 'yue2-3b';

/** The chat model that turns a description into style tags (electron/describe.ts). Small on purpose. */
export const TAG_MODEL = 'qwen3.5-4b';

/** A refusal or failure, in the server's own words where it gave some. */
export interface RefusalView {
  /** The server's named code (`audio_param_missing`, ...) or one of ours (`unreachable`, `no_server`). */
  readonly code: string;
  readonly message: string;
}

/** Every hub call answers with this, so a refusal reaches the screen with its code intact. */
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
  /** The hub client that asked for it: the playing list its take joins. */
  readonly client: string;
  readonly clientKind: ClientKind;
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
  /** Once done: the take it became (in its client's playing list). */
  readonly takeId: string | null;
  /** Epoch ms. */
  readonly since: number;
  readonly ended: number | null;
}

/** What "describe the music" answers: tags for the chips, and whether it asked for no vocals. */
export interface DescribeResult {
  readonly tags: readonly string[];
  readonly instrumental: boolean;
  /** Clashes the tags hold, by the server's conflict map, each with why: shown, never dropped. */
  readonly clashes: readonly string[];
  readonly model: string;
  readonly seconds: number;
}

export interface GenerateRequest {
  readonly params: SongParams;
  /** How many in a row; with a seed they get seed, seed+1, ... */
  readonly count: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Songs: takes (the playing list) and the library (playlists)
// ─────────────────────────────────────────────────────────────────────────────

/** The params a finished song was made with, as recorded beside it. */
export interface SongMade {
  readonly tags: string | null;
  readonly lyrics: string | null;
  readonly instrumental: boolean;
  readonly cfg: number | null;
  readonly seed: number | null;
}

/** What a take and a saved song both say about themselves. */
export interface SongFacts {
  readonly id: string;
  readonly title: string;
  /** The audio file's name inside its folder (the take cache or the library). */
  readonly file: string;
  readonly model: string;
  readonly params: SongMade;
  readonly server: { readonly name: string; readonly url: string };
  readonly jobId: string;
  readonly createdAt: string;
  readonly durationS: number | null;
  readonly batch: { readonly index: number; readonly of: number } | null;
}

/**
 * A generated song nobody has saved: one entry in its client's playing list,
 * kept in the hub's take cache until the FIFO budget clears it.
 */
export interface Take extends SongFacts {
  readonly client: string;
  readonly bytes: number;
  /** The library song it was saved as, once it has been saved to a playlist. */
  readonly savedAs: string | null;
}

/**
 * One saved song in the library folder: `<id>.flac` (or `.wav`) beside
 * `<id>.json`. `album` is the seam for album and cover-art work, which is a
 * later phase: it is written as null and nothing reads it yet.
 */
export interface Song extends SongFacts {
  readonly album: string | null;
}

/** A named playlist: library song ids in play order. */
export interface Playlist {
  readonly id: string;
  readonly name: string;
  readonly songs: readonly string[];
  readonly createdAt: string;
}

export interface LibraryView {
  readonly dir: string;
  readonly songs: readonly Song[];
  readonly playlists: readonly Playlist[];
  /** Sidecars that could not be read, each with why: shown, never deleted. */
  readonly problems: readonly string[];
}

/** Why a take left a playing list without being removed by hand. */
export type TakeGoneReason = 'removed' | 'client_cap' | 'disk_budget' | 'client_closed';

// ─────────────────────────────────────────────────────────────────────────────
// The hub
// ─────────────────────────────────────────────────────────────────────────────

export type ClientKind = 'desktop' | 'web' | 'ios';
export const CLIENT_KINDS: readonly ClientKind[] = ['desktop', 'web', 'ios'];

/** How many takes each kind of client keeps before its oldest is cleared. */
export const TAKES_PER_CLIENT: Readonly<Record<ClientKind, number>> = { desktop: 200, ios: 60, web: 40 };

/** All takes together, on the hub's disk, before the oldest is cleared. */
export const TAKE_CACHE_BYTES = 4 * 1024 ** 3;

/** How long a web client's takes outlive its last connection (a reload, a blip). */
export const WEB_GRACE_MS = 10 * 60 * 1000;

export interface HubSettingsView {
  readonly libraryDir: string;
  readonly defaultLibraryDir: string;
  /** Whether the hub listens beyond this computer. */
  readonly sharing: boolean;
  readonly port: number;
  /** Links that open the hub, key included: one per network address (only when sharing). */
  readonly links: readonly string[];
  /** Whether the caller is this computer (only it may change sharing or the key). */
  readonly local: boolean;
}

export interface HubInfo {
  readonly app: 'b-side';
  readonly version: string;
  readonly hostname: string;
}

/** Everything a client needs on (re)connect: the SSE stream's first event. */
export interface HubSnapshot {
  readonly hub: HubInfo;
  readonly servers: readonly ServerView[];
  readonly jobs: readonly JobView[];
  readonly takes: readonly Take[];
  readonly library: LibraryView;
}

/** What the hub pushes on `GET /api/events`. */
export type HubEvent =
  | { readonly type: 'snapshot'; readonly snapshot: HubSnapshot }
  | { readonly type: 'job'; readonly job: JobView }
  | { readonly type: 'take'; readonly take: Take }
  | { readonly type: 'take-gone'; readonly id: string; readonly reason: TakeGoneReason }
  | { readonly type: 'library'; readonly library: LibraryView }
  | { readonly type: 'servers'; readonly servers: readonly ServerView[] };

/** The header (or `key` query parameter) every `/api` request carries. */
export const HUB_KEY_HEADER = 'X-BSide-Key';

/** The hub's port unless settings say otherwise. */
export const DEFAULT_HUB_PORT = 7300;
