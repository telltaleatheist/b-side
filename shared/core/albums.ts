/**
 * albums — Make → Album: one description becomes a whole record (Owen,
 * 2026-10-04).
 *
 *   plan     the server's best chat model writes the album in ONE call: title,
 *            artist, a line about it, the cover prompt, and a track list (each
 *            track a name and its own turn on the album's tags).
 *   lyrics   a sung album: B-Sides' own lyrics model (TAG_MODEL, the 4B fine-tuned
 *            on describe answers) writes each track's words, one call per track. The plan has a track for every two minutes of
 *            the length (songs run two to five), so there are always words enough;
 *            tracks play in order until the length is filled and the rest go unmade.
 *            A track the lyrics model cannot write falls back to the album's writer.
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
import type { CrucibleClient, CrucibleSession, ModelInfo } from '@crucible/client';

import { clientFor, clientName } from './crucible';
import { Refusal, refusalOf } from './refusal';
import type { StoredServer } from './servers';
import { describe } from './describe';
import type { AlbumAsk, AlbumMeta, AlbumPlan, AlbumTrack, SongPage } from '../types';

/** A song is about this long: how many are counted as on their way. */
const TYPICAL_TRACK_S = 150;
/** Songs run two to five minutes: the plan has a track per shortest song, so the length is always filled. */
const SHORTEST_TRACK_S = 120;
const MOST_TRACKS = 45;
/** A writing session closes after this long with nothing asked (the cover's paint counts as asking). */
const SESSION_IDLE_S = 180;
/** Tracks whose lyrics are written per call. */
const LYRICS_PER_CALL = 4;
/** Songs on the server at once for one album: one rendering, one waiting. */
const AHEAD = 2;
/** This many failed tracks in a row stops the album. */
const FAILURES_TO_STOP = 3;
/** The chat model to write with: the biggest text model the server has and can load. */
export async function chooseWriter(client: CrucibleClient): Promise<string> {
  let models: ModelInfo[];
  try {
    models = await client.models();
  } catch (error) {
    throw new Refusal('writer_unknown', `Could not ask the server which chat models it has: ${refusalOf(error).message}`);
  }
  const usable = models
    .filter((m) => m.installed && m.loadable && m.family.startsWith('qwen') && !/ocr|embed|rerank/i.test(m.id))
    .sort((a, b) => b.paramsB - a.paramsB);
  const best = usable[0];
  if (best === undefined) {
    throw new Refusal('no_writer', 'This server has no chat model installed to write an album with (it needs a qwen model).');
  }
  return best.id;
}

/** The image model to paint the cover with, or null when the server has none ready. */
export async function chooseCoverModel(client: CrucibleClient): Promise<string | null> {
  const pages = await client.playground();
  return pages.find((page) => page.jobType === 'image' && page.available)?.id ?? null;
}

function trackCount(minutes: number): number {
  return Math.min(MOST_TRACKS, Math.ceil((minutes * 60) / SHORTEST_TRACK_S));
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'artist', 'blurb', 'coverPrompt', 'core', 'tracks'],
  properties: {
    title: { type: 'string' },
    artist: { type: 'string' },
    blurb: { type: 'string' },
    coverPrompt: { type: 'string' },
    core: { type: 'string' },
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'turn'],
        properties: { title: { type: 'string' }, turn: { type: 'string' } },
      },
    },
  },
} as const;

const LYRICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['songs'],
  properties: {
    songs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'lyrics'],
        properties: { title: { type: 'string' }, lyrics: { type: 'string' } },
      },
    },
  },
} as const;

