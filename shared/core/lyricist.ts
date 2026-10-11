/**
 * lyricist — who writes a sung song's words.
 *
 *   bside    B-Sides' own model on the Crucible server (album-text.ts [lyrics]; describe's own
 *            lyrics for a single song). The default.
 *   claude   Claude Sonnet 5.5 through Claude Code on this computer (`claude -p`), a stand-in
 *            while the B-Sides model is retrained (Owen, 2026-10-10: "set it up to make a
 *            claude -p sonnet 5.5 call to generate the lyrics as an alternative until the b
 *            sides model is trained"). Desktop only: the phone has no Claude Code.
 *
 * Claude is not held to the v2 contract (it was never trained on it), so its prompt is written
 * for what Victoria's first album lacked (2026-10-10): a story within the song, each song standing
 * alone within the album's theme (2026-10-11: no bookends), verses longer than choruses, a final chorus that turns, and a shape that changes from
 * track to track (SONG_SHAPES) with no section under 4 lines, which keeps every section sung.
 */

import { YUE2_LYRICS_GUIDE } from './yue2-style';

/** Who writes the lyrics; a hub preference. */
export type LyricsWriter = 'bside' | 'claude';
export const LYRICS_WRITERS: readonly LyricsWriter[] = ['bside', 'claude'];

/** What a lyricist is told about one song. */
export interface SongToWrite {
  /** The song's name; null for a single song not named yet. */
  readonly title: string | null;
  /** Its style line (YuE2 tags: genre, mood, voice, instruments, tempo). */
  readonly tags: string;
  /** What the person said it is about (a description, or their tags). */
  readonly about: string;
  /** What the words should be about, in the person's words; '' when they said nothing. */
  readonly brief: string;
  /** What this song is about, from the album's track list (split-text.ts [ideas]). */
  readonly idea?: string;
  /** The person chose a pre-chorus (Make's checkbox; Owen, 2026-10-11: an option, with a warning). */
  readonly preChorus?: boolean;
  /**
   * Make's "Pronounce phonetically" (Owen, 2026-10-11; Victoria: YuE2 mangles Persephone, Odysseus,
   * Penelope): names and uncommon words are written as they sound, so YuE2 sings them right.
   */
  readonly phonetic?: boolean;
  /** Worn words and a spark for its name (fresh-names.ts); only when it names the song. */
  readonly fresh?: string;
  /** For an album's track: the record around it. */
  readonly album?: {
    readonly title: string;
    readonly artist: string;
    readonly blurb: string;
    /** Every track's name, in order. */
    readonly tracks: readonly string[];
    /** This song's place in `tracks` (0-based). */
    readonly at: number;
  };
}

/** Writes one song's words, in YuE2's section tags. */
export interface Lyricist {
  /** Its model, as the album page names who wrote it. */
  readonly name: string;
  write(song: SongToWrite): Promise<string>;
  /** The words and a name for them together, for a single song not named yet (the name fits the hook). */
  writeTitled?(song: SongToWrite): Promise<{ readonly lyrics: string; readonly title: string | null }>;
}

/** The sections YuE2 composes (crucible/jobs/audio/yue2music/compile_score.py SECTIONS). */
export const YUE_SECTIONS = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Interlude', 'Outro'] as const;

/** The instruction "Pronounce phonetically" adds: YuE2 sings what it reads, and has never met most names. */
export const PHONETIC = [
  'Pronounce phonetically: YuE2 sings each word as it reads it, and gets names and rare words wrong. Write every name and',
  'uncommon word the way it sounds, syllables joined by hyphens, the stressed one in capitals: Persephone as per-SEF-oh-nee,',
  'Odysseus as oh-DISS-ee-us, Penelope as peh-NEL-oh-pee, Achilles as uh-KILL-eez. Everyday English words stay as they are.',
].join(' ');

