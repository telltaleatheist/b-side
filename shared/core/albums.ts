/**
 * albums — Make → Album: one description becomes a whole record (Owen,
 * 2026-10-04).
 *
 *   plan     B-Sides' own model (the song page's tagModel, v2: one model for every text
 *            call, Owen 2026-10-10) writes it in short calls (album-text.ts): [album]
 *            (title, artist, a line about it, the cover description, the core sound),
 *            then [tracks] fifteen at a time, each batch told every title so far.
 *            There is a track for every two minutes of the length (songs run two to
 *            five), so tracks play in order until the length is filled and the rest go
 *            unmade.
 *   lyrics   a sung album: [lyrics], one call per track, each kept as it comes.
 *   cover    the server's image model paints the cover.
 *   tracks   only once all of the above is done (an album is made to be right,
 *            a single song to be fast; Owen, 2026-10-05), rendered in order, two at a time, until the album passes its
 *            length; each one is filed straight into the album under its name. Several
 *            albums on one server go one at a time or take turns (Settings, `fill`).
 *
 * The album IS a playlist (with `album` details beside it), so it plays, lists
 * and deletes like one, and it fills in while you listen. Every step's progress
 * is written to the playlist, so an album being made when the hub stops carries
 * on when it starts again.
 */
import type { CrucibleClient, CrucibleSession } from '@crucible/client';

import {
  aboutOf, batches, BPM, newAlbumTitle, newArtist, newTrackTitles, writeSongLyrics, type AlbumConcept,
} from './album-text';
import { installModel, startInstall } from './crucible';
import type { Lyricist } from './lyricist';
import { crucibleText, type TextModel } from './text-model';
import { Refusal, refusalOf } from './refusal';
import type { StoredServer } from './servers';
import { layLyrics } from './describe';
import { nameSong, writeConcept, writeCore, writeCover, writeIdeas, writeTurns } from './split-text';
import { ownIdea } from '../own-words';
import { leadFits, leadPhrase, VOICE_TAG, withoutVoice } from '../tags';
import { trackSet } from '../planning-sets';
import {
  LENGTH_AIMS, type AlbumAsk, type AlbumMeta, type AlbumOrder, type AlbumPlan, type AlbumRemake, type AlbumTrack, type LengthAim, type PlannedTrack, type SinglesOrder, type SongPage, type SongParams,
} from '../types';

/** A song is about this long: how many are counted as on their way (and a planned album's minutes, roughly). */
export const TYPICAL_TRACK_S = 150;
/** Songs run two to five minutes: the plan has a track per shortest song, so the length is always filled. */
const SHORTEST_TRACK_S = 120;
const MOST_TRACKS = 45;
/** "More like this" adds this much to an album. */
export const EXTEND_MINUTES = 15;
/** A writing session closes after this long with nothing asked (the cover's paint counts as asking). */
const SESSION_IDLE_S = 180;
/**
 * Album tracks on a server at once, whichever album's: one rendering, one waiting. With single
 * songs going next, one: a single sent then waits only for the track rendering.
 */
const AHEAD = 2;
const AHEAD_SINGLES_NEXT = 1;
/** This many failed tracks in a row stops the album. */
const FAILURES_TO_STOP = 3;
/**
 * Put the writer on the card before the plan asks it anything, so a long first load
 * (vLLM's warm-up takes minutes) shows as loading rather than as a plan that hangs
 * (Victoria's runs, 2026-10-10). A writer already resident needs nothing; a load the
 * server fails is a refusal in its words. A stream that ends with no outcome is
 * followed again: the job is still the server's.
 */
export async function loadWriter(client: CrucibleClient, model: string, step: () => Promise<void>, retryMs = LOAD_RETRY_MS): Promise<void> {
  const row = (await client.models()).find((entry) => entry.id === model);
  // Not a local model (an upstream account) or already on the card: nothing to load.
  if (row === undefined || row.resident) return;
  await step();
  // A failed load is tried once more after a pause (Victoria's laptop, 2026-10-11: on her 8 GiB card
  // the load failed while the song model was still leaving the card, "Free memory ... 6.95/8.0 GiB",
  // and every second try on a clear card worked).
  for (let attempt = 1; ; attempt += 1) {
    try {
      await loadOnce(client, model);
      return;
    } catch (error) {
      if (attempt >= 2 || !(error instanceof Refusal) || error.code !== 'writer_load_failed') throw error;
      console.error(`[albums] ${error.message}; trying once more in ${retryMs / 1000} s`);
      await new Promise((rest) => setTimeout(rest, retryMs));
    }
  }
}

/** A failed writer load is tried again after this long: time for the card to clear. */
const LOAD_RETRY_MS = 15_000;

async function loadOnce(client: CrucibleClient, model: string): Promise<void> {
  const jobId = await client.loadModel(model);
  for (;;) {
    for await (const event of client.events(jobId)) {
      if (event.event === 'done') return;
      if (event.event === 'failed') throw new Refusal('writer_load_failed', `The server could not load ${model}: ${event.data.error.message}`);
      if (event.event === 'cancelled' || event.event === 'removed') {
        throw new Refusal('writer_load_failed', `Loading ${model} was ${event.event} on the server; make the album again.`);
      }
    }
  }
}

/**
 * The image model to paint the cover with, or null when the server has none installed
 * and able to run: then the album keeps its standard (drawn) cover, as a normal case
 * (Owen, 2026-10-10: "configure b-sides to function even if it doesnt have an album
 * cover generator"). A model the server could install (`download`) is not used: a cover
 * never starts a multi-GB download on someone's server.
 */
export async function chooseCoverModel(client: CrucibleClient): Promise<string | null> {
  const pages = await client.playground();
  return pages.find((page) => page.jobType === 'image' && page.standing === 'ready')?.id ?? null;
}

/** The plan's tracks for `minutes`: one per shortest song (the aim's shortest, when it has one). */
export function trackCount(minutes: number, shortestS: number = SHORTEST_TRACK_S): number {
  return Math.min(MOST_TRACKS, Math.ceil((minutes * 60) / Math.max(60, shortestS)));
}

/**
 * The tracks the person gave, in order, or null for an album generated from its minutes: a planned
 * album's (Victoria, 2026-10-12), or one in their own words (1.0.28), which is a plan of sung tracks
 * whose every one has its lyrics. Either way the album is these tracks, and its length theirs.
 */
export function plannedTracks(ask: AlbumAsk): readonly PlannedTrack[] | null {
  if (ask.plan !== undefined) return ask.plan.tracks;
  if (ask.ownWords !== undefined) return ask.ownWords.map((track) => ({ ...(track.title !== null ? { title: track.title } : {}), lyrics: track.lyrics }));
  return null;
}

/** Whether plan place `at` is sung: a planned track's own choice (Victoria, 2026-10-12: "Per track"), else the album's. */
export function trackSung(ask: AlbumAsk, at: number): boolean {
  return ask.plan?.tracks[at]?.sung ?? ask.sung;
}

/**
 * One sung track's words, laid out for YuE: by the lyricist (Claude) or the server's model, told the
 * album and every title on it, so the within-album variety rules hold for a planned track too. A
 * planned track's brief is what it is about (its idea, to Claude; the brief itself, to the server's
 * model, which reads no idea).
 */
async function writeTrackLyrics(
  words: () => Promise<TextModel>, lyricist: Lyricist | null, ask: AlbumAsk, concept: AlbumConcept, tracks: readonly AlbumTrack[], at: number,
): Promise<string> {
  const track = tracks[at] as AlbumTrack;
  const written = lyricist === null
    ? await writeSongLyrics(await words(), { ...ask, sung: true, ...(track.brief !== undefined ? { lyrics: track.brief } : {}) }, concept, track.title, track.tags)
    : await lyricist.write({
      title: track.title,
      tags: track.tags,
      about: aboutOf(ask),
      brief: ask.lyrics ?? '',
      ...(track.idea ? { idea: track.idea } : {}),
      ...(ask.preChorus === true ? { preChorus: true } : {}),
      ...(ask.phonetic === true ? { phonetic: true } : {}),
      ...(ask.lyricsLength !== undefined ? { length: ask.lyricsLength } : {}),
      album: { title: concept.title, artist: concept.artist, blurb: concept.blurb, tracks: tracks.map((t) => t.title), at },
    });
  return layLyrics(written);
}

