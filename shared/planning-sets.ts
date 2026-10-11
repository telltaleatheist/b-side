/**
 * planning-sets — the words a YuE2 instrumental is planned from and never sings, B-Sides' own
 * (Owen, 2026-10-11: Crucible serves models, like Ollama; what a song is made from is the app's).
 *
 * An instrumental's score is planned like a sung song's, from lyric lines, so its melody has a
 * sung song's bounded phrases; Crucible then moves that melody to the instrument and re-plans
 * from the fixed score with section tags only, so the words are never sung. Planned from empty
 * sections, nothing bounded the score: 4 of 13 instrumentals on Victoria's laptop ran it to its
 * 4096-token cap (2026-10-10).
 *
 * Crucible picked the set (its pool, crucible/audio/planning/yue2.toml, by the seed or named by
 * `planning_set`) and sized it toward `min_duration_s`/`max_duration_s`
 * (crucible/jobs/audio/planning.py). Since 2026-10-11 B-Sides does both and sends the result as
 * `planning_lyrics`, which Crucible has planned exactly as sent since 1.0.93: the sets below are
 * the pool copied verbatim (Crucible 2.0.0), and `check`, `Sizing` and `aim` are planning.py's,
 * ported line for line (checked against it on all ten sets). A set that fails `check` is a bug
 * here, caught by test/planning-sets.test.ts, never a refusal for the person to read.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The rules (planning.py `check`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The section labels YuE2 writes into a score and its yue2-music skill accepts back
 * (crucible/jobs/audio/yue2music/compile_score.py SECTIONS, via planning.py). A tag outside them
 * would come back as a score label the skill refuses.
 */
export const SECTIONS: ReadonlySet<string> = new Set(['intro', 'verse', 'pre-chorus', 'chorus', 'bridge', 'interlude', 'outro', 'instrumental']);

/**
 * What planning lyrics may hold (planning.py): a sung song of 16 lines scores 1800 to 2600 of the
 * score's 4096 tokens, so 36 lines is past what any score can hold; 2000 characters is 36 lines
 * of 55. Crucible refuses planning lyrics past either.
 */
export const MAX_LINES = 36;
export const MAX_CHARS = 2000;

/** Planning lyrics that cannot plan an instrumental; the message says why (planning.py PlanningLyricsError). */
export class PlanningLyricsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanningLyricsError';
  }
}

export interface PlanningSection {
  /** The tag as the text spells it, e.g. `[Verse]`. */
  readonly tag: string;
  /** The tag's label, lower-cased: `verse`. */
  readonly label: string;
  readonly lines: readonly string[];
}

/** Python's str.splitlines(): every line boundary it knows, so a text splits here as it does on the server. */
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/**
 * `text`'s sections, or PlanningLyricsError naming the first rule it breaks: section tags only
 * from YuE2's own (SECTIONS), never one tag twice in a row (the skill refuses a score whose
 * labels repeat back to back), a tag on a line of its own, words only after a tag, at least one
 * line of words, at most MAX_LINES lines and MAX_CHARS characters. The same rules Crucible holds
 * a client's `planning_lyrics` to (planning.py `check`).
 */
export function check(text: string): PlanningSection[] {
  const found: { tag: string; label: string; lines: string[] }[] = [];
  for (const raw of text.split(LINE_BREAK)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('[') && line.endsWith(']') && count(line, '[') === 1 && count(line, ']') === 1) {
      // Python's casefold; the labels are ASCII, where it is toLowerCase.
      const label = line.slice(1, -1).trim().toLowerCase();
      if (!SECTIONS.has(label)) {
        const names = [...SECTIONS].sort().map((name) => `[${title(name)}]`).join(', ');
        throw new PlanningLyricsError(`'${line}' is not one of YuE2's section tags; use ${names}`);
      }
      if (found.length > 0 && found[found.length - 1]!.label === label) {
        throw new PlanningLyricsError(
          `'${line}' follows another '${line}'; YuE2's score cannot carry the same section twice in a row, so put the lines in one section or another tag between them`,
        );
      }
      found.push({ tag: line, label, lines: [] });
      continue;
    }
    if (line.includes('[') || line.includes(']')) {
      throw new PlanningLyricsError(`'${line}' mixes a section tag with words; a tag such as [Verse] goes on a line of its own`);
    }
    if (found.length === 0) {
      throw new PlanningLyricsError(`'${line}' comes before any section tag; start with one such as [Verse]`);
    }
    found[found.length - 1]!.lines.push(line);
  }
  const lines = found.reduce((sum, section) => sum + section.lines.length, 0);
  if (lines === 0) {
    throw new PlanningLyricsError('has no lines of words, only section tags; planning lyrics are words the score is planned from (never sung)');
  }
  if (lines > MAX_LINES) {
    throw new PlanningLyricsError(`has ${lines} lines of words; at most ${MAX_LINES} fit in a score (a sung song of 16 lines scores 1800 to 2600 of its 4096 tokens)`);
  }
  // Python's len counts code points, not UTF-16 units.
  const chars = [...text].length;
  if (chars > MAX_CHARS) {
    throw new PlanningLyricsError(`is ${chars} characters; at most ${MAX_CHARS} (about ${MAX_LINES} lines of 55)`);
  }
  return found;
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** Python's str.title() for a section label: `pre-chorus` is `Pre-Chorus`. */
function title(label: string): string {
  return label.replace(/[a-z]+/g, (word) => word[0]!.toUpperCase() + word.slice(1));
}

