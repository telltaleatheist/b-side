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
export const TAG_MODELS = ['qwen3.5-4b', 'qwen3.5-4b-8bit'] as const;

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

/**
 * What B-Sides asked a server for beyond YuE2 (the vocal separator, shared/core/server-needs.ts;
 * Owen, 2026-10-11), and where that got to. `GET /api/server-needs`: the active server's, or null.
 */
export interface ServerNeedsView {
  readonly server: string;
  /** checking: reading the server; installing: its module task runs; not-here: its engine has no separator. */
  readonly state: 'checking' | 'installing' | 'ready' | 'not-here' | 'failed';
  /** The sentence to show, as it is. */
  readonly sentence: string;
  /** The Crucible task installing it, when one was posted. */
  readonly task: string | null;
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
  /**
   * Whether a length can be aimed for here: B-Sides sizes an instrumental's planning lyrics itself
   * (shared/planning-sets.ts, 2026-10-11), so any YuE2 that makes instrumentals (and with them takes
   * `planning_lyrics`, Crucible 1.0.93) can. A sung song only notes the aim.
   */
  readonly length?: boolean;
  readonly cfg: NumberField | null;
  readonly seed: NumberField | null;
  /**
   * Whether this server's YuE2 takes `negative_tags` and `negative_lyrics` (Crucible, 2026-10-12):
   * the guidance branch an instrumental is pushed away from (shared/negative.ts). Absent: no.
   */
  readonly negative?: boolean;
  /**
   * Whether this server's YuE2 takes `key`, `meter` and `bpm` (Crucible 2.0.13): the score's header
   * forced from what the tags state (shared/header.ts). Absent: no.
   */
  readonly header?: boolean;
  /** The tag and lyrics model this server gets (chooseTagModel), or null when it can hold none of them. */
  readonly tagModel: string | null;
  /** Why there is no tag model on this server, in a sentence; null when there is one. */
  readonly tagModelReason: string | null;
  /** Who writes on this hub when not the tag model (Settings → Writing: Claude); set by the hub. */
  readonly writer?: string;
  /** Who writes the lyrics when not the writer (Settings → Lyrics: Claude); set by the hub. */
  readonly lyricist?: string;
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
  /** Who or what carries the melody (Owen, 2026-10-11): a preset keeps it as its own param, `lead`; absent when blank. */
  readonly lead?: string;
}

/** What one job sends as `params`: the form plus the seed, both as the server spells them. */
export interface SongParams {
  readonly tags?: string;
  /**
   * The lead (Owen, 2026-10-11): the singer, or the instrument carrying an instrumental's melody.
   * B-Sides' own: the hub puts it in the tags (styleLine) and never sends it to Crucible. Absent or
   * blank: the tags' own lead.
   */
  readonly lead?: string;
  readonly lyrics?: string;
  readonly instrumental?: boolean;
  readonly cfg?: number;
  readonly seed?: number;
  /**
   * The length to aim for, in seconds. B-Sides' own since 2026-10-11 (Crucible serves models; the
   * app sizes): an instrumental's planning set is sized toward it (shared/planning-sets.ts), a sung
   * song only notes it. Never sent: Crucible's own range only sized its pool sets and recorded the
   * rest, and the library works out whether a song landed from the score's length itself.
   */
  readonly min_duration_s?: number;
  readonly max_duration_s?: number;
  /**
   * An instrumental's structure: the id of the planning set (PLANNING_SETS) B-Sides plans it from
   * and sends as `planning_lyrics`, sized to the aim. Settled before it is sent: an album's tracks
   * take the sets in turn, a song on its own the seed's (2026-10-11). Absent when sung.
   */
  readonly planning_set?: string;
  /**
   * A listening test's exact request (Owen, 2026-10-11: what stops an instrumental's voice): `tags`
   * sent as written, not through styleLine; `lyrics` sent as an instrumental's lyrics (section tags
   * only, YuE2's own empty-lyrics path) in place of planning lyrics. Never set by the app's pages.
   */
  readonly experiment?: { readonly tags?: string; readonly lyrics?: string };
}

