/**
 * split-text — B-Sides' text in two parts, each with its own writer (Owen, 2026-10-11: "a vanilla
 * 4b model should generate the tags for yue2 using the prompt supplied by yue2 and whatever else
 * weve learned about the model, and it can generate the album cover description for the image
 * model, and the lyricist model should generate everything heard and read by the user"):
 *
 *   sound   the tag model on the Crucible server: a song's tags, an album's core sound, each
 *           track's turn, and the cover description. Told YuE2's own style guidance.
 *     [sound]  a single song's style fields          [core]   an album's shared sound
 *     [turns]  each track's additions to the core    [cover]  (album-text.ts) the cover art
 *   words   the lyricist (Claude, `claude -p`; the server's model on a phone, which has no Claude
 *           Code): what a person reads or hears.
 *     [concept]  an album's title, artist, liner note  [ideas]  track titles, each with what it is about
 *     [song name]  an instrumental single's name; a sung one is named with its lyrics (lyricist.ts)
 *
 * Neither part is B-Sides' trained model's contract (album-text.ts keeps that, for when it comes
 * back): the prompts here are written for a model that reads them, not one trained on them.
 */
import { Refusal } from './refusal';
import type { TextModel } from './text-model';
import { YUE2_STYLE_GUIDE } from './yue2-style';
import { aboutOf, NO_WRITING, vocabLine, type AlbumConcept } from './album-text';
import { clashesIn, composeTags } from './describe';
import { leadOf, leadPhrase, VOICE_TAG, withoutVoice } from '../tags';
import type { AlbumAsk, DescribeResult, SongPage } from '../types';

const PHRASE_MAX = 48;
const WORDS_TEMPERATURE = 0.9;
const SOUND_TEMPERATURE = 0.5;

/** What every sound call is told besides YuE2's own guidance (what YuE2 has been seen to need). */
const SOUND_RULES = [
  'Musical elements only: genres, moods, voices, instruments, playing and production. No sound effects or field',
  'recordings (rain, waves, birdsong, crowd noise, sirens): YuE2 cannot make them reliably. Never name a real artist,',
  'game or film: describe how it sounds instead. No two phrases that contradict each other (two tempos, slow and fast).',
].join('\n');

function list(least: number, most: number): object {
  return { type: 'array', minItems: least, maxItems: most, items: { type: 'string', maxLength: PHRASE_MAX } };
}

/** One call held to its schema; its answer parsed, or a refusal naming the task. */
async function call(
  writer: TextModel, tag: string, name: string, system: string, user: string, schema: object, maxTokens: number, temperature: number,
): Promise<Record<string, unknown>> {
  const answer = await writer.ask({ tag, name, system, user, schema, temperature, maxTokens });
  if (answer.truncated) throw new Refusal('text_truncated', `${writer.name} ran out of room on ${tag}; try again.`);
  try {
    return JSON.parse(answer.content) as Record<string, unknown>;
  } catch {
    throw new Refusal('text_unreadable', `${writer.name} answered ${tag} with something that is not its JSON: ${answer.content.slice(0, 160)}`);
  }
}

/**
 * A list of phrases as the writer answered it, tidied. The stock 4B sometimes puts a whole style
 * line in one item, cut off at the schema's length (Victoria's "Crash Like Thunder, Zeus!",
 * 2026-10-11: "English, children's pop, playful female vocal, g"). Such an item is split at its
 * commas, the cut-off last piece of an item that ran to the limit is dropped, and so is a language
 * (B-Sides lays that out itself). Each phrase once, ignoring case.
 */
function phrasesOf(value: unknown, tag: string, writer: TextModel): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Refusal('text_unreadable', `${writer.name}'s answer to ${tag} is not a list of phrases.`);
  }
  const out: string[] = [];
  for (const item of value as string[]) {
    const pieces = item.split(',').map((piece) => piece.replace(/\s+/g, ' ').trim());
    if (item.length >= PHRASE_MAX && pieces.length > 1) pieces.pop();
    for (const piece of pieces) {
      if (piece === '' || /^(english|chinese|mandarin|cantonese)$/i.test(piece)) continue;
      if (!out.some((kept) => kept.toLowerCase() === piece.toLowerCase())) out.push(piece);
    }
  }
  return out;
}

function textOf(value: unknown, tag: string, field: string): string {
  if (typeof value !== 'string') throw new Refusal('text_unreadable', `The answer to ${tag} has no ${field}.`);
  return value.replace(/\s+/g, ' ').trim();
}

// ── sound ──────────────────────────────────────────────────────────────────────────────────

