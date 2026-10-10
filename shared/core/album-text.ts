/**
 * album-text — every text call an album makes, to B-Sides' own model (qwen3.5-4b-bside v2),
 * one task at a time (Owen, 2026-10-10: "we cant expect it to hold big contexts"):
 *
 *   [album]         the concept: title, artist, blurb, cover description, core sound
 *   [tracks]        the track list, 15 at a time, each batch told every title so far
 *   [lyrics]        one sung track's words
 *   [album title] [artist] [track titles] [cover]   one piece again, for the regenerate buttons
 *
 * The model was trained on EXACTLY these strings, so they are a contract, not prose to
 * improve: orpheus-finetune `pipeline/lyrics/v2/tasks.py` is the single source, rendered in
 * E:/claude-files/keep/lyrics-ft/v2/B-SIDES-CONTRACT.md. test/album-text.test.ts compares
 * every builder here with tasks.py's output byte for byte (test/fixtures/v2-contract.json,
 * made by tools/v2-contract-fixtures.py); change one side and that test says so.
 *
 * The task tag is the first line of the user message. Every call: thinking off, json_schema
 * strict, a fresh seed; temperature 0.9 (describe, in describe.ts, is 0.5).
 */
import type { CrucibleClient } from '@crucible/client';

import { chatSeed } from './crucible';
import { Refusal } from './refusal';
import type { AlbumAsk, SongPage } from '../types';

/** Tracks per [tracks] call; 30/60/90 minutes are 15/30/45 tracks. */
export const TRACK_BATCH = 15;
/** A tempo the way the generator and validator test for one: numeric BPM only. */
export const BPM = /\b\d{2,3}\s*BPM\b/i;

const TEMPERATURE = 0.9;
/** Answer caps (the training set none; its longest answers: album ~250, tracks ~700, lyrics ~450 tokens). */
const MAX_TOKENS = { album: 600, tracks: 1250, lyrics: 700, piece: 200 } as const;

/** What [album] answers: the concept every later call is told. */
export interface AlbumConcept {
  readonly title: string;
  readonly artist: string;
  readonly blurb: string;
  readonly coverPrompt: string;
  readonly core: string;
}

/** One planned track as [tracks] answers it: its name and its turn (the tags it adds to the core). */
export interface TrackTurn {
  readonly title: string;
  readonly turn: string;
}

// ── the strings (ports of tasks.py; keep them byte-identical) ────────────────────────────

const COVER_RULE =
  'coverPrompt: a vivid description of the album cover art for an image model: subject, colours, style, mood. The art must carry '
  + 'NO writing of any kind, in any language or script: so describe no signs, neon signs, shop fronts, posters, billboards, books, '
  + 'newspapers, screens, labels, banners, graffiti, tattoos, logos or anything else that would show letters, numbers or symbols. '
  + 'Never name the album or artist in it.';

const NO_WRITING =
  'The art must carry NO writing of any kind, in any language or script: so describe no signs, neon signs, shop fronts, '
  + 'posters, billboards, books, newspapers, screens, labels, banners, graffiti, tattoos, logos or anything else that would '
  + 'show letters, numbers or symbols. Never name the album or artist in it.';

/** The song page's vocabulary as one line: every group's tags in order, the first 120. Empty without a page. */
export function vocabLine(page: SongPage | null): string {
  if (page === null) return '';
  return `Style words the singer model knows (examples, not a closed list): ${page.suggestions.flatMap((group) => group.tags).slice(0, 120).join(', ')}.`;
}

export function albumPrompt(ask: AlbumAsk, count: number, page: SongPage | null): string {
  const lines = [
    'You plan a music album for an AI music model (YuE): its title, artist, liner note, cover and core sound. Reply with JSON only.',
    `The album will have ${count} tracks. ${ask.sung ? 'It is sung: every track has a singer.' : 'It is instrumental: no vocals.'}`,
  ];
  if (ask.sung && ask.lyrics) lines.push(`The lyrics will be: ${ask.lyrics}. Let the title fit them.`);
  lines.push(
    'title: a creative album title, 1-5 words, not generic.',
    'artist: an invented band or artist name that fits the sound, not a real artist.',
    'blurb: one sentence about the record, like a liner note.',
    COVER_RULE,
    ask.tags.length > 0
      ? `core: repeat exactly these tags, which every track keeps unchanged: ${ask.tags.join(', ')}`
      : "core: the album's sound as 6-12 comma-separated style tags (genre, mood, instruments, production). No tempo: each track sets its own.",
    vocabLine(page),
  );
  return lines.filter((line) => line !== '').join('\n');
}