/**
 * The song lengths to aim for (Victoria, 2026-10-10: "a slider ... between 3 and 5 minutes"; Owen:
 * "if its close, thats good enough"). B-Sides sizes an instrumental's planning set toward it, for one pass; a
 * sung song runs as long as its lyrics, which are never cut or padded for it.
 */
export interface LengthAim {
  readonly key: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
}
export const LENGTH_AIMS: readonly LengthAim[] = [
  { key: '1-2', label: '1–2 min', min: 60, max: 120 },
  { key: '2-3', label: '2–3 min', min: 120, max: 180 },
  { key: '3-5', label: '3–5 min', min: 180, max: 300 },
  { key: '5-6', label: '5–6 min', min: 300, max: 360 },
];

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
  /**
   * Who writes the sound (split-text.ts): a song's tags, an album's core and each track's turn,
   * and the cover description. `bside`: the server's chat model; `claude`: Claude Code on this
   * computer (desktop only). (Owen, 2026-10-11: "a vanilla 4b model should generate the tags".)
   */
  readonly writer: 'bside' | 'claude';
  /**
   * Who writes the words: everything a person reads or hears (lyrics, song and album names, the
   * artist, the liner note, track titles). `claude` on a desktop; the server's model otherwise.
   */
  readonly lyricist: 'bside' | 'claude';
  /** 2: the choices above mean sound and words (0.1.38); before that, `writer` wrote names too. */
  readonly textSplit?: number;
  /**
   * How albums on the same server share it (Victoria, 2026-10-11: "In some cases, it's nice to
   * complete an entire album before moving on to the next. In other cases, I want to flip back and
   * forth between albums"): `one` finishes each album before the next begins; `turns` sends a track
   * from each in turn, so they grow together. Absent in a file from before: `one`.
   */
  readonly albumOrder?: AlbumOrder;
  /**
   * Where a song made on its own goes in the server's line (Victoria, 2026-10-11: "back and forth
   * between generating an album and an individual song"): `turn` waits behind the album tracks
   * already sent (at most two); `next` goes ahead of album tracks still waiting (albums keep only
   * one track on the server, and send none while a song is waiting). Absent in a file from before: `turn`.
   */
  readonly singles?: SinglesOrder;
}

export type AlbumOrder = 'one' | 'turns';
export const ALBUM_ORDERS: readonly AlbumOrder[] = ['one', 'turns'];
export type SinglesOrder = 'next' | 'turn';
export const SINGLES_ORDERS: readonly SinglesOrder[] = ['next', 'turn'];

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
  /** The name the writer gave a song asked for on its own (GenerateRequest.title). */
  readonly title?: string | null;
  /** Once filed into `playlist`: the song it became. */
  readonly songId?: string | null;
  /** An instrumental version of a library song (Owen, 2026-10-11; shared/core/strip.ts); absent: a render. */
  readonly strip?: StripView | null;
  /**
   * The model it is sent to: always SONG_MODEL. 1.0.29 to 1.0.31 sent instrumentals to Crucible's
   * yue2-3b-instrumental (an instrumental adapter); Owen, 2026-10-12, after listening, it sang
   * forbidden words where the base model only hummed: "go back to base for everything".
   */
  readonly model?: string;
  /**
   * An instrumental's renders so far, each metered for voice (Owen, 2026-10-12: "render a song, do
   * vocal sep, and if there are vocals, throw it away and re-render up to twice"; shared/core/jobs.ts
   * VOICE_TRIES). Kept on the server, held, until one lands. Absent: not metered.
   */
  readonly tries?: readonly VoiceTry[];
}

/** One render of an instrumental and the voice the separator found in it. */
export interface VoiceTry {
  readonly jobId: string;
  readonly artifact: string;
  readonly seed: number;
  readonly durationS: number | null;
  readonly effective: unknown;
  /** Seconds of its vocal stem at or above VOICED_DBFS. */
  readonly voiceS: number;
}

/**
 * A library song made into an instrumental version (Owen, 2026-10-11): put through Crucible's
 * separator and kept as its instrumental stem. Renders are never stripped (Owen, 2026-10-12: the
 * separator damages YuE2's audio).
 */
