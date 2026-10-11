/**
 * song-tags — B-Sides' own style-tag suggestions and conflict rules for YuE2, and the
 * wording of the Make page's tags and lyrics fields.
 *
 * Until 1.0.15 these came from the server (`GET /v1/playground`, Crucible's
 * audio/tags/song.toml). They are the app's taste, not the model's (Owen, 2026-10-11:
 * Crucible is "like ollama ... called by apps and it handles all ai model management and
 * requests"), so B-Sides keeps them and no longer reads the server's.
 *
 * YuE2 publishes no tag vocabulary: its docs say only "put genre, instruments, vocal
 * character, language, and tempo in `style`", as comma-separated phrases. These are
 * suggestions in that shape, not a closed list: any phrase can be typed.
 */
import type { TagConflict, TagGroup } from './types';

const VOICES = [
  'male vocal', 'female vocal', 'deep male voice', 'soft female voice', 'raspy vocal',
  'gritty male vocal', 'powerful belting vocal', 'breathy vocal', 'rap vocal',
  'three-part harmonies', 'duet',
];

export const SONG_TAG_GROUPS: readonly TagGroup[] = [
  { group: 'Language', tags: ['English', 'Chinese'] },
  {
    group: 'Genre',
    tags: [
      'pop', 'piano pop', 'rock', 'hard rock', 'heavy metal', 'groove metal', 'punk rock',
      'country', 'bluegrass', 'folk', 'blues', 'jazz', 'soul', 'R&B', 'funk',
      'hip hop', 'trap', 'boom bap', 'EDM', 'house', 'synthwave', 'lo-fi', 'indie',
      'reggae', 'latin', 'orchestral', 'cinematic', 'acoustic ballad', 'power ballad',
    ],
  },
  {
    group: 'Mood',
    tags: [
      'emotional', 'melancholic', 'bittersweet', 'uplifting', 'energetic', 'aggressive',
      'dark', 'dreamy', 'romantic', 'nostalgic', 'playful', 'sassy', 'epic', 'calm',
      'hard-hitting', 'catchy',
    ],
  },
  { group: 'Vocal', tags: VOICES },
  {
    group: 'Instruments',
    tags: [
      'acoustic guitar', 'electric guitar', 'distorted guitar', 'palm-muted riffs',
      'pinch harmonics', 'bass guitar', 'piano', 'synth', 'strings', 'fiddle', 'banjo',
      'mandolin', 'harp', 'saxophone', 'trumpet', 'organ', '808 bass', 'drums',
      'double-kick drums', 'light drums',
    ],
  },
  {
    group: 'Tempo & sound',
    tags: [
      '70 BPM', '90 BPM', '110 BPM', '128 BPM', '140 BPM', 'slow', 'mid-tempo', 'fast',
      'polished production', 'live recording', 'vintage sound', 'wide stereo',
    ],
  },
  { group: 'Instrumental', tags: ['Instrumental', 'no vocals', 'no singing'] },
];

/**
 * Tags that contradict each other, shown red when both are picked. Only true contradictions:
 * genre blends (jazz + metal) are allowed and not listed. `exclusive`: any two clash;
 * `between`: every tag on one side clashes with every tag on the other.
 */
type ConflictRule =
  | { readonly why: string; readonly exclusive: readonly string[] }
  | { readonly why: string; readonly between: readonly [readonly string[], readonly string[]] };

const RULES: readonly ConflictRule[] = [
  { why: 'one tempo', exclusive: ['70 BPM', '90 BPM', '110 BPM', '128 BPM', '140 BPM'] },
  { why: 'one pace', exclusive: ['slow', 'mid-tempo', 'fast'] },
  { why: 'a slow tempo is not a fast song', between: [['slow', '70 BPM'], ['fast', '128 BPM', '140 BPM']] },
  { why: 'an instrumental has no singer', between: [['Instrumental', 'no vocals', 'no singing'], VOICES] },
  { why: 'light drums or a double-kick pounding, not both', between: [['light drums'], ['double-kick drums']] },
  { why: 'calm is not aggressive or driving', between: [['calm'], ['aggressive', 'energetic', 'hard-hitting']] },
  { why: 'lo-fi is not polished', between: [['lo-fi'], ['polished production']] },
];

/** Each tag (lower-cased) -> the tags it contradicts, each with why; sorted as the server sorted them. */
function conflictMap(rules: readonly ConflictRule[]): Record<string, TagConflict[]> {
  const pairs = new Map<string, Map<string, string>>();
  const clash = (a: string, b: string, why: string): void => {
    if (a.toLowerCase() === b.toLowerCase()) return;
    if (!pairs.has(a.toLowerCase())) pairs.set(a.toLowerCase(), new Map());
    if (!pairs.has(b.toLowerCase())) pairs.set(b.toLowerCase(), new Map());
    pairs.get(a.toLowerCase())?.set(b, why);
    pairs.get(b.toLowerCase())?.set(a, why);
  };
  for (const rule of rules) {
    if ('exclusive' in rule) {
      rule.exclusive.forEach((a, at) => rule.exclusive.slice(at + 1).forEach((b) => clash(a, b, rule.why)));
    } else {
      for (const a of rule.between[0]) for (const b of rule.between[1]) clash(a, b, rule.why);
    }
  }
  const map: Record<string, TagConflict[]> = {};
  for (const [tag, found] of [...pairs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    map[tag] = [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([other, why]) => ({ tag: other, why }));
  }
  return map;
}

export const SONG_TAG_CONFLICTS: Readonly<Record<string, readonly TagConflict[]>> = conflictMap(RULES);

/** The Make page's field wording (YuE2's own style example, as the placeholder). */
export const SONG_FIELD_WORDING = {
  tagsPlaceholder: 'English, warm piano pop, expressive female voice, 88 BPM',
  tagsHint: 'Type a phrase and a comma to add it, or click a suggestion.',
  lyricsPlaceholder: '[Verse]\nThe kettle sings the morning in\n\n[Chorus]\nStay, stay a while',
  lyricsHint: 'The song is as long as its lyrics.',
} as const;
