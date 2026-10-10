/**
 * types — the shapes the hub's API speaks, compiled by both programs.
 *
 * Main (the hub) owns every Crucible call, the take cache, the library on disk
 * and the server registry; every client only ever sees these views. A server's
 * TOKEN never crosses: a view carries `hasToken` where the stored entry carries
 * the secret.
 */

/** The one model B-Sides makes songs with. */
export const SONG_MODEL = 'yue2-3b';

/**
 * The chat models that turn a description into style tags and lyrics (shared/core/describe.ts),
 * best first: qwen3.5-4b fine-tuned on B-Sides' own describe answers (training/lyrics). Since
 * Crucible 1.0.124 one id serves every card: a Q8_0 GGUF on llama.cpp on a PC (~5.4-5.9 GB, so it
 * fits an 8 GiB card whole and loads in seconds), bf16 MLX on a Mac. The 4-bit vLLM build it
 * replaced is gone from the catalog. chooseTagModel (shared/core/crucible.ts) still says when a
 * server's card cannot hold it.
 */
export const TAG_MODELS = ['qwen3.5-4b-bside'] as const;

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

/**
 * Adding a server by its address: the server's own name and the short code it
 * shows (a server that asks for approval shows the same code on its console).
 * The request's device code and, once approved, the token stay in the hub.
 */