const SOUND_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['language', 'genre', 'mood', 'lead', 'instruments', 'sound', 'bpm', 'instrumental'],
  properties: {
    language: { type: 'string', enum: ['English', 'Chinese'] },
    // As short as YuE2's own examples (Owen, 2026-10-11: at most 11 phrases in all).
    genre: list(1, 2),
    mood: list(1, 2),
    // The one lead (Owen, 2026-10-11): the singer, or the instrument carrying an instrumental's melody.
    lead: { type: 'string', maxLength: PHRASE_MAX },
    instruments: list(1, 3),
    sound: list(0, 1),
    bpm: { type: 'integer', minimum: 50, maximum: 200 },
    instrumental: { type: 'boolean' },
  },
} as const;

export function soundPrompt(page: SongPage, wantsInstrumental: boolean): string {
  return [
    'You write the style line for YuE2, a model that makes songs: short comma-separated phrases for its language, genre,',
    'mood, voice, instruments, production and tempo. Turn the person\'s description into those fields. Reply with JSON only.',
    '- genre, mood, instruments, sound: 1-5 word phrases a musician would use.',
    '- lead: the ONE thing that carries the melody. Sung: the singer (e.g. "gritty male voice", "soft female vocal"). Instrumental:',
    '  the instrument that plays the melody, written "<instrument> melody" ("lyrical violin melody", "searing lead guitar melody"),',
    '  never a voice. Not repeated in instruments.',
    wantsInstrumental
      ? '- The person wants it instrumental: instrumental is true, and lead is an instrument\'s melody.'
      : '- instrumental: true only when the description asks for no singing (a beat, a game soundtrack, background music).',
    '- language: English unless the description asks for Chinese.',
    '- bpm: the tempo that suits it.',
    SOUND_RULES,
    vocabLine(page),
    '',
    YUE2_STYLE_GUIDE,
  ].filter((line) => line !== '').join('\n');
}

/** [sound]: a single song's tags, laid out as YuE2's examples order them. No words: the lyricist writes those. */
export async function describeSound(writer: TextModel, page: SongPage, description: string, wantsInstrumental: boolean, brief: string): Promise<DescribeResult> {
  const started = Date.now();
  const user = brief === '' ? description : `${description}\nThe lyrics will be about: ${brief}`;
  const got = await call(writer, '[sound]', 'song_sound', soundPrompt(page, wantsInstrumental), user, SOUND_SCHEMA, 300, SOUND_TEMPERATURE);
  const instrumental = wantsInstrumental || got['instrumental'] === true;
  const instruments = phrasesOf(got['instruments'], '[sound]', writer);
  // The one lead (Owen, 2026-10-11). An instrumental names what carries its melody (YuE2's instrumental
  // example: "lyrical violin melody"): with none named, or a voice named, its own melody instrument,
  // else its first instrument as a melody. A sung song with none named is left to its tags.
  const said = typeof got['lead'] === 'string' ? leadPhrase(got['lead'], instrumental) : null;
  let lead = said;
  if (instrumental && lead === null) {
    const melody = leadOf(instruments, true) ?? instruments[0];
    lead = melody === undefined ? null : leadPhrase(melody, true);
  }
  const fields = {
    language: typeof got['language'] === 'string' ? got['language'] : 'English',
    genre: phrasesOf(got['genre'], '[sound]', writer),
    mood: phrasesOf(got['mood'], '[sound]', writer),
    vocal: !instrumental && lead !== null ? [lead] : [],
    // The lead's instrument once: "piano" beside "piano melody" is the same one twice.
    instruments: instrumental && lead !== null
      ? [lead, ...instruments.filter((phrase) => phrase.toLowerCase() !== lead.toLowerCase() && `${phrase} melody`.toLowerCase() !== lead.toLowerCase())]
      : instruments,
    sound: phrasesOf(got['sound'], '[sound]', writer),
    bpm: typeof got['bpm'] === 'number' ? got['bpm'] : 100,
    instrumental,
    lyrics: '',
  };
  const tags = instrumental ? withoutVoice(composeTags(fields)) : composeTags(fields);
  return {
    tags, instrumental, ...(lead !== null ? { lead } : {}), lyrics: null, clashes: clashesIn(tags, page), model: writer.name, seconds: (Date.now() - started) / 1000,
  };
}