export interface StripView {
  /** The separator runs (from the start: nothing is rendered). */
  readonly state: 'stripping';
  /** The format the stem is asked in: the person's song format then. */
  readonly format: SongFormat;
  /** The denoise job, once sent. */
  readonly jobId: string | null;
  /** The library song it is made from. */
  readonly of?: string | null;
}

/** Whether instrumental versions can be made on the active server now, and why not (`GET /api/strip`). */
export interface StripAbility {
  readonly can: boolean;
  /** The sentence to show beside a disabled button; null when it can. */
  readonly why: string | null;
}

/** " (Instrumental)": the playlist an instrumental version of a song or playlist is filed into. */
export const INSTRUMENTAL_SUFFIX = ' (Instrumental)';

/** What "describe the music" answers: tags for the chips, and whether it asked for no vocals. */
export interface DescribeResult {
  readonly tags: readonly string[];
  readonly instrumental: boolean;
  /**
   * Who or what carries the melody, also among `tags` (Owen, 2026-10-11): the singer, or for an
   * instrumental its instrument as "<instrument> melody". Absent when the writer named none.
   */
  readonly lead?: string;
  /** The song's words, written with the tags when it is sung; null when instrumental. */
  readonly lyrics: string | null;
  /** Clashes the tags hold, by the server's conflict map, each with why: shown, never dropped. */
  readonly clashes: readonly string[];
  readonly model: string;
  /** Who wrote the lyrics when not `model` (Claude, the stand-in lyricist). */
  readonly lyricsModel?: string;
  /** The song's name, when the writer names songs (Claude; B-Sides' model from v3). */
  readonly title?: string | null;
  readonly seconds: number;
}

export interface GenerateRequest {
  readonly params: SongParams;
  /** How many in a row; with a seed they get seed, seed+1, ... */
  readonly count: number;
  /** The name the writer gave it when it described the song; without one, titles.ts names it. */
  readonly title?: string;
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
  /** The planning set B-Sides planned an instrumental from (SongParams.planning_set); absent when sung, and on songs made before 2026-10-11. */
  readonly planning_set?: string;
  /** The length it aimed for (SongParams), kept by B-Sides since 2026-10-11; before, only the server's record (`length`) had it. */
  readonly min_duration_s?: number;
  readonly max_duration_s?: number;
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
  /** Kept as the separator's instrumental stem (Owen, 2026-10-11); absent on songs made as rendered. */
  readonly stripped?: boolean;
  /** The denoise job its stem came from, when stripped. */
  readonly stripJob?: string;
  /** Why a strip it went through failed (it was kept as rendered): songs of 1.0.17-1.0.29, when renders were stripped. */
  readonly stripFailed?: string;
  /** An instrumental version: the library song it was made from. */
  readonly instrumentalOf?: string;
  /**
   * An instrumental metered for voice (1.0.38): the seconds of voice the separator found in the
   * render kept (the audio itself is never stripped), and how many renders it took (1-3).
   */
  readonly voiceS?: number;
  readonly renders?: number;
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
  /**
   * An instrumental's structure: the planning set YuE2 scored it from (e.g. "tidewater"), shown so a
   * report can name it (crucible-pc-1, 2026-10-10). B-Sides' own pick (SongMade.planning_set), or on
   * older songs the server's (`planning_lyrics.id`). Absent when sung.
   */
  readonly structure?: string | null;
  /** The length it aimed for, and whether its score landed in it (null: not told). */
  readonly aim?: { readonly min: number | null; readonly max: number | null; readonly inRange: boolean | null } | null;
}

/** A named playlist: library song ids in play order. */
export interface Playlist {
  readonly id: string;
  readonly name: string;
  readonly songs: readonly string[];
  readonly createdAt: string;
  /** Set when B-Sides made this playlist as an album (Make → Album). */
  readonly album?: AlbumMeta;
  /** The folder it is filed in (Folder.id); absent or null: the top of the library. */
  readonly folder?: string | null;
  /**
   * A plain playlist's own cover file (an album's is album.cover): "<album> (Instrumental)" wears
   * a copy of its album's (Owen, 2026-10-11). Absent: the standard cover.
   */
  readonly cover?: string;
}

/** The cover file a playlist or album wears; null for the standard one. */
export function coverOf(playlist: Pick<Playlist, 'album' | 'cover'>): string | null {
  return playlist.album?.cover ?? playlist.cover ?? null;
}