/** [album]'s user content (after the tag line): the description and the tags, or "Surprise me.". */
export function albumUser(ask: AlbumAsk): string {
  const wanted = [ask.description.trim(), ask.tags.length > 0 ? `Tags: ${ask.tags.join(', ')}` : ''].filter((part) => part !== '').join('\n');
  return wanted === '' ? 'Surprise me.' : wanted;
}

export function tracksPrompt(sung: boolean, core: string, first: number, last: number, count: number, page: SongPage | null): string {
  const coreTempo = BPM.test(core);
  const lines = [
    `You write the track list of a music album for an AI music model (YuE), up to ${TRACK_BATCH} tracks at a time. Reply with JSON only: {"tracks": [{"title", "turn"}]}.`,
    `Write tracks ${first}-${last} of ${count}, in order.`,
    'title: a creative song name (no numbering), never one already on the album.',
    `turn: 2-4 comma-separated style tags ADDED to the core for that track only (a mood, one instrument or texture${coreTempo ? ')' : ', its tempo)'}, so the record hangs together without repeating itself. Never contradict the core.`,
    coreTempo ? 'The core sets the tempo: no turn adds one.' : 'Each turn includes exactly one tempo, written "<number> BPM", chosen for that track.',
    sung ? 'On each sung track, the turn includes a vocal tag (for example soft female voice, raspy male vocal).' : 'The album is instrumental: no vocal tags in any turn.',
    `Shape the record: track 1 opens it, track ${count} closes it, and the tracks between move through it.`,
    vocabLine(page),
  ];
  return lines.filter((line) => line !== '').join('\n');
}

/** What the album is about, for [tracks] and [lyrics]: the description, else the tags, else "(none)". */
export function aboutOf(ask: AlbumAsk): string {
  return ask.description.trim() || ask.tags.join(', ') || '(none)';
}

export function tracksUser(ask: AlbumAsk, album: AlbumConcept, previous: readonly string[]): string {
  const lines = [`Album: "${album.title}" by ${album.artist}. ${album.blurb}`, `About: ${aboutOf(ask)}`];
  if (ask.sung && ask.lyrics) lines.push(`The lyrics: ${ask.lyrics}`);
  lines.push(`Core: ${album.core}`);
  if (previous.length > 0) lines.push(`Already on the album: ${previous.map((title, at) => `${at + 1}. "${title}"`).join('; ')}`);
  return lines.join('\n');
}

/** [first, last] 1-based, TRACK_BATCH at a time: 15 → [[1,15]], 45 → [[1,15],[16,30],[31,45]]. */
export function batches(count: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let first = 1; first <= count; first += TRACK_BATCH) out.push([first, Math.min(first + TRACK_BATCH - 1, count)]);
  return out;
}

export function lyricsPrompt(): string {
  return [
    'You write song lyrics for an AI singer (YuE). Reply with JSON only: {"lyrics": "..."} for the one song asked for.',
    'Each lyrics uses only these section tags, each on its own line: [verse], [chorus], [bridge].',
    'Structure: [verse] [chorus] [verse] [chorus] [bridge] [chorus]. Four lines per section. The chorus repeats word for word.',
    "Keep lines a similar length (6-9 syllables) so they sing well. Put the song's title, or a phrase from it, in the chorus.",
    'Write in the voice of the song\'s genre (soul sounds like soul, punk like punk). Concrete images, no cliches ("heart of gold", "dancing in the rain"), light rhyme, natural rhythm. Every line must make sense read aloud.',
    'Use a newline between lines and a blank line between sections.',
  ].join('\n');
}

/** [lyrics]' user content; `brief` only for a sung album that has one. `tags` is the track's full trackTags. */
export function lyricsUser(album: AlbumConcept, title: string, tags: string, about: string, brief: string): string {
  const lines = [`Album: "${album.title}" by ${album.artist}. ${album.blurb}`, `About: ${about}`];
  if (brief) lines.push(`The lyrics: ${brief}`);
  lines.push(`Song: "${title}" (${tags})`);
  return lines.join('\n');
}

/** The regenerate calls' context: what it is about ("(no description)" when nothing was said), its sound, sung or not. */
function albumContext(ask: AlbumAsk, core: string): string {
  const about = ask.description.trim() || ask.tags.join(', ') || '(no description)';
  return [`About: ${about}`, `Sound: ${core}`, `Sung: ${ask.sung ? 'yes' : 'no (instrumental)'}`].join('\n');
}