function planPrompt(ask: AlbumAsk, count: number, page: SongPage | null): string {
  const vocabulary = page === null
    ? ''
    : `\nStyle words the singer model knows (examples, not a closed list): ${page.suggestions.flatMap((group) => group.tags).slice(0, 120).join(', ')}.`;
  return [
    'You plan a whole music album for an AI music model (YuE). Reply with JSON only.',
    `Make exactly ${count} tracks. ${ask.sung ? 'The album is sung: every track has a singer (the lyrics are written later).' : 'The album is instrumental: no vocals.'}`,
    'title: a creative album title, 1-5 words, not generic.',
    'artist: an invented band or artist name that fits the sound, not a real artist.',
    'blurb: one sentence about the record, like a liner note.',
    'coverPrompt: a vivid description of the album cover art for an image model: subject, colours, style, mood. The art must carry NO writing of any kind, in any language or script: so describe no signs, neon signs, shop fronts, posters, billboards, books, newspapers, screens, labels, banners, graffiti, tattoos, logos or anything else that would show letters, numbers or symbols. Never name the album or artist in it.',
    ask.tags.length > 0
      ? `core: repeat exactly these tags, which every track keeps unchanged: ${ask.tags.join(', ')}`
      : 'core: the album\'s sound as 6-12 comma-separated style tags (genre, mood, instruments, tempo), kept on every track.',
    'tracks: each title is a creative song name (no numbering). Each turn is 2-4 comma-separated style tags ADDED to the core for that track only (a tempo, a mood, one instrument or texture), so the record hangs together without repeating itself. Never contradict the core.',
    ask.sung ? '  on each sung track, the turn includes a vocal tag (for example soft female voice, raspy male vocal).' : '  the album is instrumental: no vocal tags in any turn.',
    vocabulary,
  ].join('\n');
}

function lyricsPrompt(): string {
  return [
    'You write song lyrics for an AI singer (YuE). Reply with JSON only: {"songs":[{"title","lyrics"}]}, one entry per song asked for, same titles.',
    'Each lyrics uses only these section tags, each on its own line: [verse], [chorus], [bridge], [outro].',
    'Structure: [verse] [chorus] [verse] [chorus] [bridge] [chorus]. Four lines per section.',
    'Keep lines a similar length (6-9 syllables) so they sing well. Put the song\'s title, or a phrase from it, in the chorus.',
    'Concrete images, no cliches ("heart of gold", "dancing in the rain"), light rhyme, natural rhythm.',
  ].join('\n');
}

/** The album's plan, from the writer, in one call. */
export async function writePlan(client: CrucibleClient, writer: string, ask: AlbumAsk, page: SongPage | null): Promise<AlbumPlan> {
  const count = trackCount(ask.minutes);
  const wanted = [ask.description.trim(), ask.tags.length > 0 ? `Tags: ${ask.tags.join(', ')}` : ''].filter((x) => x !== '').join('\n');
  const answer = await client.chat({
    model: writer,
    thinking: false,
    temperature: 0.9,
    maxTokens: 400 + count * 70,
    act: 'generate',
    responseFormat: { type: 'json_schema', json_schema: { name: 'album_plan', schema: PLAN_SCHEMA, strict: true } },
    messages: [
      { role: 'system', content: planPrompt(ask, count, page) },
      { role: 'user', content: wanted === '' ? 'Surprise me.' : wanted },
    ],
  });
  if (answer.finishReason === 'length') throw new Refusal('plan_truncated', `${writer} ran out of room planning the album; make it again.`);
  let parsed: { title: string; artist: string; blurb: string; coverPrompt: string; core: string; tracks: { title: string; turn: string }[] };
  try {
    parsed = JSON.parse(answer.content) as typeof parsed;
  } catch {
    throw new Refusal('plan_unreadable', `${writer} answered something that was not an album plan; make it again.`);
  }
  // The person's tags ARE the sound (a preset, picked chips): the writer only adds each track's turn.
  const core = ask.tags.length > 0 ? ask.tags.join(', ') : (typeof parsed.core === 'string' ? parsed.core.trim() : '');
  const tracks = parsed.tracks
    .filter((t) => typeof t.title === 'string' && t.title.trim() !== '')
    .map((t): AlbumTrack => ({
      title: t.title.trim(),
      tags: trackTags(core, typeof t.turn === 'string' ? t.turn : '', ask.sung),
      lyrics: null,
    }));
  if (tracks.length === 0) throw new Refusal('plan_empty', `${writer} planned no tracks; make it again.`);
  return {
    title: parsed.title.trim() || 'Untitled',
    artist: parsed.artist.trim() || 'Unknown Artist',
    blurb: parsed.blurb.trim(),
    coverPrompt: parsed.coverPrompt.trim(),
    core,
    tracks,
  };
}