/** The aim an album's tracks were asked for, or null. */
export function trackAim(ask: AlbumAsk): LengthAim | null {
  return LENGTH_AIMS.find((aim) => aim.key === ask.trackLength) ?? null;
}

/**
 * A track's tags: the core, then its turn's new tags (none repeated); instrumental unless it is sung.
 * `exact` (AlbumAsk.exactTags): the turn adds only its tempo, and only when the core sets none.
 * `lead` (Owen, 2026-10-11: one lead a song): the track's singer, or the instrument carrying an
 * instrumental's melody ("<instrument> melody"). Given, it goes first and is the track's only voice:
 * a singer in the core or the turn goes. Absent (older plans): the first voice the tags hold.
 */
export function trackTags(core: string, turn: string, sung: boolean, exact = false, lead: string | null = null): string {
  const all = core.split(',').map((t) => t.trim()).filter((t) => t !== '');
  const first = lead === null ? null : leadPhrase(lead, !sung);
  // "piano" beside the lead "piano melody" is the same instrument said twice.
  const same = (t: string): boolean => first !== null
    && (t.toLowerCase() === first.toLowerCase() || `${t} melody`.toLowerCase() === first.toLowerCase());
  // Instrumental means no voice (Owen, 2026-10-08): even a singer in the person's own tags goes.
  const tags = (sung ? all : withoutVoice(all)).filter((t) => !same(t) && (first === null || !VOICE_TAG.test(t)));
  if (first !== null) tags.unshift(first);
  const seen = new Set(tags.map((t) => t.toLowerCase()));
  const coreTempo = BPM.test(core);
  let voiced = first !== null || tags.some((t) => VOICE_TAG.test(t));
  for (const extra of turn.split(',').map((t) => t.trim()).filter((t) => t !== '')) {
    if (seen.has(extra.toLowerCase()) || same(extra)) continue;
    if (!sung && VOICE_TAG.test(extra)) continue;
    // One singer: a second voice from the turn would ask YuE2 for two at once.
    if (VOICE_TAG.test(extra)) {
      if (voiced) continue;
      voiced = true;
    }
    if (exact && (coreTempo || !BPM.test(extra))) continue;
    seen.add(extra.toLowerCase());
    tags.push(extra);
  }
  const vocalFree = /(^|, )(instrumental|no vocals)(,|$)/i;
  if (sung) return tags.filter((t) => !/^(instrumental|no vocals|no singing)$/i.test(t)).join(', ');
  return vocalFree.test(tags.join(', ')) ? tags.join(', ') : [...tags, 'instrumental'].join(', ');
}

/**
 * Album art carries no writing at all (Owen, 2026-10-05, after a cover came back with a sign in
 * Chinese letters). Said twice, because an image model paints a sign the writer mentions: the
 * writer is told to describe nothing that carries writing (planPrompt), and the painter's prompt
 * ends by forbidding it. (A negative prompt would need guidance above 1.0: twice the paint time.)
 */
/** The painter's prompt for a cover: the writer's description, then the rule. */
export function coverPrompt(description: string): string {
  const said = description.trim().replace(/[.\s]+$/, '');
  return `${said}. Square album cover art. Absolutely no text, letters, numbers, characters or writing of any kind, in any language or script, anywhere in the image: no signs, labels, posters, logos or captions.`;
}

/** One track as the album sends it; the hub adds what its server takes (the aim, a planning set). */
export interface AlbumTrackParams {
  readonly tags: string;
  /** The track's lead (AlbumTrack.lead), sent as the song's (SongParams.lead); absent: its tags' own. */
  readonly lead?: string;
  readonly lyrics?: string;
  readonly instrumental: boolean;
  readonly cfg?: number;
  /** The length every track aims for, in seconds. */
  readonly aim?: { readonly min: number; readonly max: number };
  /** A full score the take renders (a remake's; SongParams.score): then no aim or planning set goes with it. */
  readonly score?: string;
}

/**
 * Track `track`'s song, as the hub sends it to `page`'s server: the aim when a length can be aimed
 * there, and an instrumental's structure, the sets in turn (crucible-pc-1, 2026-10-10: each
 * instrumental its own), B-Sides' own since 2026-10-11 and sent as planning_lyrics (jobs.ts songJob).
 */
export function trackSong(params: AlbumTrackParams, track: number, page: SongPage | undefined): SongParams {
  return {
    tags: params.tags,
    ...(params.lead !== undefined ? { lead: params.lead } : {}),
    instrumental: params.instrumental,
    ...(params.lyrics !== undefined ? { lyrics: params.lyrics } : {}),
    ...(params.cfg !== undefined ? { cfg: params.cfg } : {}),
    ...(params.score !== undefined ? { score: params.score } : {}),
    ...(params.score === undefined && params.aim !== undefined && page?.length === true ? { min_duration_s: params.aim.min, max_duration_s: params.aim.max } : {}),
    ...(params.instrumental && params.score === undefined ? { planning_set: trackSet(track).id } : {}),
  };
}

/** What the album maker needs from the hub around it. */
export interface AlbumHooks {
  /** The album's details as stored, or null when the album was deleted. */
  meta(id: string): Promise<AlbumMeta | null>;
  /** Write a change to the album's details (and its name, once planned). */
  update(id: string, meta: AlbumMeta, name?: string): Promise<void>;
  server(name: string): StoredServer;
  /** A client for the server; `album` under the album's own client name (its session and cover). */
  client(server: StoredServer, album?: boolean): CrucibleClient;
  /** The song page, for the writer's vocabulary (null when it cannot be read). */
  page(server: StoredServer): Promise<SongPage | null>;
  /** Paint the cover and file it beside the album; answers its file name (a new one each time). */
  paint(id: string, server: StoredServer, client: CrucibleClient, model: string, prompt: string): Promise<string>;
  /** Remove a cover file a newer one replaced (once the album points at the new one). */
  removeCover(file: string): Promise<void>;
  /** Send one track to the server, tagged with its album and place. */
  render(id: string, track: number, server: StoredServer, params: AlbumTrackParams): void;
  /** How many of this album's tracks are on the server and not ended. */
  inFlight(id: string): number;
  /**
   * Of those, how many are still rendering: a track made and waiting for its strip is not
   * (Owen, 2026-10-11; jobs.ts). The room on the server counts these; absent: all in flight.
   */
  rendering?(id: string): number;
  /** Name the album's first songs (made before the plan had names), in order. */
  retitle(id: string, titles: readonly string[]): Promise<void>;
  /** Cancel this album's tracks still on the server. */
  cancelInFlight(id: string): Promise<void>;
  /** The album's songs as filed: each one's title (its plan track's) and length. */
  made(id: string): Promise<readonly { readonly title: string; readonly durationS: number | null }[]>;
  /** Which of the album's tracks (plan places) are on the server now. */
  flyingTracks(id: string): readonly number[];
  /**
   * Claude writing instead of B-Sides' model (the Settings choices): its text calls (`text`), its
   * lyrics (`lyricist`), either or both. A null one, or null for both: B-Sides' model on the server.
   */
  claude(): { readonly text: TextModel | null; readonly words?: TextModel | null; readonly lyricist: Lyricist | null } | null;
  /** Worn words and a spark for names (fresh-names.ts); absent: none given. */
  freshNames?(): Promise<string>;
  /** A made track was named again: rename its song (the first of the album's songs with the old name). */
  renameSong(id: string, from: string, to: string): Promise<void>;
  /**
   * The albums making their music on `server`, in line (albumLine): one album at a time, only the
   * first sends tracks, so each album is finished before the next begins (Victoria, 2026-10-10:
   * several albums at once took turns a song at a time; Owen: "several albums would be good").
   * Taking turns, the first is the one whose turn it is.
   */
  makingOn(server: string): Promise<readonly string[]>;
  /** The Settings choices for the line (absent: one album at a time, single songs take their turn). */
  order?(): { readonly albums: AlbumOrder; readonly singles: SinglesOrder };
  /** Songs made on their own waiting on `server` or being made there (not ended, not being fetched). */
  singlesWaiting?(server: string): number;
}