export interface PairingProgress {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly userCode: string;
  /** False on a server with open pairing (the default): the first poll approves. */
  readonly approvalRequired: boolean;
  /** Epoch ms. */
  readonly expiresAt: number;
  readonly pollAfterMs: number;
  readonly status: 'pending' | 'approved' | 'denied' | 'expired';
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
 * The parts of the server's `yue2-3b` playground page B-Sides draws. The tag
 * vocabulary, the conflict map and the cfg limits are the server's, read every
 * time the page is opened: B-Sides keeps no copy of any of them.
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
  /** The tag and lyrics model this server gets (chooseTagModel), or null when it can hold none of them. */
  readonly tagModel: string | null;
  /** Why there is no tag model on this server, in a sentence; null when there is one. */
  readonly tagModelReason: string | null;
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

/**
 * How songs are kept. MP3 (192 kbps, rendered by Crucible) is about an eighth
 * the size of FLAC and sounds the same on phones and earbuds; FLAC is lossless.
 * WAV is not offered: the same sound as FLAC, bigger.
 */
export type SongFormat = 'mp3' | 'flac';
export const SONG_FORMATS: readonly SongFormat[] = ['mp3', 'flac'];

/** A hub's own choices, kept beside its takes (each hub has its own: the desktop's, the phone's). */
export interface HubPreferences {
  readonly songFormat: SongFormat;
  /** The playlist every song made on its own is filed into ("New Songs"); made when first needed. */
  readonly singlesPlaylist?: string | null;
  /** The phone's own hub: how much its albums may take before a new one waits (GB). */
  readonly albumSpaceGb: number;
}

/**
 * The playlist every song made on its own is filed into, as an album's tracks
 * are filed into the album (Owen, 2026-10-07). One already named so is adopted.
 */
export const SINGLES_NAME = 'New Songs';

/** The choices for the phone's album space, in GB. */
export const ALBUM_SPACE_GB: readonly number[] = [1, 2, 4, 8];

/** The bytes an album's songs take (songs saved before sizes were kept count as nothing). */
export function albumBytes(playlist: { readonly songs: readonly string[] }, songs: readonly { readonly id: string; readonly bytes: number | null }[]): number {
  const held = new Set(playlist.songs);
  return songs.reduce((sum, song) => (held.has(song.id) ? sum + (song.bytes ?? 0) : sum), 0);
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
  /** B-Sides' own id for the row, stable before the server has given one. */
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
  /** An album's track: which album, and its place in the plan. Null for a song asked for on its own. */
  readonly album: { readonly id: string; readonly track: number } | null;
  /** The playlist a song asked for on its own is filed into when it lands (New Songs). */
  readonly playlist?: string | null;
  /** Once filed into `playlist`: the song it became. */
  readonly songId?: string | null;
}

/** What "describe the music" answers: tags for the chips, and whether it asked for no vocals. */
export interface DescribeResult {
  readonly tags: readonly string[];
  readonly instrumental: boolean;
  /** The song's words, written with the tags when it is sung; null when instrumental. */
  readonly lyrics: string | null;
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
  /** The audio file's size, when it was recorded (songs saved before sizes were kept say null). */
  readonly bytes: number | null;
}

/** A named playlist: library song ids in play order. */
export interface Playlist {
  readonly id: string;
  readonly name: string;
  readonly songs: readonly string[];
  readonly createdAt: string;
  /** Set when B-Sides made this playlist as an album (Make → Album). */
  readonly album?: AlbumMeta;
}

/** One track of an album's plan, as the chat model wrote it. */
export interface AlbumTrack {
  readonly title: string;
  /** The album's tags with this track's own turn (tempo, mood, one instrument). */
  readonly tags: string;
  /** Sung albums: the lyrics, in YuE's section tags. Null when instrumental. */
  readonly lyrics: string | null;
}

/** What the chat model planned in its one call. */
export interface AlbumPlan {
  readonly title: string;
  readonly artist: string;
  /** One line about the record, for its page. */
  readonly blurb: string;
  /** What the image model is asked to paint. */
  readonly coverPrompt: string;
  /** The album's sound: the person's own tags when they gave any, else the writer's. Every track keeps it. */
  readonly core?: string;
  readonly tracks: readonly AlbumTrack[];
  /**
   * How many tracks the plan is being written to (v2 writes them fifteen at a time, so `tracks`
   * may be short of it while it plans). Absent on a plan written in one call before v2: then
   * `tracks` is the whole list.
   */
  readonly trackCount?: number;
}

export type AlbumStage = 'planning' | 'cover' | 'making' | 'done' | 'stopped' | 'failed';

/** An album's details beside its playlist: who, what was asked, how far it has got. */
export interface AlbumMeta {
  readonly artist: string;
  readonly blurb: string;
  /** The painted cover's file name in the library folder, once painted. */
  readonly cover: string | null;
  /** What the person asked for. */
  readonly ask: AlbumAsk;
  readonly plan: AlbumPlan | null;
  readonly stage: AlbumStage;
  /** How many of the plan's tracks have been sent to the server (the next one to send is this index). */
  readonly sent: number;
  /** Tracks before `sent` to send again (lost while the app was closed, or failed): sent before the next new one. */
  readonly redo?: readonly number[];
  /**
   * Whether anything is being done for it right now: writing, or tracks on the server. Filled in
   * when the library is sent, never stored. False while the stage says making: it was interrupted.
   */
  readonly working?: boolean;
  /** How many tracks were sent before the plan existed (the openers); absent until they are. */
  readonly openers?: number;
  /** Seconds of music made so far. */
  readonly madeS: number;
  /** Why it stopped, when it failed. */
  readonly refusal: RefusalView | null;
  /** Which server makes it, and which chat model wrote it. */
  readonly server: string;
  readonly writer: string | null;
  /** Once saved to a B-Sides computer (the phone's cloud): which, and when. Absent while it lives only here. */
  readonly cloud?: { readonly host: string; readonly at: string } | null;
  /** What the maker is doing before the tracks (planning, writing lyrics), for the progress line; null once making. */
  readonly step?: AlbumStep | null;
  /** The id of the Crucible queue session writing it, while one is open (closed on the next start if a crash left it). */
  readonly session?: string | null;
  /** The cover: being painted, or why there is none. Absent before the painting starts. */
  readonly coverState?: 'painting' | 'failed' | 'no_model' | null;
}

/** One step of an album before its tracks: a line to show and, when it counts, how far through. */
export interface AlbumStep {
  /** `install`: the server is installing a model the album needs first (no count: its words say how far). */
  /** `load`: the writer is being put on the card (`detail`: its id); a first load can take minutes. */
  readonly kind: 'openers' | 'install' | 'load' | 'plan' | 'lyrics' | 'cover';
  readonly done: number;
  readonly of: number;
  /** `install`: the server's own words for what it is doing. */
  readonly detail?: string;
}

/** Make → Album: what the person picks. */
export interface AlbumAsk {
  readonly description: string;
  readonly tags: readonly string[];
  readonly minutes: number;
  readonly sung: boolean;
  /** Sung albums: what the lyrics should be about, or their mood and style, in the person's words. */
  readonly lyrics?: string;
  /** Guidance from the form (a preset's), sent with every track; null for the server's default. */
  readonly cfg?: number | null;
}

/** The lengths an album can be. */
export const ALBUM_MINUTES: readonly number[] = [30, 60, 90];

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
  /** Whether devices on the network need the key; off, the address alone connects (as Ollama). */
  readonly requireKey: boolean;
  readonly port: number;
  /** Links that open the hub, one per network address (only when sharing); with the key when it is required. */
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
