import { expect, test } from 'bun:test';

import { clashesIn, composeTags, readFields, tagPrompt, type TagFields } from '../shared/core/describe';
import type { SongPage } from '../shared/types';

const page: SongPage = {
  model: 'yue2-3b',
  name: 'YuE2',
  standing: 'ready',
  available: true,
  reason: null,
  downloadBytes: null,
  tagsPlaceholder: null,
  tagsHint: null,
  suggestions: [
    { group: 'Language', tags: ['English', 'Chinese'] },
    { group: 'Genre', tags: ['lo-fi', 'jazz'] },
    { group: 'Instrumental', tags: ['Instrumental'] },
  ],
  conflicts: { 'male vocal': [{ tag: 'female vocal', why: 'one lead voice' }], 'female vocal': [{ tag: 'male vocal', why: 'one lead voice' }] },
  lyricsPlaceholder: null,
  lyricsHint: null,
  instrumental: true,
  cfg: null,
  seed: null,
};

const fields: TagFields = {
  language: 'English',
  genre: ['lo-fi', 'jazz'],
  mood: ['dreamy'],
  vocal: ['soft female voice'],
  instruments: ['saxophone', 'Saxophone', 'piano, rhodes'],
  sound: ['vintage sound'],
  bpm: 84.4,
  instrumental: false,
};

test('tags come out in YuE2\'s order, each once, commas never splitting a phrase', () => {
  expect(composeTags(fields)).toEqual([
    'English', 'lo-fi', 'jazz', 'dreamy', 'soft female voice', 'saxophone', 'piano rhodes', 'vintage sound', '84 BPM',
  ]);
});

test('an instrumental answer drops any voice the model named anyway', () => {
  expect(composeTags({ ...fields, instrumental: true })).not.toContain('soft female voice');
});

test('a malformed answer is refused by name, never guessed at', () => {
  expect(() => readFields('not json')).toThrow('did not answer JSON');
  expect(() => readFields(JSON.stringify({ ...fields, bpm: 'fast' }))).toThrow('missing a field');
  expect(readFields(JSON.stringify(fields)).genre).toEqual(['lo-fi', 'jazz']);
});

test('clashes are reported with the server\'s reason, not dropped', () => {
  expect(clashesIn(['English', 'male vocal', 'female vocal'], page)).toEqual([
    'male vocal: Conflicts with female vocal (one lead voice)',
    'female vocal: Conflicts with male vocal (one lead voice)',
  ]);
});

test('the prompt offers the server\'s phrases as examples, without the language and instrumental groups', () => {
  const prompt = tagPrompt(page);
  expect(prompt).toContain('- Genre: lo-fi, jazz');
  expect(prompt).not.toContain('- Language:');
  expect(prompt).not.toContain('- Instrumental:');
});