/** A track's tags: the core, then its turn's new tags (none repeated); instrumental unless it is sung. */
export function trackTags(core: string, turn: string, sung: boolean): string {
  const tags = core.split(',').map((t) => t.trim()).filter((t) => t !== '');
  const seen = new Set(tags.map((t) => t.toLowerCase()));
  for (const extra of turn.split(',').map((t) => t.trim()).filter((t) => t !== '')) {
    if (seen.has(extra.toLowerCase())) continue;
    if (!sung && /vocal|voice|singing|sung|choir/i.test(extra)) continue;
    seen.add(extra.toLowerCase());
    tags.push(extra);
  }
  const vocalFree = /(^|, )(instrumental|no vocals)(,|$)/i;
  if (sung) return tags.filter((t) => !/^(instrumental|no vocals|no singing)$/i.test(t)).join(', ');
  return vocalFree.test(tags.join(', ')) ? tags.join(', ') : [...tags, 'instrumental'].join(', ');
}

/** Lyrics for some of a plan's tracks, by title. */
export async function writeLyrics(client: CrucibleClient, writer: string, plan: AlbumPlan, ask: AlbumAsk, tracks: readonly AlbumTrack[]): Promise<Map<string, string>> {
  const asked = tracks.map((t) => `- "${t.title}" (${t.tags})`).join('\n');
  const answer = await client.chat({
    model: writer,
    thinking: false,
    temperature: 0.9,
    maxTokens: 300 * tracks.length + 200,
    act: 'generate',
    responseFormat: { type: 'json_schema', json_schema: { name: 'album_lyrics', schema: LYRICS_SCHEMA, strict: true } },
    messages: [
      { role: 'system', content: lyricsPrompt() },
      {
        role: 'user',
        content: `Album: "${plan.title}" by ${plan.artist}. ${plan.blurb}\nWhat it is about: ${ask.description || ask.tags.join(', ')}\nWrite lyrics for:\n${asked}`,
      },
    ],
  });
  if (answer.finishReason === 'length') throw new Refusal('lyrics_truncated', `${writer} ran out of room writing lyrics; make the album again.`);
  const parsed = JSON.parse(answer.content) as { songs: { title: string; lyrics: string }[] };
  const found = new Map<string, string>();
  for (const song of parsed.songs) {
    if (typeof song.lyrics === 'string' && song.lyrics.trim() !== '') found.set(song.title.trim().toLowerCase(), song.lyrics.trim());
  }
  return found;
}

/**
 * One sung track's lyrics from B-Sides' own lyrics model: the same describe call
 * the Make page uses, asked for this track (the album, its title, its sound).
 * Null when it wrote none, so the album's writer can take the track instead.
 */