/**
 * A named folder of albums and playlists (Victoria, 2026-10-11: "group the Greek Myth Series
 * together in one section while retaining each individual album, almost like a directory
 * structure"). It only groups: what is in it stays whole, and deleting it moves its contents up a
 * level. Folders nest (at most FOLDER_DEPTH deep). Siblings keep the library's order: a folder's
 * place among its sibling folders is its place in `LibraryView.folders`, a playlist's among the
 * playlists beside it is its place in `playlists`; at each level the folders come first.
 */
export interface Folder {
  readonly id: string;
  readonly name: string;
  /** The folder it is in; null: the top of the library. */
  readonly parent: string | null;
  readonly createdAt: string;
}

/** How deep folders nest: a folder in a folder in a folder in a folder, and no deeper. */
export const FOLDER_DEPTH = 4;

/** One track of an album's plan, as the chat model wrote it. */
export interface AlbumTrack {
  readonly title: string;
  /** The album's tags with this track's own turn (tempo, mood, one instrument), its lead first. */
  readonly tags: string;
  /**
   * Who or what carries its melody (Owen, 2026-10-11): the person's lead, else the one [turns] wrote;
   * also in `tags`, so a remake keeps it. Absent on older plans and when none was given or written.
   */
  readonly lead?: string;
  /** Sung albums: the lyrics, in YuE's section tags. Null when instrumental. */
  readonly lyrics: string | null;
  /** What the song is about, in a sentence, from the lyricist (split-text.ts [ideas]); absent on older plans. */
  readonly idea?: string;
  /** A planned track's brief, in the person's words (AlbumAsk.plan); its lyrics are written to it. */
  readonly brief?: string;
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
  /** The album ahead of it on its server, while it waits its turn to make its music. Filled in when sent, never stored. */
  readonly waitingFor?: string | null;
  /** Taking turns with other albums on its server (Settings: Take turns). Filled in when sent, never stored. */
  readonly takingTurns?: boolean;
  /** When a track of it was last sent to the server: taking turns, the album sent to longest ago goes next. */
  readonly lastSentAt?: string | null;
  /** When the person chose Make this next: it goes ahead of the other albums on its server (Victoria, 2026-10-11). */
  readonly nextAt?: string | null;
  /** How many tracks were sent before the plan existed (the openers); absent until they are. */
  readonly openers?: number;
  /** Seconds of music made so far. */
  readonly madeS: number;
  /** Why it stopped, when it failed. */
  readonly refusal: RefusalView | null;
  /** Which server makes it, and which chat model wrote it. */
  readonly server: string;
  readonly writer: string | null;
  /** Who wrote the sound (the tags, the cover description) when not the writer (split-text.ts). */
  readonly soundBy?: string | null;
  /** Who wrote the lyrics when not the writer (Claude, the stand-in lyricist). */
  readonly lyricsBy?: string | null;
  /** Once saved to a B-Sides computer (the phone's cloud): which, and when. Absent while it lives only here. */
  readonly cloud?: { readonly host: string; readonly at: string } | null;
  /** What the maker is doing before the tracks (planning, writing lyrics), for the progress line; null once making. */
  readonly step?: AlbumStep | null;
  /** The id of the Crucible queue session writing it, while one is open (closed on the next start if a crash left it). */
  readonly session?: string | null;
  /** The cover: being painted, or why there is none. Absent before the painting starts. */
  readonly coverState?: 'painting' | 'failed' | 'no_model' | null;
  /**
   * The server's job painting the cover now, kept so a restart waits for that one rather than
   * painting again (Victoria's Odyssey, 2026-10-11: painted by one run, never saved by the next).
   */
  readonly coverJob?: string | null;
  /**
   * Made tracks being made again (Victoria, 2026-10-11: "reroll" one song, such as A Thousand
   * Ships, whose chorus did not fit the melody). Each stays the old take until the new one lands
   * and takes its place; one that fails leaves the old take.
   */
  readonly remakes?: readonly AlbumRemake[];
  /**
   * Set while a finished, stopped or failed album makes only its remakes: the stage it goes back
   * to once they land, so it never goes on to make tracks it did not set out to.
   */
  readonly remakeOnly?: AlbumStage | null;
  /** The last remake that failed, said on the album's page until the next one is asked for. */
  readonly remakeRefusal?: RefusalView | null;
}