export function titlePrompt(): string {
  return 'You name music albums for an AI music model (YuE). Reply with JSON only: {"title": "..."}.\n'
    + 'title: a creative album title, 1-5 words, not generic, that fits the sound and what the album is about. '
    + 'Never repeat a title the person already has.';
}

export function titleUser(ask: AlbumAsk, album: AlbumConcept, avoid: readonly string[]): string {
  return albumContext(ask, album.core) + (avoid.length > 0 ? `\nNot these: ${avoid.join('; ')}` : '');
}

export function artistPrompt(): string {
  return 'You name the invented band or artist for an album made with an AI music model (YuE). Reply with JSON only: {"artist": "..."}.\n'
    + 'artist: an invented band or artist name that fits the sound, not a real artist.';
}

export function artistUser(ask: AlbumAsk, album: AlbumConcept, avoid: readonly string[]): string {
  return `${albumContext(ask, album.core)}\nAlbum: "${album.title}"` + (avoid.length > 0 ? `\nNot these: ${avoid.join('; ')}` : '');
}

export function titlesPrompt(n: number): string {
  return `You name the tracks of a music album for an AI music model (YuE). Reply with JSON only: {"titles": [...]}, exactly ${n} titles.\n`
    + 'Each title is a creative song name (no numbering), different from the others and from any listed to avoid; together they read '
    + 'like one record.';
}

export function titlesUser(ask: AlbumAsk, album: AlbumConcept, n: number, avoid: readonly string[]): string {
  return `${n} titles for:\n${albumContext(ask, album.core)}\nAlbum: "${album.title}" by ${album.artist}`
    + (avoid.length > 0 ? `\nNot these: ${avoid.join('; ')}` : '');
}

export function coverPrompt(): string {
  return 'You describe album cover art for an image model. Reply with JSON only: {"coverPrompt": "..."}.\n'
    + `coverPrompt: a vivid description of the album cover art: subject, colours, style, mood. ${NO_WRITING}`;
}

export function coverUser(ask: AlbumAsk, album: AlbumConcept): string {
  return `${albumContext(ask, album.core)}\nAlbum: "${album.title}" by ${album.artist}. ${album.blurb}`;
}

// ── the schemas ──────────────────────────────────────────────────────────────────────────

export const ALBUM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'artist', 'blurb', 'coverPrompt', 'core'],
  properties: {
    title: { type: 'string' },
    artist: { type: 'string' },
    blurb: { type: 'string' },
    coverPrompt: { type: 'string' },
    core: { type: 'string' },
  },
} as const;

export function tracksSchema(n: number): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['tracks'],
    properties: {
      tracks: {
        type: 'array',
        minItems: n,
        maxItems: n,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'turn'],
          properties: { title: { type: 'string' }, turn: { type: 'string' } },
        },
      },
    },
  };
}

export const LYRICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lyrics'],
  properties: { lyrics: { type: 'string', maxLength: 2400 } },
} as const;

export function oneSchema(key: string): object {
  return { type: 'object', additionalProperties: false, required: [key], properties: { [key]: { type: 'string' } } };
}

export function titlesSchema(n: number): object {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['titles'],
    properties: { titles: { type: 'array', minItems: n, maxItems: n, items: { type: 'string' } } },
  };
}

// ── the calls ────────────────────────────────────────────────────────────────────────────

/** One tagged call; its answer parsed, or a refusal naming the task (truncated, or not the JSON asked for). */
async function call(
  client: CrucibleClient,
  model: string,
  tag: string,
  name: string,
  system: string,
  user: string,
  schema: object,
  maxTokens: number,
): Promise<Record<string, unknown>> {
  const answer = await client.chat({
    model,
    thinking: false,
    temperature: TEMPERATURE,
    seed: chatSeed(),
    maxTokens,
    act: 'generate',
    responseFormat: { type: 'json_schema', json_schema: { name, schema: schema as Record<string, unknown>, strict: true } },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `${tag}\n${user}` },
    ],
  });
  if (answer.finishReason === 'length') throw new Refusal('album_text_truncated', `${model} ran out of room on ${tag}; try again.`);
  try {
    return JSON.parse(answer.content) as Record<string, unknown>;
  } catch {
    throw new Refusal('album_text_unreadable', `${model} answered ${tag} with something that is not its JSON: ${answer.content.slice(0, 160)}`);
  }
}

function text(value: unknown, tag: string, field: string): string {
  if (typeof value !== 'string') throw new Refusal('album_text_unreadable', `The answer to ${tag} has no ${field}.`);
  return value.trim();
}

