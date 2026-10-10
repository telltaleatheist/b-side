import { expect, test } from 'bun:test';

import { addTags, clashesWith, clashText, joinTags, splitTags, toggleTag } from '../shared/tags';

// The shape GET /v1/playground sends for yue2-3b (crucible/audio/tags/song.toml): lower-cased keys.
const conflicts = {
  slow: [{ tag: 'fast', why: 'one pace' }, { tag: 'mid-tempo', why: 'one pace' }],
  fast: [{ tag: 'slow', why: 'one pace' }],
  'mid-tempo': [{ tag: 'slow', why: 'one pace' }],
  instrumental: [{ tag: 'male vocal', why: 'an instrumental has no singer' }],
  'male vocal': [{ tag: 'Instrumental', why: 'an instrumental has no singer' }],
};

test('a pasted comma list splits into trimmed phrases, blanks dropped', () => {
  expect(splitTags(' pop,  piano pop ,, 88 BPM ,')).toEqual(['pop', 'piano pop', '88 BPM']);
});

test('adding keeps order and ignores a tag already there in any case', () => {
  expect(addTags(['Pop'], 'pop, rock, ROCK, jazz')).toEqual(['Pop', 'rock', 'jazz']);
});

test('a suggestion click adds, and a second click removes it (case-insensitive)', () => {
  const once = toggleTag(['rock'], 'Instrumental');
  expect(once).toEqual(['rock', 'Instrumental']);
  expect(toggleTag(once, 'instrumental')).toEqual(['rock']);
});

test('the request value is one comma-separated line', () => {
  expect(joinTags(['English', 'piano pop', '88 BPM'])).toBe('English, piano pop, 88 BPM');
});

test('a picked tag conflicts only with tags actually picked, each with why', () => {
  expect(clashesWith('slow', ['slow', 'rock'], conflicts)).toEqual([]);
  expect(clashesWith('slow', ['slow', 'FAST'], conflicts)).toEqual([{ tag: 'fast', why: 'one pace' }]);
  expect(clashesWith('Slow', ['slow', 'fast', 'mid-tempo'], conflicts)).toHaveLength(2);
});

test('a suggestion that would contradict a picked tag is flagged before it is picked', () => {
  // "male vocal" is not picked; Instrumental is. Its pill must still read as a conflict.
  expect(clashesWith('male vocal', ['Instrumental'], conflicts)).toEqual([
    { tag: 'Instrumental', why: 'an instrumental has no singer' },
  ]);
});

test('a tag the map does not name clashes with nothing', () => {
  expect(clashesWith('kazoo', ['slow', 'fast'], conflicts)).toEqual([]);
});

test('the tooltip names each conflict and why', () => {
  expect(clashText([{ tag: 'fast', why: 'one pace' }])).toBe('Conflicts with fast (one pace)');
  expect(clashText([])).toBe('');
});

import { withoutVoice } from '../shared/tags';

test('instrumental means no voice: every tag that asks for a singer goes, the rest stay', () => {
  expect(withoutVoice(['English', 'soul', 'warm male vocal', 'soft female voice', 'gospel choir', 'Hammond organ', 'instrumental', 'no vocals', '66 BPM']))
    .toEqual(['English', 'soul', 'Hammond organ', 'instrumental', 'no vocals', '66 BPM']);
});

test("a duet and sung harmonies are voices; an instrument's harmonies are not", () => {
  expect(withoutVoice(['folk', 'duet', 'three-part harmonies', 'twin guitar harmonies', 'banjo'])).toEqual(['folk', 'twin guitar harmonies', 'banjo']);
});
