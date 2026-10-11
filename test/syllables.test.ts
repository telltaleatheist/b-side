import { expect, test } from 'bun:test';

import { CLAUDE_SHAPES, claudeLyricsSystem, claudeLyricsUser, crammedLines, misshapenSections, SONG_SHAPES, syllableBudget, syllables } from '../shared/core/lyricist';
import { STYLE_TASKS } from '../shared/core/yue2-style';

test('a line is counted near enough to tell one YuE2 crams (Victoria, 2026-10-11)', () => {
  expect(syllables("Then he snored a snore so loud it made the sailors' hats go flap.")).toBe(15);
  expect(syllables('Hush now little one, close your eyes')).toBe(8);
});

test("slow and fast songs take 7 syllables a line, the rest 8 (YuE2's own example runs about 7)", () => {
  expect(syllableBudget('English, kids pop, playful, 110 BPM')).toBe(8);
  expect(syllableBudget('English, lullaby, soft female voice, 100 BPM')).toBe(7);
  expect(syllableBudget('English, folk, 70 BPM')).toBe(7);
  expect(syllableBudget('English, punk, 160 BPM')).toBe(7);
  expect(syllableBudget('English, pop')).toBe(8);
});

test("Claude's lyrics call carries YuE2's lyric guidance; the name calls carry none of it", () => {
  expect(claudeLyricsSystem()).toContain('Keep implementation notes out of lyrics.');
  expect(claudeLyricsSystem()).toContain('Neon fades along the lane');
  expect(STYLE_TASKS).toEqual(['[describe]', '[album]', '[tracks]']);
});

test('only sung lines well over the budget are crammed; section tags are not sung', () => {
  const lyrics = "[verse]\nThen he snored a snore so loud it made the sailors' hats go flap.\nKnock knock, who is there tonight\n\n[chorus]\n我爱你我爱你我爱你我爱你我爱你";
  expect(crammedLines(lyrics, 10)).toEqual(["Then he snored a snore so loud it made the sailors' hats go flap.", '我爱你我爱你我爱你我爱你我爱你']);
});

test("Claude is told the song's syllable budget, and the shape stays last", () => {
  const user = claudeLyricsUser({ title: 'x', tags: 'English, lullaby, 70 BPM', about: 'sleep', brief: '' });
  const lines = user.split('\n');
  expect(lines).toContain('Syllables: at most 7 per line.');
  expect(lines.at(-1)!.startsWith('Shape: ')).toBe(true);
});

test('an album track stands alone: no opener, closer or count of songs to write toward (Victoria, 2026-10-11)', () => {
  const user = claudeLyricsUser({
    title: 'Stomp Like a Cyclops', tags: 'English, kids pop, 110 BPM', about: 'Greek myths', brief: '',
    album: { title: 'Myths', artist: 'V', blurb: '', tracks: ['Stomp Like a Cyclops', 'Sirens', 'Last'], at: 0 },
  });
  expect(user).not.toMatch(/opener|closer|track 1 of/i);
  expect(user).toContain('must stand alone');
});

test('sections are 4 lines, or 8 for a verse: a 6-line chorus is named (crucible-pc-1, 2026-10-11)', () => {
  const four = 'a\nb\nc\nd';
  const six = 'a\nb\nc\nd\ne\nf';
  const eight = `${four}\n${four}`;
  expect(misshapenSections(`[Verse]\n${eight}\n\n[Chorus]\n${four}\n\n[Bridge]\n${four}`)).toEqual([]);
  expect(misshapenSections(`[Verse]\n${four}\n\n[Chorus]\n${six}`)).toEqual(['[Chorus] (6 lines)']);
  expect(misshapenSections(`[Chorus]\n${eight}`)).toEqual(['[Chorus] (8 lines)']);
  expect(claudeLyricsSystem()).toContain('Every section is exactly 4 lines, or 8 for a verse');
});

test("no pre-chorus: YuE2's score dropped it in most of Victoria's songs (Owen, 2026-10-11)", () => {
  expect(CLAUDE_SHAPES.some((shape) => shape.includes('pre-chorus'))).toBe(false);
  expect(CLAUDE_SHAPES.length).toBe(SONG_SHAPES.length);
  expect(CLAUDE_SHAPES[0]).toBe('verse, chorus, verse, chorus, bridge, chorus');
  expect(claudeLyricsSystem()).toContain('No [Pre-Chorus]');
  expect(misshapenSections('[Verse]\na\nb\nc\nd\n\n[Pre-Chorus]\na\nb\nc\nd')[0]).toContain('[Pre-Chorus] (not a section');
  // The trained shapes are left as B-Sides' model learned them.
  expect(SONG_SHAPES[0]).toContain('pre-chorus');
});