export function corePrompt(sung: boolean, page: SongPage | null): string {
  return [
    'You write the shared sound of a music album for YuE2, a model that makes songs: 4-6 short style phrases every track',
    'keeps (genre, mood, instruments, production). Reply with JSON only: {"core": [...]}.',
    '- No tempo and no singer: each track sets its own. No language: B-Sides adds it.',
    sung
      ? '- The album is sung.'
      : '- The album is instrumental: nothing about voices or singing, and no "soaring", "anthemic" or "operatic". Describe the\n  accompaniment and the sound; each track names its own lead melody.',
    SOUND_RULES,
    vocabLine(page),
    '',
    YUE2_STYLE_GUIDE,
  ].filter((line) => line !== '').join('\n');
}

export function coreUser(ask: AlbumAsk, album: Pick<AlbumConcept, 'title' | 'blurb'>): string {
  return [`About: ${aboutOf(ask)}`, `Album: "${album.title}". ${album.blurb}`].join('\n');
}

/** [core]: the album's shared sound; the person's own tags are it as they are, with no call. */
export async function writeCore(writer: TextModel, ask: AlbumAsk, album: Pick<AlbumConcept, 'title' | 'blurb'>, page: SongPage | null): Promise<string> {
  if (ask.tags.length > 0) return ask.tags.join(', ');
  const schema = { type: 'object', additionalProperties: false, required: ['core'], properties: { core: list(3, 6) } };
  const got = await call(writer, '[core]', 'album_core', corePrompt(ask.sung, page), coreUser(ask, album), schema, 250, SOUND_TEMPERATURE);
  return phrasesOf(got['core'], '[core]', writer).join(', ');
}

/**
 * [turns]' prompt. Each track has one lead and its other additions (Owen, 2026-10-11: "lead
 * instrument should be its own tag"); `lead`, the person's own for every track, is said so the
 * rest fits it.
 */
export function turnsPrompt(sung: boolean, coreHasTempo: boolean, n: number, page: SongPage | null, lead: string | null = null): string {
  return [
    `You give each of ${n} tracks of a music album its own sound for YuE2, a model that makes songs. Every track keeps the`,
    `album's core sound; you write what each one ADDS to it. Reply with JSON only: {"turns": [{"lead": "...", "more": [...]}, ...]}, ${n} in track order.`,
    sung
      ? '- lead: the ONE singer that carries the melody (e.g. "warm male voice", "soft female vocal").'
      : '- lead: the ONE instrument that carries the melody, written as a melody ("searing lead guitar melody", "lyrical violin\n  melody", "warm electric piano melody"): YuE2 moves the sung melody onto it, and an unnamed lead invites singing.',
    lead !== null ? `- Every track's lead is "${lead}": write it as each lead, and let the rest suit it.` : '',
    '- Each phrase is 1-4 words. Never repeat the language, the genre or anything already in the core.',
    `- more: 1-3 short phrases: a mood, one instrument or texture${coreHasTempo ? '' : ', and exactly one tempo written "<number> BPM"'}. No voice in it: the lead is the only one.`,
    '- Never repeat or contradict the core. Let the tracks differ from each other, each fitting what its song is about.',
    sung
      ? ''
      : '- The album is instrumental: nothing about voices or singing, and no "soaring", "anthemic" or "operatic".',
    coreHasTempo ? '- The core sets the tempo: add none.' : '',
    SOUND_RULES,
    vocabLine(page),
    '',
    YUE2_STYLE_GUIDE,
  ].filter((line) => line !== '').join('\n');
}

export function turnsUser(core: string, tracks: readonly { readonly title: string; readonly idea?: string }[]): string {
  return [`Core: ${core}`, ...tracks.map((track, at) => `${at + 1}. "${track.title}"${track.idea ? `: ${track.idea}` : ''}`)].join('\n');
}

/** One track's sound from [turns]: its lead (null when none was written) and its other additions, comma-joined. */
export interface TrackTurn {
  readonly lead: string | null;
  readonly more: string;
}

/**
 * [turns]: each listed track's lead and additions to the core, in order. `lead`: the person's own,
 * every track's (AlbumAsk.lead). An answer in the older shape (a list of phrases a track) still
 * reads: its first voice (sung) or melody (instrumental) is the lead.
 */