/** An album making its music, as the line orders it. */
export interface InLine {
  readonly id: string;
  readonly createdAt: string;
  readonly album: Pick<AlbumMeta, 'lastSentAt' | 'nextAt'>;
}

/**
 * The albums making their music on one server, in the order they send tracks (Victoria, 2026-10-11).
 *
 *   one     Make this next first (the latest chosen first), then oldest first: the first sends
 *           every track until it is finished, and the rest wait.
 *   turns   an album chosen with Make this next and not sent from since goes first; then the one
 *           sent from longest ago (never first), then the oldest. Each sends one track and goes
 *           to the back.
 */
export function albumLine<T extends InLine>(albums: readonly T[], order: AlbumOrder): T[] {
  const byAge = (a: T, b: T): number => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  if (order === 'one') {
    return [...albums].sort((a, b) => (b.album.nextAt ?? '').localeCompare(a.album.nextAt ?? '') || byAge(a, b));
  }
  // Chosen, and not had its turn since: the very next turn is its.
  const chosen = (x: T): string => {
    const at = x.album.nextAt ?? '';
    return at !== '' && at > (x.album.lastSentAt ?? '') ? at : '';
  };
  return [...albums].sort((a, b) => chosen(b).localeCompare(chosen(a))
    || (a.album.lastSentAt ?? '').localeCompare(b.album.lastSentAt ?? '')
    || byAge(a, b));
}

/** A time stamp for the line: ISO, and always later than the one before (two sends in one millisecond keep their order). */
let lastStamp = 0;
export function lineStamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

/** One piece of a planned album the person can have written again. */
export type AlbumPiece = 'title' | 'artist' | 'cover' | 'track';

/**
 * Runs every album being made: one chain of steps per album, each step written
 * to the album before the next begins.
 */
export class AlbumMaker {
  private readonly running = new Set<string>();
  /** The writing sessions open now, by album: closed on quit. */
  private readonly sessions = new Map<string, CrucibleSession>();
  private readonly failures = new Map<string, number>();

  constructor(private readonly hooks: AlbumHooks) {}

  /** Start (or carry on with) an album; its stage says where it was. */
  start(id: string): void {
    if (this.running.has(id)) return;
    this.running.add(id);
    void this.advance(id).finally(() => this.running.delete(id));
  }

  /** Whether this album's writing is running now (its plan, lyrics or cover). */
  writing(id: string): boolean {
    return this.running.has(id);
  }

  /**
   * A track landed in the album: count its length and send the next. `remade`: it was a remake of
   * plan place `at`, filed in its old take's place (that take `replacedS` long, or null when it
   * was not there to replace); the plan keeps the words it sang.
   */
  async landed(id: string, seconds: number | null, remade?: { readonly at: number; readonly replacedS: number | null }): Promise<void> {
    this.failures.set(id, 0);
    const meta = await this.edit(id, (now) => {
      let next: AlbumMeta = { ...now, madeS: Math.max(0, now.madeS + (seconds ?? 0) - (remade?.replacedS ?? 0)) };
      const remake = remade === undefined ? undefined : (now.remakes ?? []).find((each) => each.at === remade.at);
      if (remade !== undefined && remake !== undefined && now.plan !== null) {
        const tracks = now.plan.tracks.map((track, i) => (i === remade.at && remake.lyrics !== null ? { ...track, lyrics: remake.lyrics } : track));
        next = { ...next, plan: { ...now.plan, tracks }, remakes: (now.remakes ?? []).filter((each) => each.at !== remade.at) };
      }
      return next;
    });
    if (meta === null) return;
    // The track landing is still its job's to finish (it is being filed): not one in flight. Counted,
    // the last track left the album at `making` for good, with nothing on the server (2026-10-06).
    await this.next(meta.server, id);
  }

