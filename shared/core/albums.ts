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
 *            length; each one is filed straight into the album under its name.
 *
 * The album IS a playlist (with `album` details beside it), so it plays, lists
 * and deletes like one, and it fills in while you listen. Every step's progress
 * is written to the playlist, so an album being made when the hub stops carries
 * on when it starts again.
 */
import type { CrucibleClient, CrucibleSession } from '@crucible/client';

import {
  aboutOf, batches, newAlbumTitle, newArtist, newCoverPrompt, newTrackTitles, writeAlbum, writeSongLyrics, writeTracks, type AlbumConcept,
} from './album-text';
import { installModel, startInstall } from './crucible';
import type { Lyricist } from './lyricist';
import { Refusal, refusalOf } from './refusal';
import type { StoredServer } from './servers';
import { layLyrics } from './describe';
import { VOICE_TAG, withoutVoice } from '../tags';
import type { AlbumMeta, AlbumPlan, AlbumTrack, SongPage } from '../types';

/** A song is about this long: how many are counted as on their way. */
const TYPICAL_TRACK_S = 150;
/** Songs run two to five minutes: the plan has a track per shortest song, so the length is always filled. */
const SHORTEST_TRACK_S = 120;
const MOST_TRACKS = 45;
/** A writing session closes after this long with nothing asked (the cover's paint counts as asking). */
const SESSION_IDLE_S = 180;
/** Songs on the server at once for one album: one rendering, one waiting. */
const AHEAD = 2;
/** This many failed tracks in a row stops the album. */
const FAILURES_TO_STOP = 3;
/**
 * Put the writer on the card before the plan asks it anything, so a long first load
 * (vLLM's warm-up takes minutes) shows as loading rather than as a plan that hangs
 * (Victoria's runs, 2026-10-10). A writer already resident needs nothing; a load the
 * server fails is a refusal in its words. A stream that ends with no outcome is
 * followed again: the job is still the server's.
 */