export function claudeLyricsSystem(preChorus = false): string {
  return [
    'You are a working songwriter writing lyrics that an AI singer (YuE2) will sing over music it composes from a style line.',
    'Write lyrics that tell a story: a person, a place, a turn. Each verse moves the story on; the chorus says what it means;',
    'the bridge changes the angle (a memory, a confession, a reversal) in a different rhythm from the verses. Be specific,',
    'witty where the genre allows, concrete in every image, and true to the genre\'s own voice (boom bap sounds like boom bap,',
    'soul like soul). No cliches, no filler, no line that only rhymes. Every line must make sense read aloud.',
    '',
    'Form, which YuE2 needs to sing every section:',
    `- Use only these section tags, each alone on its own line, in Title Case, in square brackets: ${sectionsFor(preChorus).map((s) => `[${s}]`).join(', ')}.`,
    preChorus
      ? '  A [Pre-Chorus] is 4 short lines that build into the chorus. No [Interlude].'
      : '  No [Pre-Chorus] and no [Interlude]: YuE2 drops a pre-chorus more often than it sings one, and its words then crowd the\n  verse or chorus melody beside it. Let the last lines of a verse build toward the chorus instead.',
    '- Every section is exactly 4 lines, or 8 for a verse. YuE2 plans its melody in phrases of four, one line each: a',
    '  6-line chorus has every line after the first run across a phrase, and a section under 4 lines is dropped.',
    '- Use an [Intro] or [Outro] only as 4 sung lines; otherwise start on the first verse and end on the last chorus.',
    `- Verses 8 lines (or 4); ${preChorus ? 'pre-choruses, ' : ''}choruses, bridges, intros and outros 4. The final chorus has its last two lines changed.`,
    '- Short lines: at most the syllables per line you are given. YuE2 sings about one bar per line, and a longer line is',
    '  crammed or loses words. Count every line\'s syllables before you answer, and split or cut any line over the budget.',
    '- Follow the shape you are given, if one is given.',
    '- Verses are longer than choruses. The chorus is the hook: singable and memorable, not the title repeated with a filler phrase.',
    '- Lines of similar length within a section so they sing well. A blank line between sections.',
    '- Sing in the language the style line names: English, or Chinese when it says Chinese (the two YuE2 sings).',
    'Reply with the lyrics only, in the JSON asked for.',
    '',
    YUE2_LYRICS_GUIDE,
  ].join('\n');
}

export function claudeLyricsUser(song: SongToWrite): string {
  const lines: string[] = [];
  if (song.album) {
    const { album } = song;
    lines.push(`Album: "${album.title}" by ${album.artist}. ${album.blurb}`.trim());
    lines.push(`The track list: ${album.tracks.map((title, at) => `${at + 1}. ${title}`).join('; ')}`);
    // No opener or closer: an album is played on shuffle, and a first track that welcomes or a last
    // one that says goodbye ("Thirty Greek myths are coming your way!") undercuts the song itself
    // (Victoria, 2026-10-11). The track list is for variety, not for songs that point at each other.
    lines.push('The album shares a theme, but this song must stand alone, played on shuffle: never mention the album, other songs, how many songs there are, what comes next, and no welcome or goodbye to the listener. Make it different from the other titles, not a part of them.');
  }
  lines.push(`About: ${song.about || '(the person said nothing; take it from the style)'}`);
  if (song.brief) lines.push(`The lyrics should be about: ${song.brief}`);
  if (song.idea) lines.push(`This song is about: ${song.idea}`);
  lines.push(song.title ? `Song: "${song.title}"` : 'Song: not named yet; name it too (title: 1-5 words that fit its hook, never its first line, never generic)');
  if (!song.title && song.fresh) lines.push(song.fresh);
  lines.push(`Style line: ${song.tags}`);
  if (song.phonetic === true) lines.push(PHONETIC);
  lines.push(`Syllables: at most ${syllableBudget(song.tags)} per line.`);
  const shapes = song.preChorus === true ? SONG_SHAPES : CLAUDE_SHAPES;
  lines.push(`Shape: ${shapes[(song.album?.at ?? Math.floor(Math.random() * shapes.length)) % shapes.length]}`);
  return lines.join('\n');
}

/**
 * The section orders a Claude lyricist is handed, one per song, so an album's tracks don't all
 * share one template (Victoria, 2026-10-10). A track takes its place in the album; a single song
 * takes one at random. No 2-line sections: YuE2's score stage dropped 2-line intros, outros and
 * pre-choruses on Victoria's laptop (Crucible 1.0.130), while 4+-line sections were kept.
 *
 * Frozen: the B-Sides model's v3 is trained on these six strings verbatim, sent as "Shape: ..."
 * at the end of its [lyrics] message (Training pc 1, 2026-10-10). Changing one means retraining.
 */
export const SONG_SHAPES: readonly string[] = [
  'verse, pre-chorus, chorus, verse, pre-chorus, chorus, bridge, chorus',
  'intro (4 lines), verse, chorus, verse, chorus, bridge, chorus',
  'verse, chorus, verse, chorus, bridge, chorus, outro (4 lines)',
  'verse, verse, chorus, verse, chorus, bridge, chorus',
  'intro (4 lines), verse, pre-chorus, chorus, verse, pre-chorus, chorus, outro (4 lines)',
  'chorus, verse, chorus, verse, bridge, chorus',
];

/**
 * The most syllables a sung line takes (Victoria, 2026-10-11: "sometimes there are too many lyrics
 * per measure for yue"). Her album's tracks that sang cleanly averaged 8 syllables a line, at most
 * 10-12; "Nobody Poked the Cyclops", which YuE2 crammed, averaged 12.5, at most 16. YuE2's own
 * example lyrics run about 7. So 8, and 7 for slow songs (lullabies, ballads, under 85 BPM) and
 * fast ones (140 BPM and up, where a bar is short).
 */
