/**
 * describe — "describe the music, get the tags" (Owen, 2026-10-04: "hook up a
 * small model that will fill in tags for me if I just describe the music. Like
 * 'music in the style of one must fall 2097 dos game' or 'smooth lo fi with
 * jazz/sax'").
 *
 * A small chat model on the same Crucible server (`TAG_MODEL`) reads the
 * description and answers structured fields — language, genre, mood, vocal,
 * instruments, sound, tempo, instrumental — held to a JSON schema, so the answer
 * is always parseable and always the right shape. B-Sides then lays the fields out
 * in the order YuE2's own docs show a style line ("English, warm piano pop,
 * expressive female voice, acoustic piano, ..., 88 BPM").
 *
 * The server's tag vocabulary (`crucible/audio/tags/song.toml`, via the song
 * page) goes into the prompt as EXAMPLES, preferred where they fit — not as a
 * closed list: YuE2 takes any phrase, and "One Must Fall 2097" needs words like
 * "FM synth" that no list has. What the vocabulary does decide is the conflict
 * check: every clash the answer holds is reported with the server's reason, and
 * the chips show it red like any other clash. Nothing is silently dropped.
 *
 * Crucible holds one model per card, so on a card the song model fills,
 * describing swaps YuE2 out and the next song swaps it back. The studio says so.
 */
import { CrucibleRefused, type CrucibleClient } from '@crucible/client';

import { Refusal } from './refusal';
import { clashesWith, clashText, indexOfTag, withoutVoice } from '../tags';
import { TAG_MODEL, type DescribeResult, type SongPage } from '../types';

const MAX_DESCRIPTION = 600;
const PHRASE_MAX = 48;

/** What the model must answer: each field a short list of phrases, in YuE2's order. */
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['language', 'genre', 'mood', 'vocal', 'instruments', 'sound', 'bpm', 'instrumental', 'lyrics'],
  properties: {
    language: { type: 'string', enum: ['English', 'Chinese'] },
    genre: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: PHRASE_MAX } },
    mood: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: PHRASE_MAX } },
    vocal: { type: 'array', minItems: 0, maxItems: 2, items: { type: 'string', maxLength: PHRASE_MAX } },
    instruments: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', maxLength: PHRASE_MAX } },
    sound: { type: 'array', minItems: 0, maxItems: 3, items: { type: 'string', maxLength: PHRASE_MAX } },
    bpm: { type: 'integer', minimum: 50, maximum: 200 },
    instrumental: { type: 'boolean' },
    lyrics: { type: 'string', maxLength: 2400 },
  },
} as const;

export interface TagFields {
  readonly language: string;
  readonly genre: readonly string[];
  readonly mood: readonly string[];
  readonly vocal: readonly string[];
  readonly instruments: readonly string[];
  readonly sound: readonly string[];
  readonly bpm: number;
  readonly instrumental: boolean;
  /** The song's words when it is sung (Owen, 2026-10-05: "have the chat generate lyrics ... if the user doesn't want instrumental"); '' when instrumental. */
  readonly lyrics: string;
}

/** The instructions, with the server's vocabulary as the examples to prefer. */
export function tagPrompt(page: SongPage, wantsInstrumental = false): string {
  const groups = page.suggestions
    .filter((group) => group.group.toLowerCase() !== 'instrumental' && group.group.toLowerCase() !== 'language')
    .map((group) => `- ${group.group}: ${group.tags.join(', ')}`)
    .join('\n');
  return [
    'You write the style line for YuE2, a model that makes songs. A style line is short comma-separated',
    'phrases: language, genre, mood, vocal character, instruments, production, tempo.',
    '',
    'Turn the person\'s description into those fields:',
    '- genre, mood, instruments, sound: 1-5 word phrases a musician would use. Prefer the phrases below',
    '  when one fits; write your own when none does.',
    '- A game, film, artist or era is never named in a phrase: describe how it SOUNDS instead (its',
    '  instruments, its synths and chips, its production, its decade, its energy).',
    '- vocal: the voice (e.g. "soft female voice"), or nothing at all when instrumental.',
    '- instrumental: true only when the description asks for no vocals or is music without singing',
    '  (a game soundtrack, a beat, background music); then vocal is empty.',
    '- language: English unless the description asks for Chinese.',
    '- bpm: the tempo that suits the description.',
    '- Never pick two things that contradict each other (two tempos, two vocal genders, slow and fast).',
    wantsInstrumental
      ? '- The person wants it instrumental: instrumental is true, vocal is empty, lyrics is "".'
      : '- lyrics: when instrumental is false, write short, GOOD song words in the voice of the genre you chose (soul sounds like soul, punk like punk): [verse], [chorus], [verse], [chorus], each section tag on its own line, four lines per section, lines of similar length (6-9 syllables). The chorus is the hook: simple, singable, repeated word for word. Concrete images from what the person described, light rhyme, no cliches, no filler. Every line must make sense read aloud; cut any line that does not. Use a newline between lines. When instrumental is true, lyrics is "".',
    '',
    'An example of describing a reference by its sound. "the music from a 90s DOS racing game" is not',
    'orchestral: games of that era played tracker modules and FM synth chips. So: genre "techno",',
    '"electronic rock"; mood "energetic", "driving"; instruments "FM synth leads", "tracker drums",',
    '"slap bass"; sound "90s MOD tracker sound", "Sound Blaster FM"; instrumental true; bpm 140.',
    '',
    'Phrases the song page offers:',
    groups,
  ].join('\n');
}

