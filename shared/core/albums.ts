/**
 * albums — Make → Album: one description becomes a whole record (Owen,
 * 2026-10-04).
 *
 *   plan     the server's best chat model writes the album in ONE call: title,
 *            artist, a line about it, the cover prompt, and a track list (each
 *            track a name and its own turn on the album's tags).
 *   lyrics   a sung album: the same model writes each track's lyrics, a few
 *            tracks per call, all before the first song (on a one-card server
 *            every chat swaps the song model out, so the writing is done in one
 *            stretch, never between songs).
 *   cover    the server's image model paints the cover.
 *   tracks   rendered in order, two at a time, until the album passes its
 *            length; each one is filed straight into the album under its name.
 *
 * The album IS a playlist (with `album` details beside it), so it plays, lists
 * and deletes like one, and it fills in while you listen. Every step's progress
 * is written to the playlist, so an album being made when the hub stops carries
 * on when it starts again.
 */
import type { CrucibleClient, ModelInfo } from '@crucible/client';

import { clientFor } from './crucible';
import { Refusal, refusalOf } from './refusal';
import type { StoredServer } from './servers';
import type { AlbumAsk, AlbumMeta, AlbumPlan, AlbumTrack, SongPage } from '../types';

/** A song is about this long; a plan has enough tracks to pass its length with room to spare. */
const TYPICAL_TRACK_S = 150;
const MOST_TRACKS = 40;
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
  return Math.min(MOST_TRACKS, Math.ceil((minutes * 60) / TYPICAL_TRACK_S) + 3);
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'artist', 'blurb', 'coverPrompt', 'tracks'],
  properties: {
    title: { type: 'string' },
    artist: { type: 'string' },
    blurb: { type: 'string' },
    coverPrompt: { type: 'string' },
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'tags'],
        properties: { title: { type: 'string' }, tags: { type: 'string' } },
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
    `Make exactly ${count} tracks. ${ask.sung ? 'The album is sung (a singer, with lyrics written later).' : 'The album is instrumental: no vocals.'}`,
    'title: a creative album title, 1-5 words, not generic.',
    'artist: an invented band or artist name that fits the sound, not a real artist.',
    'blurb: one sentence about the record, like a liner note.',
    'coverPrompt: a vivid description of the album cover art for an image model: subject, colours, style, mood. No words, letters or text in the image.',
    'tracks: each title is a creative song name (no numbering). Each tags is a comma-separated list of style tags for that track:',
    '  keep the album\'s core genre and sound on every track, and give each track its own turn (tempo, mood, one instrument or texture) so the record hangs together without repeating itself.',
    ask.sung ? '  include a vocal tag on each sung track (for example soft female voice, raspy male vocal).' : '  every track is instrumental: end each tags list with "instrumental".',
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
  let parsed: { title: string; artist: string; blurb: string; coverPrompt: string; tracks: { title: string; tags: string }[] };
  try {
    parsed = JSON.parse(answer.content) as typeof parsed;
  } catch {
    throw new Refusal('plan_unreadable', `${writer} answered something that was not an album plan; make it again.`);
  }
  const tracks = parsed.tracks
    .filter((t) => typeof t.title === 'string' && t.title.trim() !== '' && typeof t.tags === 'string')
    .map((t): AlbumTrack => ({ title: t.title.trim(), tags: t.tags.trim(), lyrics: null }));
  if (tracks.length === 0) throw new Refusal('plan_empty', `${writer} planned no tracks; make it again.`);
  return {
    title: parsed.title.trim() || 'Untitled',
    artist: parsed.artist.trim() || 'Unknown Artist',
    blurb: parsed.blurb.trim(),
    coverPrompt: parsed.coverPrompt.trim(),
    tracks,
  };
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
  paint(id: string, server: StoredServer, model: string, prompt: string): Promise<string>;
  /** Send one track to the server, tagged with its album and place. */
  render(id: string, track: number, server: StoredServer, params: { tags: string; lyrics?: string; instrumental: boolean }): void;
  /** How many of this album's tracks are on the server and not ended. */
  inFlight(id: string): number;
  /** Cancel this album's tracks still on the server. */
  cancelInFlight(id: string): Promise<void>;
}

/**
 * Runs every album being made: one chain of steps per album, each step written
 * to the album before the next begins.
 */
export class AlbumMaker {
  private readonly running = new Set<string>();
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
      const client = clientFor(server);
      if (meta.stage === 'planning') {
        const writer = meta.writer ?? (await chooseWriter(client));
        let plan = meta.plan ?? (await writePlan(client, writer, meta.ask, await this.hooks.page(server)));
        meta = { ...meta, writer, plan, artist: plan.artist, blurb: plan.blurb };
        await this.hooks.update(id, meta, plan.title);
        if (meta.ask.sung) {
          for (let at = 0; at < plan.tracks.length; at += LYRICS_PER_CALL) {
            const batch = plan.tracks.slice(at, at + LYRICS_PER_CALL);
            if (batch.every((t) => t.lyrics !== null)) continue;
            const lyrics = await writeLyrics(client, writer, plan, meta.ask, batch);
            plan = {
              ...plan,
              tracks: plan.tracks.map((t, i) => (i >= at && i < at + LYRICS_PER_CALL ? { ...t, lyrics: lyrics.get(t.title.toLowerCase()) ?? t.lyrics } : t)),
            };
            meta = { ...meta, plan };
            await this.hooks.update(id, meta);
            if ((await this.hooks.meta(id)) === null) return;
          }
        }
        meta = { ...meta, stage: 'cover' };
        await this.hooks.update(id, meta);
      }
      if (meta.stage === 'cover') {
        const model = await chooseCoverModel(client);
        let cover: string | null = meta.cover;
        if (model !== null && meta.plan !== null && cover === null) {
          try {
            cover = await this.hooks.paint(id, server, model, `${meta.plan.coverPrompt}. Square album cover art, no text, no letters, no words.`);
          } catch (error) {
            // A cover that will not paint leaves the drawn one; the music matters more.
            console.error(`[albums] the cover for ${id} did not paint:`, error);
          }
        }
        meta = { ...meta, cover, stage: 'making' };
        await this.hooks.update(id, meta);
      }
      if (meta.stage === 'making') await this.topUp(id, meta);
    } catch (error) {
      const current = await this.hooks.meta(id);
      if (current !== null) await this.hooks.update(id, { ...current, stage: 'failed', refusal: refusalOf(error) });
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
      this.hooks.render(id, sent, server, { tags: track.tags, instrumental: !sung, ...(sung ? { lyrics: track.lyrics as string } : {}) });
      sent += 1;
      flying += 1;
    }
    const finished = flying === 0 && (meta.madeS >= target || sent >= meta.plan.tracks.length);
    if (sent !== meta.sent || finished) {
      await this.hooks.update(id, { ...meta, sent, stage: finished ? 'done' : meta.stage });
    }
  }
}