/** A made track being made again: its plan place, its take now, and the words the new take sings. */
export interface AlbumRemake {
  readonly at: number;
  /** The song the new take replaces (its library id); null when it could not be found. */
  readonly song: string | null;
  /** The words to sing: new ones, or the old take's own (corrected by hand, perhaps); null when instrumental. */
  readonly lyrics: string | null;
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

/**
 * How many lines a lyricist writes a song (Owen, 2026-10-12: "very short (4 lines?), short (8
 * lines?), normal (chorus, verses, the normal amount of lyrics), long"). Normal is the shapes as
 * they were (lyricist.ts SONG_SHAPES). Words the person gives are never touched by it.
 */
export type LyricsLength = 'very-short' | 'short' | 'normal' | 'long';
export const LYRICS_LENGTHS: readonly { readonly key: LyricsLength; readonly label: string; readonly hint: string }[] = [
  { key: 'very-short', label: 'Very short', hint: '4 lines in all: one verse, nothing else.' },
  { key: 'short', label: 'Short', hint: '8 lines: a verse and a chorus.' },
  { key: 'normal', label: 'Normal', hint: 'Verses, choruses and a bridge, the shape changing from track to track.' },
  { key: 'long', label: 'Long', hint: '8-line verses, and a verse and chorus more than normal.' },
];
export function lyricsLengthOf(value: unknown): LyricsLength | null {
  return LYRICS_LENGTHS.some((length) => length.key === value) ? value as LyricsLength : null;
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
  /** The length every track aims for (LENGTH_AIMS' key); absent: the server's own. */
  readonly trackLength?: string;
  /**
   * Every track keeps exactly the album's own tags, and no track adds a voice, an instrument
   * or a genre of its own (only a tempo, when the tags set none). Off, or absent: each track
   * varies on them (Victoria, 2026-10-10: "stick exactly to [the] tags" or "stick to the
   * general vibe of the tags with variations"; Owen agreed).
   */
  /** The name the person gave it in Make (Victoria, 2026-10-11): kept, and the words written to it. */
  readonly title?: string;
  /** Sung: its lyrics may have a pre-chorus (Make's checkbox, Owen 2026-10-11); YuE2 often drops one. */
  readonly preChorus?: boolean;
  /** Sung: names and rare words written as they sound (Make's "Pronounce phonetically", Owen 2026-10-11). */
  readonly phonetic?: boolean;
  /** Sung: how many lines the lyricist writes a track (Make's "Lyrics length", Owen 2026-10-12); absent: normal. */
  readonly lyricsLength?: LyricsLength;
  readonly exactTags?: boolean;
  /**
   * Make's Lead (Owen, 2026-10-11): every track's lead, the singer or the instrument carrying the
   * melody. Absent: each track's own, from [turns] (none added with exactTags).
   */
  readonly lead?: string;
  /**
   * Sung in the person's own words (Owen, 2026-10-11, for Victoria's poems): a track for each, in
   * order, sung exactly as given (own-words.ts). No lyricist and no fix-up; a track with no name
   * of its own is named for its words. The album's length is these tracks, not `minutes`.
   */
  readonly ownWords?: readonly { readonly title: string | null; readonly lyrics: string }[];
  /**
   * Make → Album's "I want to plan it" (Victoria, 2026-10-12; Owen approved): the person picks how
   * many songs and goes song by song. A track with lyrics is sung exactly as given (as ownWords);
   * one with a brief, or with nothing, is written by the lyricist as in a generated album. Its
   * length is these tracks, not `minutes`. `exactTags` is set with tagMode 'exact', as before.
   */
  readonly plan?: AlbumTrackPlan;
}

/**
 * How a planned album's tracks take the tags, in Victoria's words (2026-10-12): "keep the general
 * vibe of the album tags" (each varies on them), "stick exactly to the tags", or "set tags for
 * each song" (each track's own, for an album with one instrument a song or a world tour).
 */
export type AlbumTagMode = 'vibe' | 'exact' | 'per-song';
export const ALBUM_TAG_MODES: readonly AlbumTagMode[] = ['vibe', 'exact', 'per-song'];

/** A planned album: its tag mode and its tracks, in order. */
export interface AlbumTrackPlan {
  readonly tagMode: AlbumTagMode;
  readonly tracks: readonly PlannedTrack[];
}

/** One track the person planned; anything left out is written for them. */
export interface PlannedTrack {
  /** Its name; absent, it is named as a generated track is. */
  readonly title?: string;
  /** Sung exactly as written: no lyricist, no fix-up (sung albums only). */
  readonly lyrics?: string;
  /** What it is about, in a line, for the lyricist (or, instrumental, for its sound). */
  readonly brief?: string;
  /** Its own tags, with tagMode 'per-song'; absent there, the album's. */
  readonly tags?: readonly string[];
  /**
   * Sung or instrumental, track by track (Victoria, 2026-10-12: "Per track"); absent, the album's
   * `sung`, which is only the default for new tracks. An instrumental track has no lyrics.
   */
  readonly sung?: boolean;
  /** Its own lead (Victoria: "Album lead by default, changeable per track"); absent, the album's, else the writer's. */
  readonly lead?: string;
}

/**
 * A planned album saved by name to start the next one from (Victoria, 2026-10-12: a series of poems
 * albums), kept by the hub in templates.json so the phone and the desktop see the same ones.
 */
export interface AlbumTemplate {
  readonly name: string;
  readonly savedAt: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly lead: string;
  /** The default for new tracks. */
  readonly sung: boolean;
  readonly plan: AlbumTrackPlan;
}

/** A template as listed: enough to pick one, not its words. */
export interface AlbumTemplateSummary {
  readonly name: string;
  readonly savedAt: string;
  readonly tracks: number;
}

/** The most tracks a planned album takes (as many as an album in your own words). */
export const PLAN_TRACKS_MAX = 45;

/**
 * The longest description B-Sides takes, for a song or an album. Too long is refused by name, never
 * cut (Victoria, 2026-10-11: at 600 her album's instructions were cut mid-word, unseen).
 */
export const DESCRIPTION_MAX = 2000;

/** The lengths an album can be (15 minutes: a few songs, Owen 2026-10-10). */
export const ALBUM_MINUTES: readonly number[] = [15, 30, 60, 90];

export interface LibraryView {
  readonly dir: string;
  readonly songs: readonly Song[];
  readonly playlists: readonly Playlist[];
  /** The folders, in their order; absent from a B-Sides before folders (none). */
  readonly folders?: readonly Folder[];
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

/**
 * Another B-Sides that added this one and offers its own library back (Victoria,
 * 2026-10-11: adding someone should share back). Kept by the hub until this
 * computer adds it or says no.
 */
export interface PeerIntroduction {
  /** Where it answers, as this hub saw it: `http://<its address>:<its port>`. */
  readonly url: string;
  readonly hostname: string;
  /** What it calls itself, when it said. */
  readonly name: string | null;
  /** Its key, when it requires one. */
  readonly key: string;
  readonly at: string;
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
  /** Album tracks on a server now, every album's: for each track's bar on its album page. */
  readonly albumJobs?: readonly JobView[];
}

/** What the hub pushes on `GET /api/events`. */
export type HubEvent =
  | { readonly type: 'snapshot'; readonly snapshot: HubSnapshot }
  | { readonly type: 'job'; readonly job: JobView }
  /** An album track's progress, to every device (Victoria, 2026-10-10: a bar "under each individual song"). */
  | { readonly type: 'album-job'; readonly job: JobView }
  | { readonly type: 'take'; readonly take: Take }
  | { readonly type: 'take-gone'; readonly id: string; readonly reason: TakeGoneReason }
  | { readonly type: 'library'; readonly library: LibraryView }
  | { readonly type: 'servers'; readonly servers: readonly ServerView[] };

/** The header (or `key` query parameter) every `/api` request carries. */
export const HUB_KEY_HEADER = 'X-BSide-Key';

/** The hub's port unless settings say otherwise. */
export const DEFAULT_HUB_PORT = 7300;