/** [album]: the concept. With the person's tags, the core IS their tags, whatever the model repeated. */
export async function writeAlbum(client: CrucibleClient, model: string, ask: AlbumAsk, count: number, page: SongPage | null): Promise<AlbumConcept> {
  const got = await call(client, model, '[album]', 'album', albumPrompt(ask, count, page), albumUser(ask), ALBUM_SCHEMA, MAX_TOKENS.album);
  return {
    title: text(got['title'], '[album]', 'title') || 'Untitled',
    artist: text(got['artist'], '[album]', 'artist') || 'Unknown Artist',
    blurb: text(got['blurb'], '[album]', 'blurb'),
    coverPrompt: text(got['coverPrompt'], '[album]', 'coverPrompt'),
    core: ask.tags.length > 0 ? ask.tags.join(', ') : text(got['core'], '[album]', 'core'),
  };
}

/** [tracks] for places first..last of count, told every title already on the album. */
export async function writeTracks(
  client: CrucibleClient,
  model: string,
  ask: AlbumAsk,
  album: AlbumConcept,
  first: number,
  last: number,
  count: number,
  page: SongPage | null,
  previous: readonly string[],
): Promise<TrackTurn[]> {
  const n = last - first + 1;
  const got = await call(client, model, '[tracks]', 'tracks', tracksPrompt(ask.sung, album.core, first, last, count, page), tracksUser(ask, album, previous), tracksSchema(n), MAX_TOKENS.tracks);
  const tracks = got['tracks'];
  if (!Array.isArray(tracks) || tracks.length !== n) {
    throw new Refusal('album_text_unreadable', `${model} wrote ${Array.isArray(tracks) ? tracks.length : 'no'} tracks for ${first}-${last}, not ${n}.`);
  }
  return tracks.map((track: Record<string, unknown>) => ({ title: text(track['title'], '[tracks]', 'title'), turn: text(track['turn'], '[tracks]', 'turn') }));
}

/** [lyrics] for one sung track. */
export async function writeSongLyrics(client: CrucibleClient, model: string, ask: AlbumAsk, album: AlbumConcept, title: string, tags: string): Promise<string> {
  const brief = ask.sung && ask.lyrics ? ask.lyrics : '';
  const got = await call(client, model, '[lyrics]', 'lyrics', lyricsPrompt(), lyricsUser(album, title, tags, aboutOf(ask), brief), LYRICS_SCHEMA, MAX_TOKENS.lyrics);
  return text(got['lyrics'], '[lyrics]', 'lyrics');
}

/** [album title]: a new title, never one in `avoid`. */
export async function newAlbumTitle(client: CrucibleClient, model: string, ask: AlbumAsk, album: AlbumConcept, avoid: readonly string[]): Promise<string> {
  const got = await call(client, model, '[album title]', 'album_title', titlePrompt(), titleUser(ask, album, avoid), oneSchema('title'), MAX_TOKENS.piece);
  return text(got['title'], '[album title]', 'title');
}

/** [artist]: a new invented artist. */
export async function newArtist(client: CrucibleClient, model: string, ask: AlbumAsk, album: AlbumConcept, avoid: readonly string[]): Promise<string> {
  const got = await call(client, model, '[artist]', 'artist', artistPrompt(), artistUser(ask, album, avoid), oneSchema('artist'), MAX_TOKENS.piece);
  return text(got['artist'], '[artist]', 'artist');
}

/** [track titles]: n new track names, none in `avoid`. */
export async function newTrackTitles(client: CrucibleClient, model: string, ask: AlbumAsk, album: AlbumConcept, n: number, avoid: readonly string[]): Promise<string[]> {
  const got = await call(client, model, '[track titles]', 'track_titles', titlesPrompt(n), titlesUser(ask, album, n, avoid), titlesSchema(n), MAX_TOKENS.piece + 20 * n);
  const titles = got['titles'];
  if (!Array.isArray(titles) || titles.length !== n || !titles.every((title) => typeof title === 'string')) {
    throw new Refusal('album_text_unreadable', `${model} did not name ${n} tracks.`);
  }
  return titles.map((title: string) => title.trim());
}

/** [cover]: a new cover description. */
export async function newCoverPrompt(client: CrucibleClient, model: string, ask: AlbumAsk, album: AlbumConcept): Promise<string> {
  const got = await call(client, model, '[cover]', 'cover', coverPrompt(), coverUser(ask, album), oneSchema('coverPrompt'), MAX_TOKENS.piece);
  return text(got['coverPrompt'], '[cover]', 'coverPrompt');
}
