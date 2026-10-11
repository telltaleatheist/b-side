import { expect, test } from 'bun:test';

import { claudeLyricsUser, crammedLines, syllableBudget, syllables } from '../shared/core/lyricist';

test('a line is counted near enough to tell one YuE2 crams (Victoria, 2026-10-11)', () => {
  expect(syllables("Then he snored a snore so loud it made the sailors' hats go flap.")).toBe(15);
  expect(syllables('Hush now little one, close your eyes')).toBe(8);
});

test('slow and fast songs take 8 syllables a line, the rest 10', () => {
  expect(syllableBudget('English, kids pop, playful, 110 BPM')).toBe(10);
  expect(syllableBudget('English, lullaby, soft female voice, 100 BPM')).toBe(8);
  expect(syllableBudget('English, folk, 70 BPM')).toBe(8);
  expect(syllableBudget('English, punk, 160 BPM')).toBe(8);
  expect(syllableBudget('English, pop')).toBe(10);
});

test('only sung lines well over the budget are crammed; section tags are not sung', () => {
  const lyrics = "[verse]\nThen he snored a snore so loud it made the sailors' hats go flap.\nKnock knock, who is there tonight\n\n[chorus]\n我爱你我爱你我爱你我爱你我爱你";
  expect(crammedLines(lyrics, 10)).toEqual(["Then he snored a snore so loud it made the sailors' hats go flap.", '我爱你我爱你我爱你我爱你我爱你']);
});

test("Claude is told the song's syllable budget, and the shape stays last", () => {
  const user = claudeLyricsUser({ title: 'x', tags: 'English, lullaby, 70 BPM', about: 'sleep', brief: '' });
  const lines = user.split('\n');
  expect(lines).toContain('Syllables: at most 8 per line.');
  expect(lines.at(-1)!.startsWith('Shape: ')).toBe(true);
});