// ─────────────────────────────────────────────────────────────────────────────
// The sets (crucible/audio/planning/yue2.toml, Crucible 2.0.0)
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanningSet {
  readonly id: string;
  /** Its structure, in words. */
  readonly shape: string;
  readonly lyrics: string;
}

/**
 * The pool, in Crucible's file order (so a seed picks the set it picked there). One set for every
 * instrumental would give scores that sound alike (Owen, 2026-10-10): the sets differ in
 * structure (section order and count, intro/outro, 3 to 6 lines a section, lines of 4-6 or 8-11
 * syllables), each sized against B-Sides' sung shape ([Verse] [Chorus] [Verse] [Chorus], four
 * lines of 6 to 9 syllables), which scores 1800 to 2600 tokens. The words are original and
 * deliberately generic, since words colour the melody. Adding, removing or reordering sets
 * changes which set a seed picks; a song's record keeps the id it was planned from.
 */
export const PLANNING_SETS: readonly PlanningSet[] = [
  {
    id: 'lantern',
    shape: 'verse, chorus, verse, chorus; 4 lines each; 7-9 syllables (B-Sides\' sung shape)',
    lyrics: `[Verse]
A lantern burning by the gate
The evening settles on the stone
A quiet road goes winding down
And every window holds a glow

[Chorus]
Carry the light a little way
Over the hill and through the rain
Somewhere the morning waits for us
Carry the light a little way

[Verse]
The river talks beneath the bridge
The swallows circle once and go
A cart wheel turning in the dust
The hours fall like gentle snow

[Chorus]
Carry the light a little way
Over the hill and through the rain
Somewhere the morning waits for us
Carry the light a little way
`,
  },
  {
    id: 'harbor',
    shape: 'intro, verse, pre-chorus, chorus, verse, pre-chorus, chorus, outro; verses and pre-choruses 3 lines, choruses 4; 5-6 syllables',
    lyrics: `[Intro]

[Verse]
Boats along the shore
Ropes against the rail
Gulls above the sand

[Pre-Chorus]
Wait now for the tide
Hold until it turns
Hear the water call

[Chorus]
Out past the harbor wall
Into the open blue
Sails full of morning air
Out past the harbor wall

[Verse]
Nets laid out to dry
Salt upon the boards
Bells across the bay

[Pre-Chorus]
Wait now for the tide
Hold until it turns
Hear the water call

[Chorus]
Out past the harbor wall
Into the open blue
Sails full of morning air
Out past the harbor wall

[Outro]
`,
  },
  {
    id: 'meadow',
    shape: 'verse, chorus, verse, chorus, bridge, chorus; verses 4 lines, choruses and bridge 3; 4-6 syllables',
    lyrics: `[Verse]
Grass in the wind
Seeds on the air
Clouds drifting slow
Over the field

[Chorus]
Turning with the sun
Leaning with the light
All the meadow sways

[Verse]
Bees in the clover
Rain on the hill
Fence posts and thistle
Shade by the well

[Chorus]
Turning with the sun
Leaning with the light
All the meadow sways

[Bridge]
Far from the road
Nothing to hurry for
Only the green and gold

[Chorus]
Turning with the sun
Leaning with the light
All the meadow sways
`,
  },
  {
    id: 'stairwell',
    shape: 'AABA: verse, interlude, verse, bridge, verse; 4, 3, 3 and 3 lines; 10-11 syllables',
    lyrics: `[Verse]
The stairway climbs in circles past the doors
Each landing keeps a different kind of air
A song drifts down from somewhere up above
And footsteps answer softly on the floor

[Interlude]

[Verse]
The windows catch the colour of the day
A curtain lifts and settles like a breath
The railing warm beneath an open hand

[Bridge]
Up past the roof the evening opens wide
A thousand lights are coming on below
And nothing that we left has gone away

[Verse]
So down the stairs and out into the street
The doors all closing gently one by one
The stairway keeps its circles for tomorrow
`,
  },
  {
    id: 'tidewater',
    shape: 'through-composed, nothing repeats: verse, pre-chorus, chorus, bridge; 5, 4, 5 and 4 lines; 7-8 syllables',
    lyrics: `[Verse]
Morning comes in grey and slow
Fog lies low along the reeds
Herons standing in the shallows
Water moving out to sea
Every channel finds its way

[Pre-Chorus]
Something gathers in the distance
Something turning with the hour
Hold the oar and feel it pulling
Let the current carry on

[Chorus]
Wide and silver goes the river
Past the marsh and past the mill
All the land is leaning seaward
All the sky is open still
Wide and silver goes the river

[Bridge]
Evening comes in gold and low
Lamps along the water's edge
Every channel finds the sea
Every tide returns again
`,
  },
  {
    id: 'ember',
    shape: 'chorus first: chorus, verse, chorus, verse, chorus; choruses 3 lines, verses 4; 7 syllables',
    lyrics: `[Chorus]
Keep the fire burning low
Keep the embers glowing bright
Warm until the morning comes

[Verse]
Snow is resting on the eaves
Wind is leaning on the pane
Kettle hanging on the hook
Shadows dancing on the wall

[Chorus]
Keep the fire burning low
Keep the embers glowing bright
Warm until the morning comes

[Verse]
Stories told beside the hearth
Blankets folded on the chair
Candles burning slowly down
Nobody has far to go

[Chorus]
Keep the fire burning low
Keep the embers glowing bright
Warm until the morning comes
`,
  },
  {
    id: 'orchard',
    shape: 'verse, chorus, bridge, verse, chorus; long verses (4 lines, 10 syllables), short choruses (3 lines, 4-5), bridge 3 lines of 7',
    lyrics: `[Verse]
The orchard rows run down to meet the stream
And every branch is bending with its fruit
The ladders lean against the oldest trees
And baskets wait in shadow by the gate

[Chorus]
Gather it in
Gather it all
Before the first frost

[Bridge]
Seasons turning round the hill
Leaves of copper, leaves of rust
Seed and blossom, fruit and fall

[Verse]
The cider press is turning in the barn
The wasps are drowsy in the amber light
The carts go rolling heavy down the lane
And swallows gather on the wire to leave

[Chorus]
Gather it in
Gather it all
Before the first frost
`,
  },
  {
    id: 'crossing',
    shape: 'verse, pre-chorus, chorus, interlude, verse, pre-chorus, chorus, outro; verses and pre-choruses 3 lines, choruses 4; 5-8 syllables',
    lyrics: `[Verse]
Trains are calling through the valley
Lights are moving on the line
Station clocks above the platform

[Pre-Chorus]
Doors are opening
Steam is rising high
Here it comes again

[Chorus]
All along the crossing
Every road meets every other
All along the crossing
Someone waves and travels on

[Interlude]

[Verse]
Fields go flying past the window
Towns go by without a name
Rivers shining under bridges

[Pre-Chorus]
Doors are opening
Steam is rising high
Here it comes again

[Chorus]
All along the crossing
Every road meets every other
All along the crossing
Someone waves and travels on

[Outro]
`,
  },
  {
    id: 'market',
    shape: 'verse, chorus, verse, chorus, outro; verses 6 short lines (5 syllables), choruses 4 lines of 7',
    lyrics: `[Verse]
Awnings in the square
Apples piled in rows
Bread upon the boards
Coins in open palms
Voices rising high
Pigeons on the tiles

[Chorus]
Come and see what morning brought
Come and stay a little while
Every stall a different shade
Every face a different smile

[Verse]
Flowers by the well
Ribbons on a line
Copper pots that shine
Baskets on the arm
Shadows growing short
Church bells ringing noon

[Chorus]
Come and see what morning brought
Come and stay a little while
Every stall a different shade
Every face a different smile

[Outro]
`,
  },
  {
    id: 'northlight',
    shape: 'intro, verse, chorus, verse, chorus, bridge, chorus; verses 3 long lines (10 syllables), choruses 3 lines of 6, bridge 4 short lines of 5',
    lyrics: `[Intro]

[Verse]
The northern sky is shimmering in green
The frozen lake is still as polished glass
We stand outside with breath like drifting smoke

[Chorus]
Look up and see it turn
Ribbons across the dark
Older than any name

[Verse]
The pines are standing silent in the snow
The cabin lamp is small against the night
And every star is sharper than before

[Chorus]
Look up and see it turn
Ribbons across the dark
Older than any name

[Bridge]
Cold and clear and wide
Light on light on light
Turning slow and high
Gone before the dawn

[Chorus]
Look up and see it turn
Ribbons across the dark
Older than any name
`,
  },
];