export async function writeTurns(
  writer: TextModel, sung: boolean, core: string, tracks: readonly { readonly title: string; readonly idea?: string }[], page: SongPage | null,
  lead: string | null = null,
): Promise<TrackTurn[]> {
  const n = tracks.length;
  const turn = {
    type: 'object', additionalProperties: false, required: ['lead', 'more'],
    properties: { lead: { type: 'string', maxLength: PHRASE_MAX }, more: list(1, 3) },
  };
  const schema = {
    type: 'object', additionalProperties: false, required: ['turns'],
    properties: { turns: { type: 'array', minItems: n, maxItems: n, items: turn } },
  };
  const coreHasTempo = /\b\d{2,3}\s*BPM\b/i.test(core);
  const theirs = lead === null ? null : leadPhrase(lead, !sung);
  const got = await call(writer, '[turns]', 'track_turns', turnsPrompt(sung, coreHasTempo, n, page, theirs), turnsUser(core, tracks), schema, 120 + 70 * n, SOUND_TEMPERATURE);
  const turns = got['turns'];
  if (!Array.isArray(turns) || turns.length !== n) throw new Refusal('text_unreadable', `${writer.name} gave ${Array.isArray(turns) ? turns.length : 'no'} tracks their sound, not ${n}.`);
  return turns.map((answer: unknown): TrackTurn => {
    const shaped = typeof answer === 'object' && answer !== null && !Array.isArray(answer) ? answer as Record<string, unknown> : null;
    const phrases = phrasesOf(shaped === null ? answer : shaped['more'], '[turns]', writer);
    const written = shaped !== null && typeof shaped['lead'] === 'string' ? leadPhrase(shaped['lead'], !sung) : null;
    const chosen = theirs ?? written ?? leadPhrase(leadOf(phrases, !sung) ?? '', !sung);
    // One lead a track: the stock 4B gave one track four singers, male and female (2026-10-11).
    const more = phrases.filter((phrase) => !VOICE_TAG.test(phrase) && (chosen === null || phrase.toLowerCase() !== chosen.toLowerCase()));
    return { lead: chosen, more: more.join(', ') };
  });
}

/**
 * [cover]: what the image model paints, held short. The stock 4B, asked as B-Sides' model was
 * (200 tokens, no length), ran out of room on Victoria's Gods and Wonders (2026-10-11): a long
 * description of nine myths. Now: one paragraph of at most 70 words, which the schema ends.
 */
export async function writeCover(writer: TextModel, ask: AlbumAsk, album: Pick<AlbumConcept, 'title' | 'artist' | 'blurb' | 'core'>): Promise<string> {
  const schema = { type: 'object', additionalProperties: false, required: ['coverPrompt'], properties: { coverPrompt: { type: 'string', maxLength: 600 } } };
  const system = [
    'You describe album cover art for an image model. Reply with JSON only: {"coverPrompt": "..."}.',
    '- One paragraph of at most 70 words: the subject, its setting, colours, the art style and the mood. One clear picture, not a list of everything the album is about.',
    `- ${NO_WRITING}`,
  ].join('\n');
  const user = [`About: ${aboutOf(ask)}`, `Sound: ${album.core}`, `Album: "${album.title}" by ${album.artist}. ${album.blurb}`].join('\n');
  const got = await call(writer, '[cover]', 'cover', system, user, schema, 400, WORDS_TEMPERATURE);
  return textOf(got['coverPrompt'], '[cover]', 'coverPrompt');
}

// ── words ──────────────────────────────────────────────────────────────────────────────────

export function conceptPrompt(ask: AlbumAsk, count: number): string {
  return [
    'You name a music album made with an AI music model. Reply with JSON only: {"title", "artist", "blurb"}.',
    `It will have ${count} tracks. ${ask.sung ? 'It is sung.' : 'It is instrumental.'}`,
    ask.title ? `- title: exactly "${ask.title}", the name the person gave it.` : '- title: a creative album title, 1-5 words, not generic.',
    '- artist: an invented band or artist name that fits it, never a real one.',
    '- blurb: one sentence about the record, like a liner note.',
    ask.sung && ask.lyrics ? `The lyrics will be about: ${ask.lyrics}. Let the title fit them.` : '',
  ].filter((line) => line !== '').join('\n');
}

export function conceptUser(ask: AlbumAsk): string {
  const wanted = [ask.description.trim(), ask.tags.length > 0 ? `Tags: ${ask.tags.join(', ')}` : ''].filter((part) => part !== '').join('\n');
  return wanted === '' ? 'Surprise me.' : wanted;
}

/** [concept]: the album's title, artist and liner note. */
export async function writeConcept(writer: TextModel, ask: AlbumAsk, count: number): Promise<{ title: string; artist: string; blurb: string }> {
  const schema = {
    type: 'object', additionalProperties: false, required: ['title', 'artist', 'blurb'],
    properties: { title: { type: 'string', maxLength: 80 }, artist: { type: 'string', maxLength: 80 }, blurb: { type: 'string', maxLength: 400 } },
  };
  const got = await call(writer, '[concept]', 'album_concept', conceptPrompt(ask, count), conceptUser(ask), schema, 400, WORDS_TEMPERATURE);
  return {
    // The person's own name stands whatever came back.
    title: ask.title || textOf(got['title'], '[concept]', 'title') || 'Untitled',
    artist: textOf(got['artist'], '[concept]', 'artist') || 'Unknown Artist',
    blurb: textOf(got['blurb'], '[concept]', 'blurb'),
  };
}