export async function lyricsFor(client: CrucibleClient, page: SongPage, plan: AlbumPlan, ask: AlbumAsk, track: AlbumTrack): Promise<string | null> {
  const about = (ask.description.trim() || plan.blurb).slice(0, 240);
  const request = `A song called "${track.title}" from the album "${plan.title}" by ${plan.artist}. ${about} Sound: ${track.tags}`.slice(0, 580);
  try {
    const written = await describe(client, page, request, false);
    return written.lyrics;
  } catch (error) {
    console.error(`[albums] the lyrics model did not write "${track.title}":`, error);
    return null;
  }
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
  /** The song page, for the writer's vocabulary (null when it cannot be read). */
  page(server: StoredServer): Promise<SongPage | null>;
  /** Paint the cover and file it beside the album; answers its file name. */
  paint(id: string, server: StoredServer, client: CrucibleClient, model: string, prompt: string): Promise<string>;
  /** Send one track to the server, tagged with its album and place. */
  render(id: string, track: number, server: StoredServer, params: { tags: string; lyrics?: string; instrumental: boolean; cfg?: number }): void;
  /** How many of this album's tracks are on the server and not ended. */
  inFlight(id: string): number;
  /** Name the album's first songs (made before the plan had names), in order. */
  retitle(id: string, titles: readonly string[]): Promise<void>;
  /** Cancel this album's tracks still on the server. */
  cancelInFlight(id: string): Promise<void>;
}

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

  /** A track landed in the album: count its length and send the next. */
  async landed(id: string, seconds: number | null): Promise<void> {
    this.failures.set(id, 0);
    const meta = await this.hooks.meta(id);
    if (meta === null) return;
    const next: AlbumMeta = { ...meta, madeS: meta.madeS + (seconds ?? 0) };
    await this.hooks.update(id, next);
    await this.topUp(id, next);
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
      if (meta.stage === 'making') await this.topUp(id, meta);
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
      await clientFor(server).closeSession(meta.session).catch(() => undefined);
      meta = { ...meta, session: null };
      await this.hooks.update(id, meta);
    }
    // Its own client name: Crucible counts every request from the session's name as one of its
    // items, and removes the ones still waiting when it closes. Under the install's own name, a song
    // made meanwhile would join the album's session and be dropped with it.
    const session = await clientFor(server, `${clientName()}/album`).session({ act: 'generate', idleS: SESSION_IDLE_S });
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
      if (meta.plan == null) {
        meta = { ...meta, step: { kind: 'plan', done: 0, of: 1 } };
        await this.hooks.update(id, meta);
      }
      const writer = meta.writer ?? (await chooseWriter(client));
      let plan = meta.plan ?? (await writePlan(client, writer, meta.ask, await this.hooks.page(server)));
      meta = { ...(await this.hooks.meta(id) ?? meta), writer, plan, artist: plan.artist, blurb: plan.blurb };
      await this.hooks.update(id, meta, plan.title);
      // An album begun before this order made its first tracks before the plan: they take its first names.
      const early = meta.openers ?? 0;
      if (early > 0) await this.hooks.retitle(id, plan.tracks.slice(0, early).map((track) => track.title));
      if (meta.ask.sung) {
        const sungAt = plan.tracks.map((_, at) => at).filter((at) => at >= early);
        const page = await this.hooks.page(server);
        // One call per track with the lyrics model, each kept as it comes (a restart carries on).
        for (const [done, at] of sungAt.entries()) {
          if ((plan.tracks[at] as AlbumTrack).lyrics !== null) continue;
          if (await this.halted(id)) return meta;
          meta = { ...(await this.hooks.meta(id) ?? meta), plan, step: { kind: 'lyrics', done, of: sungAt.length } };
          await this.hooks.update(id, meta);
          const written = page === null ? null : await lyricsFor(client, page, plan, meta.ask, plan.tracks[at] as AlbumTrack);
          if (written === null) continue;
          plan = { ...plan, tracks: plan.tracks.map((t, i) => (i === at ? { ...t, lyrics: written } : t)) };
          if (await this.halted(id)) return meta;
        }
        // The tracks it could not write: the album's writer, a few per call.
        const missed = sungAt.filter((at) => (plan.tracks[at] as AlbumTrack).lyrics === null);
        for (let from = 0; from < missed.length; from += LYRICS_PER_CALL) {
          const batch = missed.slice(from, from + LYRICS_PER_CALL);
          const lyrics = await writeLyrics(client, writer, plan, meta.ask, batch.map((at) => plan.tracks[at] as AlbumTrack));
          plan = { ...plan, tracks: plan.tracks.map((t, i) => (batch.includes(i) ? { ...t, lyrics: lyrics.get(t.title.toLowerCase()) ?? t.lyrics } : t)) };
        }
        meta = { ...(await this.hooks.meta(id) ?? meta), plan };
        await this.hooks.update(id, meta);
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
        await this.paint(id, server, clientFor(server, `${clientName()}/album`), plan.coverPrompt);
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
      const cover = await this.hooks.paint(id, server, client, model, coverPrompt(prompt));
      await mark({ cover, coverState: null });
    } catch (error) {
      // A cover that will not paint leaves the drawn one; the music matters more.
      console.error(`[albums] the cover for ${id} did not paint:`, error);
      await mark({ coverState: 'failed' });
    }
  }

  /** Keep two tracks on the server until the album passes its length or runs out of plan. */
  private async topUp(id: string, meta: AlbumMeta): Promise<void> {
    if (meta.stage !== 'making' || meta.plan === null) return;
    const target = meta.ask.minutes * 60;
    let sent = meta.sent;
    let flying = this.hooks.inFlight(id);
    const server = this.hooks.server(meta.server);
    while (flying < AHEAD && sent < meta.plan.tracks.length && meta.madeS + flying * TYPICAL_TRACK_S < target) {
      const track = meta.plan.tracks[sent] as AlbumTrack;
      const sung = meta.ask.sung && track.lyrics !== null;
      this.hooks.render(id, sent, server, {
        tags: track.tags,
        instrumental: !sung,
        ...(sung ? { lyrics: track.lyrics as string } : {}),
        ...(meta.ask.cfg != null ? { cfg: meta.ask.cfg } : {}),
      });
      sent += 1;
      flying += 1;
    }
    const finished = flying === 0 && (meta.madeS >= target || sent >= meta.plan.tracks.length);
    if (sent !== meta.sent || finished) {
      await this.hooks.update(id, { ...meta, sent, stage: finished ? 'done' : meta.stage });
    }
  }
}