export async function loadWriter(client: CrucibleClient, model: string, step: () => Promise<void>): Promise<void> {
  const row = (await client.models()).find((entry) => entry.id === model);
  // Not a local model (an upstream account) or already on the card: nothing to load.
  if (row === undefined || row.resident) return;
  await step();
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

export function trackCount(minutes: number): number {
  return Math.min(MOST_TRACKS, Math.ceil((minutes * 60) / SHORTEST_TRACK_S));
}

/** A track's tags: the core, then its turn's new tags (none repeated); instrumental unless it is sung. */
export function trackTags(core: string, turn: string, sung: boolean): string {
  const all = core.split(',').map((t) => t.trim()).filter((t) => t !== '');
  // Instrumental means no voice (Owen, 2026-10-08): even a singer in the person's own tags goes.
  const tags = sung ? all : withoutVoice(all);
  const seen = new Set(tags.map((t) => t.toLowerCase()));
  for (const extra of turn.split(',').map((t) => t.trim()).filter((t) => t !== '')) {
    if (seen.has(extra.toLowerCase())) continue;
    if (!sung && VOICE_TAG.test(extra)) continue;
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
  render(id: string, track: number, server: StoredServer, params: { tags: string; lyrics?: string; instrumental: boolean; cfg?: number }): void;
  /** How many of this album's tracks are on the server and not ended. */
  inFlight(id: string): number;
  /** Name the album's first songs (made before the plan had names), in order. */
  retitle(id: string, titles: readonly string[]): Promise<void>;
  /** Cancel this album's tracks still on the server. */
  cancelInFlight(id: string): Promise<void>;
  /** The album's songs as filed: each one's title (its plan track's) and length. */
  made(id: string): Promise<readonly { readonly title: string; readonly durationS: number | null }[]>;
  /** Which of the album's tracks (plan places) are on the server now. */
  flyingTracks(id: string): readonly number[];
  /** Who writes sung lyrics instead of the album's model (the stand-in Claude lyricist), or null. */
  lyricist(): Lyricist | null;
  /** A made track was named again: rename its song (the first of the album's songs with the old name). */
  renameSong(id: string, from: string, to: string): Promise<void>;
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

  /** A track landed in the album: count its length and send the next. */
  async landed(id: string, seconds: number | null): Promise<void> {
    this.failures.set(id, 0);
    const meta = await this.hooks.meta(id);
    if (meta === null) return;
    const next: AlbumMeta = { ...meta, madeS: meta.madeS + (seconds ?? 0) };
    await this.hooks.update(id, next);
    // The track landing is still its job's to finish (it is being filed): not one in flight. Counted,
    // the last track left the album at `making` for good, with nothing on the server (2026-10-06).
    await this.topUp(id, next, 1);
  }

  /** A track failed: skip it, and stop the album when several fail in a row. */
  async failed(id: string, refusal: { code: string; message: string } | null): Promise<void> {
    const count = (this.failures.get(id) ?? 0) + 1;
    this.failures.set(id, count);
    const meta = await this.hooks.meta(id);
    if (meta === null) return;
    if (count >= FAILURES_TO_STOP) {
      await this.hooks.update(id, { ...meta, stage: 'failed', refusal: refusal ?? { code: 'tracks_failed', message: `${count} tracks in a row failed.` } });
      return;
    }
    await this.topUp(id, meta);
  }

  /** Close every writing session open now (the app is quitting): the server is free at once, not after the idle time. */
  async closeSessions(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.close().catch(() => undefined)));
  }

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
      || (meta.ask.sung && meta.plan.tracks.some((track) => track.lyrics === null))
      || (meta.cover === null && meta.coverState !== 'failed' && meta.coverState !== 'no_model');
    const next = await this.recover(id, { ...meta, refusal: null, step: null });
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
    const redo: number[] = [];
    for (const [at, track] of meta.plan.tracks.entries()) {
      if (at >= meta.sent) break;
      const key = track.title.toLowerCase();
      const count = made.get(key) ?? 0;
      if (count > 0) made.set(key, count - 1);
      else if (!flying.has(at)) redo.push(at);
    }
    const madeS = songs.reduce((sum, song) => sum + (song.durationS ?? 0), 0);
    return { ...meta, madeS, redo };
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
    const page = await this.hooks.page(server);
    if (page === null) throw new Refusal('page_unreadable', `Could not read ${server.name}'s song page, so B-Sides cannot tell which model writes.`);
    if (page.tagModel === null) throw new Refusal('no_tag_model', page.tagModelReason ?? 'This server has no model to write with.');
    const model = page.tagModel;
    const client = this.hooks.client(server, true);
    // A chat never installs a model: a server without it starts installing and says so.
    const installing = await startInstall(client, model);
    if (installing !== null) throw new Refusal('model_installing', `The writing model is being set up on the server first: ${installing.message}`, 409);
    const concept: AlbumConcept = { title: plan.title, artist: plan.artist, blurb: plan.blurb, coverPrompt: plan.coverPrompt, core: plan.core ?? '' };
    const fresh = async (): Promise<AlbumMeta> => {
      const now = await this.hooks.meta(id);
      if (now === null || now.plan === null) throw new Refusal('album_missing', 'That album is gone.', 404);
      return now;
    };
    switch (piece) {
      case 'title': {
        const title = await newAlbumTitle(client, model, meta.ask, concept, [plan.title]);
        const now = await fresh();
        const next = { ...now, plan: { ...(now.plan as AlbumPlan), title } };
        await this.hooks.update(id, next, title);
        return next;
      }
      case 'artist': {
        const artist = await newArtist(client, model, meta.ask, concept, [meta.artist]);
        const now = await fresh();
        const next = { ...now, artist, plan: { ...(now.plan as AlbumPlan), artist } };
        await this.hooks.update(id, next);
        return next;
      }
      case 'cover': {
        const coverPrompt = await newCoverPrompt(client, model, meta.ask, concept);
        const now = await fresh();
        await this.hooks.update(id, { ...now, plan: { ...(now.plan as AlbumPlan), coverPrompt } });
        // The text model goes off the card first, as before an album's first cover: the painter needs it.
        await this.paint(id, server, client, coverPrompt);
        return fresh();
      }
      case 'track': {
        const track = at === undefined ? undefined : plan.tracks[at];
        if (at === undefined || track === undefined) throw new Refusal('track_missing', 'That album has no such track.', 404);
        const [title] = await newTrackTitles(client, model, meta.ask, concept, 1, plan.tracks.map((t) => t.title));
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

  /** Stop making it: no more tracks, and the ones on the server are cancelled. What is made stays. */
  async stop(id: string): Promise<void> {
    const meta = await this.hooks.meta(id);
    if (meta !== null && meta.stage !== 'done') await this.hooks.update(id, { ...meta, stage: 'stopped' });
    await this.hooks.cancelInFlight(id);
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
        if (meta.stage === 'making') await this.topUp(id, meta);
        return;
      }
      // An album from before the cover moved behind the tracks may stand at `cover`: carry on making.
      if (meta.stage === 'cover') {
        meta = { ...meta, stage: 'making' };
        await this.hooks.update(id, meta);
      }
      if (meta.stage === 'making') {
        // Tracks that were on the server when the app closed and are gone now: made again.
        meta = await this.recover(id, meta);
        await this.hooks.update(id, meta);
        await this.topUp(id, meta);
      }
    } catch (error) {
      const current = await this.hooks.meta(id);
      if (current !== null) await this.hooks.update(id, { ...current, stage: 'failed', refusal: refusalOf(error) });
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
    // Its own client name: Crucible counts every request from the session's name as one of its
    // items, and removes the ones still waiting when it closes. Under the install's own name, a song
    // made meanwhile would join the album's session and be dropped with it.
    const session = await this.hooks.client(server, true).session({ act: 'generate', idleS: SESSION_IDLE_S });
    this.sessions.set(id, session);
    meta = { ...(await this.hooks.meta(id) ?? meta), session: session.id };
    await this.hooks.update(id, meta);
    let open = true;
    const release = async (): Promise<void> => {
      if (!open) return;
      open = false;
      this.sessions.delete(id);
      await session.close().catch((err: unknown) => console.error(`[albums] could not close the session for ${id}:`, err));
      const now = await this.hooks.meta(id);
      if (now !== null && now.session === session.id) await this.hooks.update(id, { ...now, session: null });
    };
    try {
      // The plan and the lyrics ride the session, so the text model stays loaded between calls.
      const client = session;
      const page = await this.hooks.page(server);
      if (page === null) throw new Refusal('page_unreadable', `Could not read ${server.name}'s song page, so B-Sides cannot tell which model writes.`);
      if (page.tagModel === null) throw new Refusal('no_tag_model', page.tagModelReason ?? 'This server has no tag model to write an album with.');
      const model = page.tagModel;
      // A plan from before v2 was written whole, in one call: its own length is its count.
      const count = meta.plan == null ? trackCount(meta.ask.minutes) : (meta.plan.trackCount ?? meta.plan.tracks.length);
      const show = async (step: AlbumMeta['step']): Promise<void> => {
        meta = { ...(await this.hooks.meta(id) ?? meta), step };
        await this.hooks.update(id, meta);
      };
      await installModel(client, model, (detail) => show({ kind: 'install', done: 0, of: 0, detail }));
      await loadWriter(client, model, () => show({ kind: 'load', done: 0, of: 0, detail: model }));
      const plans = batches(count);
      // [album]: the concept, kept at once (a restart carries on from it).
      let plan: AlbumPlan;
      if (meta.plan == null) {
        await show({ kind: 'plan', done: 0, of: plans.length + 1 });
        const concept = await writeAlbum(client, model, meta.ask, count, page);
        plan = { ...concept, tracks: [], trackCount: count };
        meta = { ...(await this.hooks.meta(id) ?? meta), writer: model, plan, artist: plan.artist, blurb: plan.blurb };
        await this.hooks.update(id, meta, plan.title);
      } else {
        plan = meta.plan;
      }
      const concept: AlbumConcept = { title: plan.title, artist: plan.artist, blurb: plan.blurb, coverPrompt: plan.coverPrompt, core: plan.core ?? '' };
      // [tracks], fifteen at a time, each batch told every title so far.
      for (const [at, [first, last]] of plans.entries()) {
        if (plan.tracks.length >= last) continue;
        if (await this.halted(id)) return meta;
        await show({ kind: 'plan', done: at + 1, of: plans.length + 1 });
        const from = plan.tracks.length + 1;
        const turns = await writeTracks(client, model, meta.ask, concept, from, last, count, page, plan.tracks.map((track) => track.title));
        const written = turns.map((track): AlbumTrack => ({ title: track.title, tags: trackTags(concept.core, track.turn, meta.ask.sung), lyrics: null }));
        plan = { ...plan, tracks: [...plan.tracks, ...written] };
        meta = { ...(await this.hooks.meta(id) ?? meta), writer: model, plan };
        await this.hooks.update(id, meta);
        // An album begun before this order made its first tracks before the plan: they take its first names.
        const early = meta.openers ?? 0;
        if (first === 1 && early > 0) await this.hooks.retitle(id, plan.tracks.slice(0, early).map((track) => track.title));
      }
      if (meta.ask.sung) {
        const early = meta.openers ?? 0;
        const sungAt = plan.tracks.map((_, at) => at).filter((at) => at >= early);
        // [lyrics], one call per track, each kept as it comes (a restart carries on). The stand-in
        // lyricist, when chosen, writes them instead, told the whole track list for a through-line.
        const lyricist = this.hooks.lyricist();
        for (const [done, at] of sungAt.entries()) {
          const track = plan.tracks[at] as AlbumTrack;
          if (track.lyrics !== null) continue;
          if (await this.halted(id)) return meta;
          await show({ kind: 'lyrics', done, of: sungAt.length });
          const written = lyricist === null
            ? await writeSongLyrics(client, model, meta.ask, concept, track.title, track.tags)
            : await lyricist.write({
              title: track.title,
              tags: track.tags,
              about: aboutOf(meta.ask),
              brief: meta.ask.lyrics ?? '',
              album: { title: concept.title, artist: concept.artist, blurb: concept.blurb, tracks: plan.tracks.map((t) => t.title), at },
            });
          const lyrics = layLyrics(written);
          plan = { ...plan, tracks: plan.tracks.map((t, i) => (i === at ? { ...t, lyrics } : t)) };
          meta = { ...(await this.hooks.meta(id) ?? meta), plan, lyricsBy: lyricist?.name ?? null };
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
      await mark({ cover, coverState: null });
      if (before !== null && before !== cover) await this.hooks.removeCover(before);
    } catch (error) {
      // A cover that will not paint leaves the drawn one; the music matters more.
      console.error(`[albums] the cover for ${id} did not paint:`, error);
      await mark({ coverState: 'failed' });
    }
  }

  /** Keep two tracks on the server until the album passes its length or runs out of plan. */
  private async topUp(id: string, meta: AlbumMeta, landing = 0): Promise<void> {
    if (meta.stage !== 'making' || meta.plan === null) return;
    const target = meta.ask.minutes * 60;
    let sent = meta.sent;
    const redo = [...(meta.redo ?? [])];
    let flying = Math.max(0, this.hooks.inFlight(id) - landing);
    const server = this.hooks.server(meta.server);
    // A track to make again goes first; it was part of the album before the length was reached.
    while (flying < AHEAD && (redo.length > 0 || (sent < meta.plan.tracks.length && meta.madeS + flying * TYPICAL_TRACK_S < target))) {
      const at = redo.length > 0 ? (redo.shift() as number) : sent++;
      const track = meta.plan.tracks[at] as AlbumTrack;
      const sung = meta.ask.sung && track.lyrics !== null;
      this.hooks.render(id, at, server, {
        tags: track.tags,
        instrumental: !sung,
        ...(sung ? { lyrics: track.lyrics as string } : {}),
        ...(meta.ask.cfg != null ? { cfg: meta.ask.cfg } : {}),
      });
      flying += 1;
    }
    const finished = flying === 0 && redo.length === 0 && (meta.madeS >= target || sent >= meta.plan.tracks.length);
    if (sent !== meta.sent || redo.length !== (meta.redo ?? []).length || finished) {
      await this.hooks.update(id, { ...meta, sent, redo, stage: finished ? 'done' : meta.stage });
    }
  }
}