export function ideasPrompt(sung: boolean, first: number, last: number, count: number): string {
  return [
    `You write the track list of a music album, tracks ${first}-${last} of ${count}, in order. Reply with JSON only: {"tracks": [{"title", "idea"}]}.`,
    '- title: a creative song name (no numbering), never one already on the album.',
    sung
      ? '- idea: one sentence: what this song is about, its own small story (a person, a place, a turn).'
      : '- idea: one sentence: the scene or feeling this piece paints.',
    '- Each song stands alone, played on shuffle: the album shares a theme, but no song is an intro, an outro, a welcome or a',
    '  goodbye, or about the album or its other songs. Make them differ from each other.',
  ].join('\n');
}

export function ideasUser(ask: AlbumAsk, album: Pick<AlbumConcept, 'title' | 'artist' | 'blurb'>, previous: readonly string[]): string {
  const lines = [`Album: "${album.title}" by ${album.artist}. ${album.blurb}`, `About: ${aboutOf(ask)}`];
  if (ask.sung && ask.lyrics) lines.push(`The lyrics will be about: ${ask.lyrics}`);
  if (previous.length > 0) lines.push(`Already on the album: ${previous.map((title, at) => `${at + 1}. "${title}"`).join('; ')}`);
  return lines.join('\n');
}

/** [ideas]: tracks first..last of count, each a title and what it is about, told every title so far. */
export async function writeIdeas(
  writer: TextModel, ask: AlbumAsk, album: Pick<AlbumConcept, 'title' | 'artist' | 'blurb'>, first: number, last: number, count: number, previous: readonly string[],
): Promise<{ title: string; idea: string }[]> {
  const n = last - first + 1;
  const schema = {
    type: 'object', additionalProperties: false, required: ['tracks'],
    properties: {
      tracks: {
        type: 'array', minItems: n, maxItems: n,
        items: {
          type: 'object', additionalProperties: false, required: ['title', 'idea'],
          properties: { title: { type: 'string', maxLength: 80 }, idea: { type: 'string', maxLength: 300 } },
        },
      },
    },
  };
  const got = await call(writer, '[ideas]', 'track_ideas', ideasPrompt(ask.sung, first, last, count), ideasUser(ask, album, previous), schema, 200 + 80 * n, WORDS_TEMPERATURE);
  const tracks = got['tracks'];
  if (!Array.isArray(tracks) || tracks.length !== n) {
    throw new Refusal('text_unreadable', `${writer.name} wrote ${Array.isArray(tracks) ? tracks.length : 'no'} tracks for ${first}-${last}, not ${n}.`);
  }
  return tracks.map((track: Record<string, unknown>) => ({ title: textOf(track['title'], '[ideas]', 'title'), idea: textOf(track['idea'], '[ideas]', 'idea') }));
}

/**
 * [song name]: a song's name from what it is about, its sound and, when sung, its words. An
 * instrumental from Describe, and any song made without one (a preset and Make; Owen, 2026-10-11:
 * one came out "Heavy metal · Epic · Dark"). A sung song named by its lyricist never comes here.
 */
export async function nameSong(writer: TextModel, about: string, tags: readonly string[], lyrics = ''): Promise<string | null> {
  const schema = { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', maxLength: 60 } } };
  const sung = lyrics.trim() !== '';
  const got = await call(
    writer, '[song name]', 'song_name',
    `You name ${sung ? 'a song' : 'a piece of instrumental music'}. Reply with JSON only: {"title": "..."}. A creative title, 1-5 words, that fits ${sung ? 'its words (its hook, never its first line)' : 'what it is about'} and how it sounds; never generic, never a list of its tags.`,
    [about ? `About: ${about}` : '', `Sound: ${tags.join(', ')}`, sung ? `Lyrics:\n${lyrics.trim().slice(0, 2000)}` : ''].filter((line) => line !== '').join('\n'),
    schema, 80, WORDS_TEMPERATURE,
  );
  const title = textOf(got['title'], '[song name]', 'title').replace(/^["'“]+|["'”]+$/g, '').trim();
  return title === '' ? null : title;
}