/** Read and check the model's answer. A malformed one is a refusal that says so, never a guess. */
export function readFields(content: string): TagFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Refusal('describe_unreadable', `${TAG_MODEL} did not answer JSON: ${content.slice(0, 160)}`);
  }
  const fields = parsed as Partial<TagFields>;
  const list = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
  if (
    typeof fields.language !== 'string' || !list(fields.genre) || !list(fields.mood) || !list(fields.vocal)
    || !list(fields.instruments) || !list(fields.sound) || typeof fields.bpm !== 'number' || typeof fields.instrumental !== 'boolean'
    || typeof fields.lyrics !== 'string'
  ) {
    throw new Refusal('describe_unreadable', `${TAG_MODEL}'s answer is missing a field: ${content.slice(0, 160)}`);
  }
  return fields as TagFields;
}

/** Lay the fields out as YuE2's style line orders them, each phrase once (ignoring case). */
export function composeTags(fields: TagFields): string[] {
  const phrases = [
    fields.language,
    ...fields.genre,
    ...fields.mood,
    ...(fields.instrumental ? [] : fields.vocal),
    ...fields.instruments,
    ...fields.sound,
    `${Math.round(fields.bpm)} BPM`,
  ];
  const tags: string[] = [];
  for (const raw of phrases) {
    // A comma would split one phrase into two chips.
    const phrase = raw.replace(/,/g, ' ').replace(/\s+/g, ' ').trim().slice(0, PHRASE_MAX);
    if (phrase !== '' && indexOfTag(tags, phrase) < 0) tags.push(phrase);
  }
  return tags;
}

/**
 * Lay lyrics out one line per line, each section tag on its own line and a blank
 * line before every section after the first. Small models put double spaces (or
 * nothing) where the line breaks belong; YuE reads the breaks.
 */
export function layLyrics(raw: string): string {
  const lines = raw
    .replace(/\r/g, '')
    .replace(/ {2,}/g, '\n')
    .replace(/\s*(\[(?:verse|chorus|bridge|outro|intro)[^\]]*\])\s*/gi, '\n$1\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const out: string[] = [];
  for (const line of lines) {
    if (/^\[[^\]]+\]$/.test(line)) {
      if (out.length > 0) out.push('');
      out.push(line.toLowerCase());
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

/** Every clash in `tags`, by the server's conflict map, each said once. */
export function clashesIn(tags: readonly string[], page: SongPage): string[] {
  const found: string[] = [];
  for (const tag of tags) {
    const clashes = clashesWith(tag, tags, page.conflicts);
    if (clashes.length > 0) found.push(`${tag}: ${clashText(clashes)}`);
  }
  return found;
}

/** Ask the tag model for `description`'s tags. */
export async function describe(client: CrucibleClient, page: SongPage, description: string, wantsInstrumental = false): Promise<DescribeResult> {
  const text = typeof description === 'string' ? description.trim() : '';
  if (text === '') throw new Refusal('describe_empty', 'Describe the music first, e.g. "smooth lo-fi with jazz sax".');
  if (text.length > MAX_DESCRIPTION) {
    throw new Refusal('describe_too_long', `A description is at most ${MAX_DESCRIPTION} characters.`);
  }
  const started = Date.now();
  let content: string;
  try {
    const answer = await client.chat({
      model: TAG_MODEL,
      thinking: false,
      temperature: 0.5,
      // The tags take ~150 tokens; a song's words up to ~700 more.
      maxTokens: wantsInstrumental ? 400 : 1100,
      act: 'generate',
      responseFormat: { type: 'json_schema', json_schema: { name: 'song_tags', schema: SCHEMA, strict: true } },
      messages: [
        { role: 'system', content: tagPrompt(page, wantsInstrumental) },
        { role: 'user', content: text },
      ],
    });
    if (answer.finishReason === 'length') {
      throw new Refusal('describe_truncated', `${TAG_MODEL} ran out of room before it finished the tags; describe it again.`);
    }
    content = answer.content;
  } catch (error) {
    if (error instanceof CrucibleRefused && error.code === 'installing') {
      // The model's first use: the server is downloading it. Say how far along, in its words.
      throw new Refusal('describe_installing', `The tag model is being set up on the server first: ${error.serverMessage}`, 409);
    }
    throw error;
  }
  const fields = readFields(content);
  // Asked for instrumental, it is instrumental whatever the model answered: no singer among the tags.
  const instrumental = wantsInstrumental || fields.instrumental;
  const tags = instrumental ? withoutVoice(composeTags({ ...fields, instrumental })) : composeTags(fields);
  return {
    tags,
    instrumental,
    lyrics: instrumental ? null : layLyrics(fields.lyrics) || null,
    clashes: clashesIn(tags, page),
    model: TAG_MODEL,
    seconds: (Date.now() - started) / 1000,
  };
}