  /** A track failed: skip it, and stop the album when several fail in a row. `at`: its plan place. */
  async failed(id: string, refusal: { code: string; message: string } | null, at?: number): Promise<void> {
    const remake = at === undefined ? undefined : (await this.hooks.meta(id))?.remakes?.find((each) => each.at === at);
    if (at !== undefined && remake !== undefined) {
      await this.remakeLost(id, at, refusal ?? { code: 'remake_failed', message: 'The server did not finish it.' });
      return;
    }
    const count = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, count);
    const meta = await this.hooks.meta(id);
    if (meta === null) return;
    if (count >= FAILURES_TO_STOP) {
      await this.edit(id, (now) => ({ ...now, stage: 'failed', refusal: refusal ?? { code: 'tracks_failed', message: `${count} tracks in a row failed.` } }));
      await this.next(meta.server);
      return;
    }
    // Whichever album's turn it is sends the next track (not always this one).
    await this.next(meta.server);
  }

  /** A track's job was cancelled (Stop, or the album deleted): a remake of it is dropped, the old take stays. */
  async cancelled(id: string, at: number): Promise<void> {
    const meta = await this.hooks.meta(id);
    if (meta?.remakes?.some((each) => each.at === at) !== true) return;
    await this.remakeLost(id, at, null);
  }

  /**
   * A remake that will not land: the album is as it was, the old take in its place and the plan's
   * words its own. It does not count towards stopping the album (the old take is still there),
   * and a failure is said on the page.
   */
  private async remakeLost(id: string, at: number, refusal: { code: string; message: string } | null): Promise<void> {
    const meta = await this.edit(id, (now) => {
      const title = now.plan?.tracks[at]?.title ?? `track ${at + 1}`;
      if (refusal !== null) console.error(`[albums] the new take of ${title} (${id}) failed: ${refusal.code}: ${refusal.message}`);
      return {
        ...now,
        remakes: (now.remakes ?? []).filter((each) => each.at !== at),
        redo: (now.redo ?? []).filter((place) => place !== at),
        ...(refusal === null ? {} : {
          remakeRefusal: { code: refusal.code, message: `The new take of "${title}" did not work, so the old one stays. ${refusal.message}` },
        }),
      };
    });
    if (meta === null) return;
    await this.next(meta.server);
  }

  /** Close every writing session open now (the app is quitting): the server is free at once, not after the idle time. */
  async closeSessions(): Promise<void> {
    // A session still waiting in the server's line is left too: one opened after B-Sides quit held
    // Victoria's only slot doing nothing until it idled out (2026-10-11), with four jobs behind it.
    for (const waiting of this.waiting) waiting.abort();
    await Promise.all([...this.sessions.values()].map((session) => session.close().catch(() => undefined)));
  }

  /** Albums' sessions still waiting in a server's line to open, aborted when B-Sides quits. */
  private readonly waiting = new Set<AbortController>();

  /**
   * Carry on with an album that did not finish (Owen, 2026-10-06): stopped by
   * hand or by a problem, or done with tracks missing (lost while the app was
   * closed, or failed). It picks up where it stands: writing whatever is not
   * written yet, then making each planned track that has no song.
   */
  async resume(id: string): Promise<void> {
    if (this.running.has(id)) return;
    const meta = await this.hooks.meta(id);
    if (meta === null) return;
    this.failures.set(id, 0);
    const unwritten = meta.plan === null
      || meta.plan.tracks.length < (meta.plan.trackCount ?? 0)
      || meta.plan.tracks.some((track, at) => trackSung(meta.ask, at) && track.lyrics === null)
      || (meta.cover === null && meta.coverState !== 'failed' && meta.coverState !== 'no_model');
    // Made whole now, not only its remakes.
    const next = await this.recover(id, { ...meta, refusal: null, step: null, remakeOnly: null });
    await this.hooks.update(id, { ...next, stage: unwritten ? 'planning' : 'making' });
    this.start(id);
  }

  /**
   * The album as its songs say it stands: the length made counted from them,
   * and every track sent before but with no song and not on the server now put
   * up to be sent again.
   */
  private async recover(id: string, meta: AlbumMeta): Promise<AlbumMeta> {
    if (meta.plan === null) return meta;
    const songs = await this.hooks.made(id);
    const made = new Map<string, number>();
    for (const song of songs) made.set(song.title.toLowerCase(), (made.get(song.title.toLowerCase()) ?? 0) + 1);
    const flying = new Set(this.hooks.flyingTracks(id));
    // `sent` healed to past every track made or on the server: one that stood short (a stale write,
    // before edit() serialised them) would have had the line send a made track over again.
    const titles = new Map(meta.plan.tracks.map((track, at) => [track.title.toLowerCase(), at] as const));
    const furthest = Math.max(-1, ...flying, ...[...made.keys()].map((key) => titles.get(key) ?? -1));
    const sent = Math.max(meta.sent, furthest + 1);
    const redo: number[] = [];
    for (const [at, track] of meta.plan.tracks.entries()) {
      if (at >= sent) break;
      const key = track.title.toLowerCase();
      const count = made.get(key) ?? 0;
      if (count > 0) made.set(key, count - 1);
      else if (!flying.has(at)) redo.push(at);
    }
    // A remake is made again too: its old take is there, so it is never counted as missing.
    for (const remake of meta.remakes ?? []) {
      if (!flying.has(remake.at) && !redo.includes(remake.at)) redo.push(remake.at);
    }
    const madeS = songs.reduce((sum, song) => sum + (song.durationS ?? 0), 0);
    return { ...meta, sent, madeS, redo };
  }

  /**
   * Write one piece of a planned album again (the regenerate buttons, v2's single-piece tasks):
   * its title, its artist, its cover (described again, then painted), or one track's name
   * (`at`, its place in the plan; a made track's song is renamed with it). Not while the
   * album is being written: the writing would overwrite it.
   */
  async regenerate(id: string, piece: AlbumPiece, at?: number): Promise<AlbumMeta> {
    if (this.running.has(id)) throw new Refusal('album_writing', 'This album is still being written; write a piece again once it is planned.', 409);
    const meta = await this.hooks.meta(id);
    if (meta === null) throw new Refusal('album_missing', 'That album is gone.', 404);
    const plan = meta.plan;
    if (plan === null || plan.tracks.length < (plan.trackCount ?? 0)) {
      throw new Refusal('album_unplanned', 'This album is not planned yet; write a piece again once it is.', 409);
    }
    const server = this.hooks.server(meta.server);
    const client = this.hooks.client(server, true);
    const claude = this.hooks.claude();
    // The cover description is the sound writer's; the names are the words writer's (split-text.ts).
    const writer: TextModel = piece === 'cover'
      ? claude?.text ?? await this.serverText(server)
      : claude?.words ?? await this.serverText(server);
    const concept: AlbumConcept = { title: plan.title, artist: plan.artist, blurb: plan.blurb, coverPrompt: plan.coverPrompt, core: plan.core ?? '' };
    const fresh = async (): Promise<AlbumMeta> => {
      const now = await this.hooks.meta(id);
      if (now === null || now.plan === null) throw new Refusal('album_missing', 'That album is gone.', 404);
      return now;
    };
    switch (piece) {
      case 'title': {
        const title = await newAlbumTitle(writer, meta.ask, concept, [plan.title]);
        const now = await fresh();
        const next = { ...now, plan: { ...(now.plan as AlbumPlan), title } };
        await this.hooks.update(id, next, title);
        return next;
      }
      case 'artist': {
        const artist = await newArtist(writer, meta.ask, concept, [meta.artist]);
        const now = await fresh();
        const next = { ...now, artist, plan: { ...(now.plan as AlbumPlan), artist } };
        await this.hooks.update(id, next);
        return next;
      }
      case 'cover': {
        const coverPrompt = await writeCover(writer, meta.ask, concept);
        const now = await fresh();
        await this.hooks.update(id, { ...now, plan: { ...(now.plan as AlbumPlan), coverPrompt } });
        // The text model goes off the card first, as before an album's first cover: the painter needs it.
        await this.paint(id, server, client, coverPrompt);
        return fresh();
      }
      case 'track': {
        const track = at === undefined ? undefined : plan.tracks[at];
        if (at === undefined || track === undefined) throw new Refusal('track_missing', 'That album has no such track.', 404);
        const [title] = await newTrackTitles(writer, meta.ask, concept, 1, plan.tracks.map((t) => t.title));
        const now = await fresh();
        const tracks = (now.plan as AlbumPlan).tracks.map((t, i) => (i === at ? { ...t, title: title as string } : t));
        const next = { ...now, plan: { ...(now.plan as AlbumPlan), tracks } };
        await this.hooks.update(id, next);
        // A made track's song carries the name too: the album finds its songs by their tracks' names.
        if (at < now.sent) await this.hooks.renameSong(id, track.title, title as string);
        return next;
      }
    }
  }

  /**
   * Make one made track again (Victoria, 2026-10-11: "reroll" a song, such as A Thousand Ships,
   * whose chorus did not fit the melody, without making the whole album again): the same tags and
   * a new seed, singing the old take's words (`keep`, as they stand on its song, corrected by hand
   * perhaps) or new ones the lyricist writes first (`fresh`). It goes through the album's line like
   * any track, sent before its next new one; a finished or stopped album makes only it, then goes
   * back to as it was. The old take (`song`) stays until the new one lands in its place.
   */
  async remake(
    id: string, at: number,
    ask: {
      readonly fresh: boolean; readonly song: string | null;
      /** The words the new take sings: the old take's, or the person's own (`own`; Victoria, 2026-10-13). */
      readonly keep: string | null; readonly own?: boolean;
      readonly tags?: string; readonly lead?: string | null;
      /** A full score for the new take (Victoria, 2026-10-13): the ABC text, rendered as given. */
      readonly score?: string;
    },
  ): Promise<AlbumMeta> {
    if (this.running.has(id)) throw new Refusal('album_writing', 'This album is still being written; make a track again once it is planned.', 409);
    const meta = await this.hooks.meta(id);
    if (meta === null) throw new Refusal('album_missing', 'That album is gone.', 404);
    const plan = meta.plan;
    if (plan === null || plan.tracks.length < (plan.trackCount ?? 0) || meta.stage === 'planning' || meta.stage === 'cover') {
      throw new Refusal('album_writing', 'This album is still being written; make a track again once its music has begun.', 409);
    }
    // Made is having a take (ask.song, below), not a place under `sent`: Victoria's "The Locket With
    // Two Tiny Faces" (2026-10-12) landed before the track ahead of it while `sent` stood short.
    const track = plan.tracks[at];
    if (track === undefined) throw new Refusal('track_missing', 'That album has no such track made.', 404);
    const key = `${id}:${at}`;
    if (this.rewriting.has(key) || (meta.remakes ?? []).some((each) => each.at === at)) {
      throw new Refusal('track_remaking', `"${track.title}" is already being made again.`, 409);
    }
    if ((meta.redo ?? []).includes(at) || this.hooks.flyingTracks(id).includes(at)) {
      throw new Refusal('track_making', `"${track.title}" is being made now; make it again once it is in.`, 409);
    }
    if (ask.song === null) throw new Refusal('track_unmade', `"${track.title}" has no take to replace; Make the missing tracks makes it.`, 409);
    const sung = trackSung(meta.ask, at) && track.lyrics !== null;
    if (ask.fresh && !sung) throw new Refusal('track_instrumental', `"${track.title}" is instrumental: it has no words to write again.`, 409);
    if (ask.own === true && !sung) throw new Refusal('track_instrumental', `"${track.title}" is instrumental: it sings no words. Make it as a sung single instead.`, 409);
    this.rewriting.add(key);
    try {
      const lyrics = !sung ? null : ask.fresh ? await this.lyricsFor(meta, at) : (ask.keep ?? track.lyrics);
      const next = await this.edit(id, (now) => {
        const remake: AlbumRemake = { at, song: ask.song, lyrics, ...(ask.score !== undefined ? { score: ask.score } : {}) };
        const finished = now.stage !== 'making' && now.stage !== 'planning' && now.stage !== 'cover';
        // New tags for the new take (Victoria, 2026-10-12: a 64 BPM lullaby YuE2 played at double time,
        // which "Same lyrics, new take" alone could never fix): the plan's track takes them, and its
        // lead, so the take keeps its place and every later remake starts from them. The lead given
        // goes first in the tags as the plan writes it (trackTags); none given, the track has none.
        const retagged = ask.tags === undefined ? now.plan : {
          ...(now.plan as AlbumPlan),
          tracks: (now.plan as AlbumPlan).tracks.map((each, i) => {
            if (i !== at) return each;
            const lead = ask.lead == null || ask.lead.trim() === '' ? null : ask.lead.trim();
            const phrase = lead === null ? null : leadPhrase(lead, !sung);
            const { lead: _was, ...rest } = each;
            const retrack: AlbumTrack = { ...rest, tags: trackTags(ask.tags as string, '', sung, true, lead), ...(phrase !== null ? { lead: phrase } : {}) };
            return retrack;
          }),
        };
        return {
          ...now,
          plan: retagged,
          remakes: [...(now.remakes ?? []), remake],
          redo: [...(now.redo ?? []), at],
          remakeRefusal: null,
          // Finished, stopped or failed: back in the line for this track alone, then as it was.
          ...(finished ? { stage: 'making' as const, remakeOnly: now.remakeOnly ?? now.stage } : {}),
        };
      });
      if (next === null) throw new Refusal('album_missing', 'That album is gone.', 404);
      await this.next(next.server);
      return next;
    } finally {
      this.rewriting.delete(key);
    }
  }

  /** Tracks whose new words are being written now ("<album>:<place>"): asked again meanwhile, refused. */
  private readonly rewriting = new Set<string>();

  /** One track's words written again, as the album's lyrics loop writes them (`write`), laid out for YuE. */
  private async lyricsFor(meta: AlbumMeta, at: number): Promise<string> {
    const plan = meta.plan as AlbumPlan;
    const claude = this.hooks.claude();
    const lyricist = claude?.lyricist ?? null;
    const concept: AlbumConcept = { title: plan.title, artist: plan.artist, blurb: plan.blurb, coverPrompt: plan.coverPrompt, core: plan.core ?? '' };
    const words = async (): Promise<TextModel> => claude?.words ?? this.serverText(this.hooks.server(meta.server));
    return writeTrackLyrics(words, lyricist, meta.ask, concept, plan.tracks, at);
  }

  /** The server's text model, for one call outside a writing session (a piece written again). */
  private async serverText(server: StoredServer): Promise<TextModel> {
    const client = this.hooks.client(server, true);
    const page = await this.hooks.page(server);
    if (page === null) throw new Refusal('page_unreadable', `Could not read ${server.name}'s song page, so B-Sides cannot tell which model writes.`);
    if (page.tagModel === null) throw new Refusal('no_tag_model', page.tagModelReason ?? 'This server has no model to write with.');
    // A chat never installs a model: a server without it starts installing and says so.
    const installing = await startInstall(client, page.tagModel);
    if (installing !== null) throw new Refusal('model_installing', `The writing model is being set up on the server first: ${installing.message}`, 409);
    return crucibleText(client, page.tagModel);
  }

  /**
   * More like this (Victoria, 2026-10-10: "the ability to add to an album if I really like the
   * vibe, with new songs added to the bottom"): EXTEND_MINUTES more of the same album. Its plan
   * already holds tracks it never made (one per two minutes, made until the length was filled);
   * when fewer than that much are left, new ones are planned after them, told every title so far.
   */
  async extend(id: string): Promise<AlbumMeta> {
    if (this.running.has(id)) throw new Refusal('album_writing', 'This album is still being written; add to it once it is planned.', 409);
    const meta = await this.hooks.meta(id);
    if (meta === null) throw new Refusal('album_missing', 'That album is gone.', 404);
    const plan = meta.plan;
    if (plan === null || plan.tracks.length < (plan.trackCount ?? 0)) {
      throw new Refusal('album_unplanned', 'This album is not planned yet; add to it once it is.', 409);
    }
    if (meta.ask.ownWords !== undefined) {
      throw new Refusal('album_own_words', 'This album sings your own words, and every one is on it. Make another album for more.', 409);
    }
    if (meta.ask.plan !== undefined) {
      throw new Refusal('album_planned', 'You planned this album song by song, and every song is on it. Make another album for more.', 409);
    }
    const spare = plan.tracks.length - meta.sent;
    const more = Math.max(0, trackCount(EXTEND_MINUTES, trackAim(meta.ask)?.min) - spare);
    const grown: AlbumPlan = more === 0 ? plan : { ...plan, trackCount: plan.tracks.length + more };
    const next: AlbumMeta = {
      ...meta,
      ask: { ...meta.ask, minutes: meta.ask.minutes + EXTEND_MINUTES },
      plan: grown,
      stage: more > 0 ? 'planning' : 'making',
      refusal: null,
      step: null,
      remakeOnly: null,
    };
    await this.hooks.update(id, next);
    this.failures.set(id, 0);
    this.start(id);
    return next;
  }

  /** Stop making it: no more tracks, and the ones on the server are cancelled. What is made stays. */
  async stop(id: string): Promise<void> {
    const meta = await this.hooks.meta(id);
    if (meta !== null && meta.stage !== 'done') {
      // Its remakes are dropped (the old takes stay); one making only its remakes goes back to as it was.
      const remade = new Set((meta.remakes ?? []).map((each) => each.at));
      await this.hooks.update(id, {
        ...meta,
        stage: meta.remakeOnly ?? 'stopped',
        remakeOnly: null,
        remakes: [],
        redo: (meta.redo ?? []).filter((place) => !remade.has(place)),
      });
    }
    await this.hooks.cancelInFlight(id);
    if (meta !== null) await this.next(meta.server);
  }

  /**
   * Something changed on `server` (a track landed or failed, an album left the line or joined it, a
   * single song ended, a Settings choice): send what the line has room for, in its order. One fill
   * per server at a time, so two never read the same `sent` and send a track twice. `landing`: the
   * album whose track is being filed now (its job is not ended yet, but is no longer on the server).
   */
  next(server: string, landing: string | null = null): Promise<void> {
    const run = (this.lines.get(server) ?? Promise.resolve()).then(() => this.fill(server, landing));
    this.lines.set(server, run.catch(() => undefined));
    return run;
  }

  /**
   * Make this next (Victoria, 2026-10-11): the album goes ahead of the others on its server. One
   * at a time, the album ahead stops sending (its tracks on the server finish) and this one sends
   * until it is finished; taking turns, it has the very next turn.
   */
  async makeNext(id: string): Promise<void> {
    const meta = await this.hooks.meta(id);
    if (meta === null) throw new Refusal('album_missing', 'That album is gone.', 404);
    if (meta.stage !== 'making') throw new Refusal('album_not_making', 'Only an album making its music can go next.', 409);
    await this.hooks.update(id, { ...meta, nextAt: lineStamp() });
    await this.next(meta.server);
  }

  /** The fill under way (or last finished) on each server: the next one waits for it. */
  private readonly lines = new Map<string, Promise<unknown>>();

  /** Each album's edits, one at a time (edit). */
  private readonly edits = new Map<string, Promise<unknown>>();

  /**
   * Read the album as it stands now and write it back changed, one edit at a time per album, so no
   * edit writes over another's. Every runtime change goes through here (a track sent, landed or
   * failed; a remake asked for or lost; the line's stage changes): Victoria's "Waltz of Remembered
   * Things" (2026-10-12) had `sent` fall back by one when a landing's write, started before a send,
   * finished after it, so the line sent its next track twice over and the one made showed no
   * "Make this track again". `change` answers null to leave the album as it is; a gone album is null.
   */
  private edit(id: string, change: (meta: AlbumMeta) => AlbumMeta | null | Promise<AlbumMeta | null>): Promise<AlbumMeta | null> {
    const run = async (): Promise<AlbumMeta | null> => {
      const meta = await this.hooks.meta(id);
      if (meta === null) return null;
      const next = await change(meta);
      if (next !== null) await this.hooks.update(id, next);
      return next ?? meta;
    };
    const line = (this.edits.get(id) ?? Promise.resolve()).then(run, run);
    this.edits.set(id, line.catch(() => undefined));
    return line;
  }

  private async advance(id: string): Promise<void> {
    let meta = await this.hooks.meta(id);
    if (meta === null) return;
    try {
      const server = this.hooks.server(meta.server);
      if (meta.stage === 'planning') {
        // Everything first (Owen, 2026-10-05: "the goal with generating an album is correct"):
        // the plan (names, tags), every sung track's lyrics, then the cover; only then the music.
        // All of it inside one queue session: Crucible clears the card the moment nothing holds
        // it, so thirteen lyrics calls in a row would load and unload the model thirteen times.
        // The session holds the server for this run; each model stays loaded while its calls last.
        meta = await this.write(id, meta, server);
        if (meta.stage === 'making') await this.next(meta.server);
        return;
      }
      // An album from before the cover moved behind the tracks may stand at `cover`: carry on making.
      if (meta.stage === 'cover') {
        meta = { ...meta, stage: 'making' };
        await this.hooks.update(id, meta);
      }
      if (meta.stage === 'making') {
        // Tracks that were on the server when the app closed and are gone now: made again.
        meta = (await this.edit(id, (now) => this.recover(id, now))) ?? meta;
        await this.next(meta.server);
      }
    } catch (error) {
      const current = await this.hooks.meta(id);
      const refusal = refusalOf(error);
      // Said in the log too, so a failure on someone else's computer can be read afterwards.
      console.error(`[albums] ${current?.plan?.title ?? id} (${id}) failed: ${refusal.code}: ${refusal.message}`);
      if (current !== null) {
        await this.hooks.update(id, { ...current, stage: 'failed', refusal });
        await this.next(current.server);
      }
    }
  }

  /** The planning stage, in one queue session: plan, lyrics, cover. Answers the album as it then stands. */
  private async write(id: string, start: AlbumMeta, server: StoredServer): Promise<AlbumMeta> {
    let meta = start;
    // A session this album opened before a crash or quit still holds the server until it idles out:
    // closed first, so it does not hold up the new one (guide §7.5, the sweep).
    if (meta.session != null) {
      await this.hooks.client(server).closeSession(meta.session).catch(() => undefined);
      meta = { ...meta, session: null };
      await this.hooks.update(id, meta);
    }
    // Two writers (split-text.ts; Owen, 2026-10-11): the words (names, liner note, track ideas, lyrics)
    // and the sound (the core, each track's turn, the cover description). Either is Claude or the
    // server's model; the server's is held in a queue session, opened only when first needed, so
    // nothing of the server is held while Claude writes.
    const claude = this.hooks.claude();
    let session: CrucibleSession | null = null;
    let serverWriter: TextModel | null = null;
    const release = async (): Promise<void> => {
      if (session === null) return;
      const closing = session;
      session = null;
      serverWriter = null;
      this.sessions.delete(id);
      await closing.close().catch((err: unknown) => console.error(`[albums] could not close the session for ${id}:`, err));
      const now = await this.hooks.meta(id);
      if (now !== null && now.session === closing.id) await this.hooks.update(id, { ...now, session: null });
    };
    try {
      const page = await this.hooks.page(server);
      // A plan from before v2 was written whole, in one call: its own length is its count.
      const own = plannedTracks(meta.ask);
      const count = meta.plan == null
        ? (own !== null ? own.length : trackCount(meta.ask.minutes, trackAim(meta.ask)?.min))
        : (meta.plan.trackCount ?? meta.plan.tracks.length);
      const show = async (step: AlbumMeta['step']): Promise<void> => {
        meta = { ...(await this.hooks.meta(id) ?? meta), step };
        await this.hooks.update(id, meta);
      };
      const onServer = async (): Promise<TextModel> => {
        if (serverWriter !== null) return serverWriter;
        // The calls ride one session, so the text model stays loaded between them. Its own client
        // name: Crucible counts every request from the session's name as one of its items, and
        // removes the ones still waiting when it closes; under the install's own name, a song made
        // meanwhile would join the album's session and be dropped with it.
        if (page === null) throw new Refusal('page_unreadable', `Could not read ${server.name}'s song page, so B-Sides cannot tell which model writes.`);
        if (page.tagModel === null) throw new Refusal('no_tag_model', page.tagModelReason ?? 'This server has no tag model to write an album with.');
        const leave = new AbortController();
        this.waiting.add(leave);
        const opened = await this.hooks.client(server, true).session({ act: 'generate', idleS: SESSION_IDLE_S, signal: leave.signal })
          .finally(() => this.waiting.delete(leave));
        session = opened;
        this.sessions.set(id, opened);
        meta = { ...(await this.hooks.meta(id) ?? meta), session: opened.id };
        await this.hooks.update(id, meta);
        const model = page.tagModel;
        await installModel(opened, model, (detail) => show({ kind: 'install', done: 0, of: 0, detail }));
        await loadWriter(opened, model, () => show({ kind: 'load', done: 0, of: 0, detail: model }));
        serverWriter = crucibleText(opened, model);
        return serverWriter;
      };
      const words = async (): Promise<TextModel> => claude?.words ?? onServer();
      const sound = async (): Promise<TextModel> => claude?.text ?? onServer();
      const plans = batches(count);
      const steps = plans.length * 2 + 3;
      // [concept]: the album's name, artist and liner note, kept at once (a restart carries on from it).
      let plan: AlbumPlan;
      if (meta.plan == null) {
        await show({ kind: 'plan', done: 0, of: steps });
        const writer = await words();
        const named = await writeConcept(writer, meta.ask, count, await this.hooks.freshNames?.() ?? '');
        plan = { ...named, coverPrompt: '', core: '', tracks: [], trackCount: count };
        meta = { ...(await this.hooks.meta(id) ?? meta), writer: writer.name, plan, artist: plan.artist, blurb: plan.blurb };
        await this.hooks.update(id, meta, plan.title);
      } else {
        plan = meta.plan;
      }
      // Planned by the person (Victoria, 2026-10-12), or in their own words: a track for each, in
      // order. Their lyrics are kept as given and their names stand; a track named by nobody is named
      // for its words or its brief, and one left blank is written as a generated album's are, told
      // every title so far. One at a time, each kept as it comes, so a restart carries on.
      if (own !== null && plan.tracks.length < own.length) {
        await show({ kind: 'plan', done: 1, of: steps });
        for (const [at, given] of own.entries()) {
          if (at < plan.tracks.length) continue;
          if (await this.halted(id)) return meta;
          const taken = plan.tracks.map((track) => track.title);
          const tags = given.tags ?? meta.ask.tags;
          const named = async (about: string, lyrics: string): Promise<string> => given.title
            ?? await nameSong(await words(), about, tags, lyrics, await this.hooks.freshNames?.() ?? '').catch(() => null)
            ?? `Track ${at + 1}`;
          let track: AlbumTrack;
          if (given.lyrics !== undefined) {
            track = { title: await named(aboutOf(meta.ask), given.lyrics), idea: ownIdea(given.lyrics), tags: '', lyrics: given.lyrics };
          } else if (given.brief !== undefined) {
            track = { title: await named(given.brief, ''), idea: given.brief, brief: given.brief, tags: '', lyrics: null };
          } else if (given.title !== undefined) {
            track = { title: given.title, tags: '', lyrics: null };
          } else {
            const [idea] = await writeIdeas(
              await words(), { ...meta.ask, sung: trackSung(meta.ask, at) }, plan, at + 1, at + 1, count, taken, await this.hooks.freshNames?.() ?? '',
            );
            track = { title: idea?.title ?? `Track ${at + 1}`, ...(idea?.idea ? { idea: idea.idea } : {}), tags: '', lyrics: null };
          }
          plan = { ...plan, tracks: [...plan.tracks, track] };
          meta = { ...(await this.hooks.meta(id) ?? meta), plan, ...(given.lyrics !== undefined ? { lyricsBy: 'you' } : {}) };
          await this.hooks.update(id, meta);
        }
      }
      // [ideas]: the track list, fifteen at a time, each a title and what it is about, each batch told every title so far.
      for (const [at, [first, last]] of plans.entries()) {
        if (plan.tracks.length >= last) continue;
        if (await this.halted(id)) return meta;
        await show({ kind: 'plan', done: 1 + at, of: steps });
        const writer = await words();
        const ideas = await writeIdeas(
          writer, meta.ask, plan, plan.tracks.length + 1, last, count, plan.tracks.map((track) => track.title), await this.hooks.freshNames?.() ?? '',
        );
        plan = { ...plan, tracks: [...plan.tracks, ...ideas.map((track): AlbumTrack => ({ title: track.title, idea: track.idea, tags: '', lyrics: null }))] };
        meta = { ...(await this.hooks.meta(id) ?? meta), writer: writer.name, plan };
        await this.hooks.update(id, meta);
        // An album begun before this order made its first tracks before the plan: they take its first names.
        const early = meta.openers ?? 0;
        if (first === 1 && early > 0) await this.hooks.retitle(id, plan.tracks.slice(0, early).map((track) => track.title));
      }
      // [core]: the sound every track keeps (the person's own tags are it, with no call).
      if (!plan.core) {
        if (await this.halted(id)) return meta;
        await show({ kind: 'plan', done: 1 + plans.length, of: steps });
        const writer = await sound();
        plan = { ...plan, core: await writeCore(writer, meta.ask, plan, page) };
        meta = { ...(await this.hooks.meta(id) ?? meta), soundBy: writer.name, plan };
        await this.hooks.update(id, meta);
      }
      const core = plan.core as string;
      // [turns]: each track's own sound, fifteen at a time, for the tracks that have none yet.
      for (const [at, [first, last]] of plans.entries()) {
        const batch = plan.tracks.slice(first - 1, last);
        if (batch.every((track) => track.tags !== '')) continue;
        if (await this.halted(id)) return meta;
        await show({ kind: 'plan', done: 2 + plans.length + at, of: steps });
        const writer = await sound();
        const theirs = meta.ask.lead?.trim() || null;
        // Set for each song (Victoria, 2026-10-12): a track's own tags are its core, kept as exactly
        // as the album's are with "stick exactly to the tags"; one left without keeps the album's.
        const perSong = meta.ask.plan?.tagMode === 'per-song';
        const exact = meta.ask.exactTags === true || perSong;
        const coreOf = (i: number): string => (perSong ? (meta.ask.plan?.tracks[i]?.tags ?? []).join(', ') : '') || core;
        // A planned album may mix sung and instrumental tracks: each kind is given its sound apart.
        const places = batch.map((_, k) => first - 1 + k).filter((i) => (plan.tracks[i] as AlbumTrack).tags === '');
        for (const sung of [true, false]) {
          const group = places.filter((i) => trackSung(meta.ask, i) === sung);
          if (group.length === 0) continue;
          // One lead a track (Owen, 2026-10-11): the track's own (Victoria, 2026-10-12), else the
          // album's where it fits the track (a singer leads no instrumental), else the writer's;
          // sticking to the person's tags, none is added but theirs.
          const leads = group.map((i) => meta.ask.plan?.tracks[i]?.lead
            ?? (theirs !== null && (meta.ask.plan === undefined || leadFits(theirs, !sung)) ? theirs : null));
          const shared = leads.every((lead) => lead === leads[0]) ? leads[0] ?? null : null;
          const turns = await writeTurns(writer, sung, core, group.map((i) => {
            const track = plan.tracks[i] as AlbumTrack;
            const idea = [track.idea, coreOf(i) !== core ? `its own sound: ${coreOf(i)}` : ''].filter((said) => said).join('; ');
            return { title: track.title, ...(idea !== '' ? { idea } : {}) };
          }), page, shared);
          plan = {
            ...plan,
            tracks: plan.tracks.map((track, i) => {
              const k = group.indexOf(i);
              if (k < 0) return track;
              const turn = turns[k];
              const lead = leads[k] ?? (exact ? null : turn?.lead ?? null);
              const tags = trackTags(coreOf(i), turn?.more ?? '', sung, exact, lead);
              const sent = lead === null ? null : leadPhrase(lead, !sung);
              return { ...track, tags, ...(sent !== null ? { lead: sent } : {}) };
            }),
          };
        }
        meta = { ...(await this.hooks.meta(id) ?? meta), soundBy: writer.name, plan };
        await this.hooks.update(id, meta);
      }
      // [cover]: what the image model paints.
      if (!plan.coverPrompt) {
        if (await this.halted(id)) return meta;
        await show({ kind: 'plan', done: steps - 1, of: steps });
        const writer = await sound();
        const concept: AlbumConcept = { title: plan.title, artist: plan.artist, blurb: plan.blurb, coverPrompt: '', core };
        plan = { ...plan, coverPrompt: await writeCover(writer, meta.ask, concept) };
        meta = { ...(await this.hooks.meta(id) ?? meta), plan };
        await this.hooks.update(id, meta);
      }
      const concept: AlbumConcept = { title: plan.title, artist: plan.artist, blurb: plan.blurb, coverPrompt: plan.coverPrompt, core };
      const early = meta.openers ?? 0;
      // The sung tracks with no words yet; a planned track's own lyrics are never touched.
      const sungAt = plan.tracks.map((_, at) => at).filter((at) => at >= early && trackSung(meta.ask, at));
      if (sungAt.some((at) => (plan.tracks[at] as AlbumTrack).lyrics === null)) {
        // [lyrics], one call per track, each kept as it comes (a restart carries on).
        const lyricist = claude?.lyricist ?? null;
        // Claude writing the words: the server's text model is let go first, not held on the card
        // through minutes of Claude writing.
        if (lyricist !== null) await release();
        for (const [done, at] of sungAt.entries()) {
          const track = plan.tracks[at] as AlbumTrack;
          if (track.lyrics !== null) continue;
          if (await this.halted(id)) return meta;
          await show({ kind: 'lyrics', done, of: sungAt.length });
          const lyrics = await writeTrackLyrics(words, lyricist, meta.ask, concept, plan.tracks, at);
          plan = { ...plan, tracks: plan.tracks.map((t, i) => (i === at ? { ...t, lyrics } : t)) };
          meta = { ...(await this.hooks.meta(id) ?? meta), plan, lyricsBy: lyricist?.name ?? (await words()).name };
          await this.hooks.update(id, meta);
        }
        if (await this.halted(id)) return meta;
      }
      // The cover, before the music. One that will not paint is said on the page; the album goes on.
      if (meta.cover === null && meta.coverState !== 'failed' && meta.coverState !== 'no_model') {
        meta = { ...(await this.hooks.meta(id) ?? meta), step: { kind: 'cover', done: 0, of: 1 } };
        await this.hooks.update(id, meta);
        // The session closes first. Held open, it keeps the text model on the card, and the image
        // model cannot load beside it: on the PC on 2026-10-06 the cover sat queued 18 minutes,
        // refused as `accelerator_busy` (the text model's memory past its estimate counted as
        // another process's, which Crucible never evicts), with the GPU idle. Closed, the card is
        // empty and the cover is a plain job under the album's name.
        await release();
        await this.paint(id, server, this.hooks.client(server, true), plan.coverPrompt);
        if (await this.halted(id)) return meta;
      }
      if (await this.halted(id)) return meta;
      meta = { ...(await this.hooks.meta(id) ?? meta), stage: 'making', step: null };
      await this.hooks.update(id, meta);
      return meta;
    } finally {
      // Closed before the cover and the music at the latest: the tracks go through the line like any song.
      await release();
    }
  }

  /** Deleted, or stopped by hand: the writing stops where it is. */
  private async halted(id: string): Promise<boolean> {
    const meta = await this.hooks.meta(id);
    return meta === null || meta.stage !== 'planning';
  }

  private async paint(id: string, server: StoredServer, client: CrucibleClient, prompt: string): Promise<void> {
    const mark = async (change: Partial<AlbumMeta>): Promise<void> => {
      const meta = await this.hooks.meta(id);
      if (meta !== null) await this.hooks.update(id, { ...meta, ...change });
    };
    try {
      const model = await chooseCoverModel(client);
      if (model === null) {
        await mark({ coverState: 'no_model' });
        return;
      }
      await mark({ coverState: 'painting' });
      const before = (await this.hooks.meta(id))?.cover ?? null;
      const cover = await this.hooks.paint(id, server, client, model, coverPrompt(prompt));
      await mark({ cover, coverState: null, coverJob: null });
      if (before !== null && before !== cover) await this.hooks.removeCover(before);
    } catch (error) {
      // A cover that will not paint leaves the drawn one; the music matters more.
      console.error(`[albums] the cover for ${id} did not paint:`, error);
      await mark({ coverState: 'failed', coverJob: null });
    }
  }

  /**
   * Keep the server's album tracks topped up, in the line's order, until each album passes its
   * length or runs out of plan. Counted across the server's albums, not each album's own: an album
   * chosen with Make this next waits for the tracks already sent for the one before it, and a
   * single song never waits behind more than AHEAD album tracks, however many albums there are.
   *
   *   one     only the first album sends; it keeps AHEAD on the server.
   *   turns   the album whose turn it is sends one track and goes to the back; the next one in
   *           line takes the next room. One that needs nothing now (its songs on the server will
   *           fill its length) is passed over.
   *
   * With single songs going next, albums keep AHEAD_SINGLES_NEXT on the server and send nothing
   * while a single is waiting; it ending calls `next` again.
   */
  private async fill(server: string, landing: string | null): Promise<void> {
    const order = this.hooks.order?.() ?? { albums: 'one', singles: 'turn' };
    // The landing track's job is still listed while it is filed, but is off the server.
    const own = (id: string): number => Math.max(0, this.hooks.inFlight(id) - (id === landing ? 1 : 0));
    // Each pass sends at most one track, and there is room for at most AHEAD: the bound only guards a mistake.
    for (let pass = 0; pass <= AHEAD; pass += 1) {
      const line: { id: string; meta: AlbumMeta }[] = [];
      for (const id of await this.hooks.makingOn(server)) {
        const meta = await this.hooks.meta(id);
        if (meta === null || meta.stage !== 'making' || meta.plan === null) continue;
        // Making only its remakes, and none left to send or on the server: back to as it was.
        if (meta.remakeOnly != null && this.wants(meta, own(id)) === null && own(id) === 0) {
          await this.edit(id, (now) => ({ ...now, stage: now.remakeOnly ?? now.stage, remakeOnly: null, remakes: [] }));
          continue;
        }
        // Nothing left to make and nothing on the server: done, and out of the line.
        if (this.wants(meta, own(id)) === null && own(id) === 0 && (meta.redo ?? []).length === 0) {
          await this.edit(id, (now) => ({ ...now, stage: 'done', remakes: [] }));
          continue;
        }
        line.push({ id, meta });
      }
      // The room is the renders on the server.
      const rendering = (id: string): number => (this.hooks.rendering === undefined ? own(id) : this.hooks.rendering(id));
      const flying = line.reduce((sum, album) => sum + rendering(album.id), 0);
      const room = order.singles === 'next'
        ? ((this.hooks.singlesWaiting?.(server) ?? 0) > 0 ? 0 : AHEAD_SINGLES_NEXT)
        : AHEAD;
      if (flying >= room) return;
      const may = order.albums === 'turns' ? line : line.slice(0, 1);
      const turn = may.find((album) => this.wants(album.meta, own(album.id)) !== null);
      if (turn === undefined) return;
      await this.send(turn.id, turn.meta, this.wants(turn.meta, own(turn.id)) as number);
    }
  }

  /**
   * The plan place this album would send next, or null when it needs none now: a track to make
   * again first (it was part of the album before the length was reached), then the next new one
   * while the songs made and on the server fall short of its length.
   */
  private wants(meta: AlbumMeta, flying: number): number | null {
    const plan = meta.plan as AlbumPlan;
    const redo = meta.redo ?? [];
    // Back only for its remakes (a finished or stopped album): nothing else is sent, not even a lost track.
    if (meta.remakeOnly != null) return redo.find((at) => (meta.remakes ?? []).some((each) => each.at === at)) ?? null;
    if (redo.length > 0) return redo[0] as number;
    // Planned, or in the person's own words: every track they gave is made, whatever its length.
    if (meta.sent < plan.tracks.length && plannedTracks(meta.ask) !== null) return meta.sent;
    if (meta.sent < plan.tracks.length && meta.madeS + flying * TYPICAL_TRACK_S < meta.ask.minutes * 60) return meta.sent;
    return null;
  }

  /** Send one track (`at`, a plan place) and write down that it went, and when. */
  private async send(id: string, _snapshot: AlbumMeta, at: number): Promise<void> {
    // Sent and written down as one edit, from the album as it stands now (not the line's snapshot).
    await this.edit(id, (meta) => {
      const plan = meta.plan as AlbumPlan;
      const track = plan.tracks[at] as AlbumTrack;
      const redo = meta.redo ?? [];
      const again = redo.includes(at);
      // A remake sings its own words (new ones, or the old take's); the plan takes them once it lands.
      const remake = again ? (meta.remakes ?? []).find((each) => each.at === at) : undefined;
      const lyrics = remake?.lyrics ?? track.lyrics;
      // Sung or not as its plan place is (a planned album may mix them; Victoria, 2026-10-12).
      const sung = trackSung(meta.ask, at) && lyrics !== null;
      const aim = trackAim(meta.ask);
      this.hooks.render(id, at, this.hooks.server(meta.server), {
        tags: track.tags,
        // Its lead, a remake's too (Owen, 2026-10-11). A sung album's track that lost its words is sent
        // instrumental: a singer is no lead for it, and its tags' own melody stands.
        ...(track.lead !== undefined && sung === trackSung(meta.ask, at) ? { lead: track.lead } : {}),
        instrumental: !sung,
        ...(sung ? { lyrics: lyrics as string } : {}),
        ...(meta.ask.cfg != null ? { cfg: meta.ask.cfg } : {}),
        ...(aim !== null ? { aim: { min: aim.min, max: aim.max } } : {}),
        // A remake from a full score (Victoria, 2026-10-13) renders it instead of a plan.
        ...(remake?.score !== undefined ? { score: remake.score } : {}),
      });
      return {
        ...meta,
        // A new track counts up to past its place, never short of it (a stale write once set it back).
        sent: again ? meta.sent : Math.max(meta.sent, at + 1),
        redo: again ? redo.filter((place, i) => place !== at || i !== redo.indexOf(at)) : redo,
        lastSentAt: lineStamp(),
      };
    });
  }
}
