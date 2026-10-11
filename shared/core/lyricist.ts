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
 * for what Victoria's first album lacked (2026-10-10): a story within the song and across the
 * album, verses longer than choruses, a final chorus that turns, and a shape that changes from
 * track to track (SONG_SHAPES) with no section under 4 lines, which keeps every section sung.
 */

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
}

/** The sections YuE2 composes (crucible/jobs/audio/yue2music/compile_score.py SECTIONS). */
export const YUE_SECTIONS = ['intro', 'verse', 'pre-chorus', 'chorus', 'bridge', 'interlude', 'outro'] as const;

export function claudeLyricsSystem(): string {
  return [
    'You are a working songwriter writing lyrics that an AI singer (YuE2) will sing over music it composes from a style line.',
    'Write lyrics that tell a story: a person, a place, a turn. Each verse moves the story on; the chorus says what it means;',
    'the bridge changes the angle (a memory, a confession, a reversal) in a different rhythm from the verses. Be specific,',
    'witty where the genre allows, concrete in every image, and true to the genre\'s own voice (boom bap sounds like boom bap,',
    'soul like soul). No cliches, no filler, no line that only rhymes. Every line must make sense read aloud.',
    '',
    'Form, which YuE2 needs to sing every section:',
    `- Use only these section tags, each alone on its own line, lowercase, in square brackets: ${YUE_SECTIONS.map((s) => `[${s}]`).join(', ')}.`,
    '- Every section has at least 4 lines. YuE2 drops shorter sections, above all at the start and end of a song.',
    '- Use an [intro] or [outro] only when it has 4 or more sung lines; otherwise start on the first verse and end on the last chorus.',
    '- Verses 6-8 lines, pre-choruses 4, choruses 4-6, a bridge 4. The final chorus has its last two lines changed.',
    '- Follow the shape you are given, if one is given.',
    '- Verses are longer than choruses. The chorus is the hook: singable and memorable, not the title repeated with a filler phrase.',
    '- Lines of similar length within a section so they sing well. A blank line between sections.',
    '- Sing in the language the style line names: English, or Chinese when it says Chinese (the two YuE2 sings).',
    'Reply with the lyrics only, in the JSON asked for.',
  ].join('\n');
}

export function claudeLyricsUser(song: SongToWrite): string {
  const lines: string[] = [];
  if (song.album) {
    const { album } = song;
    lines.push(`Album: "${album.title}" by ${album.artist}. ${album.blurb}`.trim());
    lines.push(`The track list: ${album.tracks.map((title, at) => `${at + 1}. ${title}`).join('; ')}`);
    lines.push(`This is track ${album.at + 1} of ${album.tracks.length}${album.at === 0 ? ', the opener' : album.at === album.tracks.length - 1 ? ', the closer' : ''}. Let it carry its part of the album's story.`);
  }
  lines.push(`About: ${song.about || '(the person said nothing; take it from the style)'}`);
  if (song.brief) lines.push(`The lyrics should be about: ${song.brief}`);
  lines.push(song.title ? `Song: "${song.title}"` : 'Song: not named yet');
  lines.push(`Style line: ${song.tags}`);
  lines.push(`Shape: ${SONG_SHAPES[(song.album?.at ?? Math.floor(Math.random() * SONG_SHAPES.length)) % SONG_SHAPES.length]}`);
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

/** The JSON a Claude lyricist answers with. */
export const CLAUDE_LYRICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lyrics'],
  properties: { lyrics: { type: 'string' } },
} as const;