/** The set a seed plans from: number (seed mod the number of sets), in order (planning.py `pick`). */
export function pickSet(seed: number): PlanningSet {
  return PLANNING_SETS[seed % PLANNING_SETS.length]!;
}

/** An album's track `track` (0-based): the sets in turn, so each instrumental has its own structure (crucible-pc-1, 2026-10-10). */
export function trackSet(track: number): PlanningSet {
  return PLANNING_SETS[track % PLANNING_SETS.length]!;
}

/** The set named `id`, or null (a song kept from a pool B-Sides no longer has). */
export function namedSet(id: string): PlanningSet | null {
  return PLANNING_SETS.find((entry) => entry.id === id) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sizing toward a length (planning.py, Crucible's docs/AUDIO.md "Song length")
// ─────────────────────────────────────────────────────────────────────────────
//
// An instrumental asked for a length is planned, once, from its set made longer or shorter by
// whole sections: the set's body (every section between a leading [Intro] and a trailing [Outro])
// is cut short from its end, or carried on past it by starting the body over, so a longer song
// repeats the set's own verses and choruses in its own order. Each size is a count of body
// sections, so sizes are few, ordered and the same every time.

/**
 * Seconds of score a planning line makes (planning.py PRIOR_SECONDS_PER_LINE): the median of the
 * PC's first nine pool instrumentals (2026-10-10, one per set, 66 to 112 BPM), 5.7 to 12.0 s a
 * line. Crucible 1.0.137's card check (21 scores) put the median at 8.9 and the spread at 4.7 to
 * 14.4, so the tempo the model picks moves a score far more than the prior's last decimal; 8.6
 * stays. It aims the one score; nothing re-plans (Owen: "strictly one pass").
 */
export const PRIOR_SECONDS_PER_LINE = 8.6;

/** How far inside the range a size is aimed: 10% in from each end, so a score a little off its estimate still lands (planning.py AIM_MARGIN). */
export const AIM_MARGIN = 0.10;

/** YuE2's longest song (yue2-3b.toml `max_duration_s`): the far end of a range sent without a maximum. */
export const YUE2_LONGEST_S = 360;

const FRAME_OPENING = 'intro';
const FRAME_CLOSING = 'outro';

function sectionText(section: PlanningSection): string {
  return [section.tag, ...section.lines].join('\n');
}

/** Sections as planning text: blank lines between, a newline at the end (planning.py `render`). */
export function render(parts: readonly PlanningSection[]): string {
  return `${parts.map(sectionText).join('\n\n')}\n`;
}

/**
 * The sizes one planning text comes in (planning.py `Sizing`): `text(n)` has n body sections, for
 * every n in `sizes`, and each passes `check`, so none is longer than a score can hold.
 */
export class Sizing {
  private constructor(
    readonly base: string,
    readonly opening: readonly PlanningSection[],
    readonly body: readonly PlanningSection[],
    readonly closing: readonly PlanningSection[],
    readonly sizes: readonly number[],
  ) {}

  static of(text: string): Sizing {
    const parts = check(text);
    let start = 0;
    while (start < parts.length && parts[start]!.label === FRAME_OPENING) start += 1;
    let stop = parts.length;
    while (stop > start && parts[stop - 1]!.label === FRAME_CLOSING) stop -= 1;
    const opening = parts.slice(0, start);
    const body = parts.slice(start, stop);
    const closing = parts.slice(stop);
    if (body.length === 0) throw new PlanningLyricsError('has no sections between its intro and outro to size');
    const unsized = new Sizing(text, opening, body, closing, []);
    const sizes: number[] = [];
    for (let n = 1; ; n += 1) {
      try {
        check(render(unsized.parts(n)));
      } catch (error) {
        if (!(error instanceof PlanningLyricsError)) throw error;
        if (n >= body.length) break;
        continue;
      }
      sizes.push(n);
    }
    return new Sizing(text, opening, body, closing, sizes);
  }

  /** The body sections the text has as written. */
  get written(): number {
    return this.body.length;
  }

  private carried(n: number): PlanningSection[] {
    if (n <= this.body.length) return this.body.slice(0, n);
    if (new Set(this.body.map((part) => part.label)).size < 2) {
      throw new PlanningLyricsError('has one kind of section in its body, so it cannot grow');
    }
    const carried = [...this.body];
    for (let index = 0; carried.length < n; index += 1) {
      const part = this.body[index % this.body.length]!;
      // Starting the body over must not put one section after another of its kind (check).
      if (part.label !== carried[carried.length - 1]!.label) carried.push(part);
    }
    return carried;
  }

  private parts(n: number): PlanningSection[] {
    return [...this.opening, ...this.carried(n), ...this.closing];
  }

  /** The planning text with `n` body sections; the text as written for its own count, so a song not resized plans from exactly its set's words. */
  text(n: number): string {
    if (!this.sizes.includes(n)) throw new RangeError(`${n} body sections is not one of this text's sizes (${this.sizes.join(', ')})`);
    return n === this.written ? this.base : render(this.parts(n));
  }

  lines(n: number): number {
    return this.parts(n).reduce((sum, part) => sum + part.lines.length, 0);
  }

  /** The section labels of size `n`, in order. */
  structure(n: number): string[] {
    return this.parts(n).map((part) => part.label);
  }
}

/** A length range (planning.py `LengthRange`); either end may be absent, and `ceiling` is the far end then. */
export interface LengthRange {
  readonly min: number | null;
  readonly max: number | null;
  readonly ceiling?: number;
}

/** Whether `seconds` lands in the range (planning.py `LengthRange.holds`). */
export function holds(range: LengthRange, seconds: number): boolean {
  return (range.min === null || seconds >= range.min) && (range.max === null || seconds <= range.max);
}

/** Where a size is aimed: AIM_MARGIN in from each end, or the middle of a range too narrow for that (planning.py `LengthRange.window`). */
export function aimWindow(range: LengthRange): [number, number] {
  const low = range.min ?? 0;
  const high = range.max ?? range.ceiling ?? YUE2_LONGEST_S;
  const inner: [number, number] = [low * (1 + AIM_MARGIN), high * (1 - AIM_MARGIN)];
  if (inner[0] > inner[1]) {
    const middle = (low + high) / 2;
    return [middle, middle];
  }
  return inner;
}

/**
 * The body-section count to plan the one score from (planning.py `aim`): the size whose estimate
 * (its lines at `secondsPerLine`) lands in the window, the fewest sections from the text as
 * written first (a set that already fits is left as it is); if none lands there, the nearest.
 */
export function aim(sizing: Sizing, wanted: LengthRange, secondsPerLine: number = PRIOR_SECONDS_PER_LINE): number {
  const [low, high] = aimWindow(wanted);
  const miss = (n: number): number => {
    const estimate = sizing.lines(n) * secondsPerLine;
    return Math.max(low - estimate, estimate - high, 0);
  };
  const key = (n: number): [number, number, number] => [miss(n), Math.abs(n - sizing.written), n];
  let best: number | null = null;
  for (const n of sizing.sizes) {
    if (best === null || before(key(n), key(best))) best = n;
  }
  if (best === null) throw new PlanningLyricsError('has no size that passes the rules');
  return best;
}

function before(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

/** What an instrumental is planned from: its set's id, and the text sent as `planning_lyrics`. */
export interface Planned {
  readonly id: string;
  readonly lyrics: string;
  /** Body sections, when the set was sized toward a length; null when planned as written. */
  readonly sections: number | null;
}

/**
 * The planning lyrics for `set`, sized toward `range` when there is one (Crucible's `_score`, done
 * here), and run through `check` before they go: a text that fails it is B-Sides' bug, thrown as
 * one, not something the server should be left to refuse.
 */
export function planningLyrics(set: PlanningSet, range: LengthRange | null): Planned {
  let lyrics = set.lyrics;
  let sections: number | null = null;
  if (range !== null && (range.min !== null || range.max !== null)) {
    const sizing = Sizing.of(set.lyrics);
    sections = aim(sizing, range);
    lyrics = sizing.text(sections);
  }
  check(lyrics);
  return { id: set.id, lyrics, sections };
}