export function syllableBudget(tags: string): number {
  const bpm = Number(/\b\d{2,3}(?=\s*bpm\b)/i.exec(tags)?.[0] ?? NaN);
  if (bpm < 85 || bpm >= 140) return 7;
  if (/\b(lullaby|ballad|slow|lo-?fi|ambient)\b/i.test(tags)) return 7;
  return 8;
}

/** A line's syllables, near enough to tell a crammed line (vowel groups, a silent final e dropped). */
export function syllables(line: string): number {
  return (line.toLowerCase().match(/[a-z']+/g) ?? []).reduce((sum, word) => {
    const bare = word.replace(/'/g, '').replace(/(?:[^laeiouy]es|[^laeiouy]e|ed)$/, '').replace(/^y/, '');
    return sum + Math.max(1, (bare.match(/[aeiouy]+/g) ?? []).length);
  }, 0);
}

/**
 * The sung lines well over the budget (two syllables of slack, for the count's guesses); section
 * tags are not sung. Chinese is counted by character, one syllable each.
 */
export function crammedLines(lyrics: string, budget: number): string[] {
  return lyrics.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line !== '' && !/^\[[^\]]+\]$/.test(line))
    .filter((line) => {
      const han = (line.match(/[\u4e00-\u9fff]/g) ?? []).length;
      return han + syllables(line) > budget + 2;
    });
}

/**
 * The sections whose line count YuE2's planner does not take: anything but 4 lines, or 8 for a
 * verse (crucible-pc-1, 2026-10-11: "A Thousand Ships" sang a 6-line chorus over a score of four
 * 2-bar phrases, and every line after the first ran across a phrase). Each as "[Chorus] (6 lines)".
 */
export function misshapenSections(lyrics: string, preChorus = false): string[] {
  const found: string[] = [];
  let tag: string | null = null;
  let lines = 0;
  const close = (): void => {
    if (tag === null) return;
    const name = tag.slice(1, -1).trim().toLowerCase();
    if (!sectionsFor(preChorus).some((section) => section.toLowerCase() === name)) found.push(`${tag} (not a section YuE2 sings reliably: use Verse, Chorus or Bridge)`);
    else if (!(lines === 4 || (lines === 8 && name === 'verse'))) found.push(`${tag} (${lines} lines)`);
  };
  for (const raw of lyrics.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[[^\]]+\]$/.test(line)) {
      close();
      tag = line;
      lines = 0;
    } else if (line !== '') {
      lines += 1;
    }
  }
  close();
  return found;
}

/** Asked again, once, when some lines are crammed or sections misshapen: those named, the rest kept. */
export function claudeLyricsShorter(lyrics: string, crammed: readonly string[], budget: number, misshapen: readonly string[] = []): string {
  return [
    ...(crammed.length > 0 ? [`These lines are too long for YuE2 to sing (at most ${budget} syllables a line):`, ...crammed.map((line) => `- ${line}`), ''] : []),
    ...(misshapen.length > 0 ? ['These sections are not 4 lines (8 for a verse), the phrases YuE2 plans its melody in:', ...misshapen.map((section) => `- ${section}`), ''] : []),
    'Fix only those: shorten the lines, and bring each section to 4 lines (a verse 4 or 8). Keep everything else as it is.',
    '',
    lyrics,
  ].join('\n');
}

/**
 * The sections a lyricist writes: the ones YuE2's own examples use, plus a 4-line intro or outro
 * when the shape asks for one (Owen, 2026-10-11: "the lyrics should exactly match the format yue
 * expects"). Not [Pre-Chorus]: across Victoria's 67 songs that had them, YuE2's score dropped both
 * pre-choruses in 30 and one in 8, folding their words into the verse or chorus beside them.
 * Not [Interlude]: an interlude is not sung.
 */
export const LYRIC_SECTIONS = ['Intro', 'Verse', 'Chorus', 'Bridge', 'Outro'] as const;

/** The sections a song may use: LYRIC_SECTIONS, with a pre-chorus when the person chose one. */
export function sectionsFor(preChorus: boolean): readonly string[] {
  return preChorus ? ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Outro'] : LYRIC_SECTIONS;
}

/**
 * SONG_SHAPES as Claude is handed them: the same six orders, without a pre-chorus. SONG_SHAPES
 * itself stays as B-Sides' model was trained on it, for when that model writes again.
 */
export const CLAUDE_SHAPES: readonly string[] = SONG_SHAPES.map((shape) => shape.split(', ').filter((part) => part !== 'pre-chorus').join(', '));

/** The JSON a Claude lyricist answers for a song it names too. */
export const CLAUDE_TITLED_LYRICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'lyrics'],
  properties: { title: { type: 'string', maxLength: 60 }, lyrics: { type: 'string' } },
} as const;

/** The JSON a Claude lyricist answers with. */
export const CLAUDE_LYRICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lyrics'],
  properties: { lyrics: { type: 'string' } },
} as const;
