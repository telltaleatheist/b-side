import { expect, test } from 'bun:test';

import { clashesIn, composeTags, layLyrics, readFields, tagPrompt, type TagFields } from '../shared/core/describe';
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
  tagModel: 'qwen3.5-4b-bside',
  tagModelReason: null,
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
  lyrics: '[verse]\nSteam on the window\n[chorus]\nStay a little longer',
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
  expect(() => readFields('not json', 'm')).toThrow('did not answer JSON');
  expect(() => readFields(JSON.stringify({ ...fields, bpm: 'fast' }), 'm')).toThrow('missing a field');
  expect(readFields(JSON.stringify(fields), 'm').genre).toEqual(['lo-fi', 'jazz']);
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

test('a sung answer carries its lyrics; one without the field is refused', () => {
  expect(readFields(JSON.stringify(fields), 'm').lyrics).toContain('[chorus]');
  const { lyrics: _dropped, ...noLyrics } = fields;
  expect(() => readFields(JSON.stringify(noLyrics), 'm')).toThrow('missing a field');
});

test('the prompt asks for lyrics only when the song is sung', () => {
  expect(tagPrompt(page)).toContain('[verse], [chorus]');
  expect(tagPrompt(page, true)).toContain('wants it instrumental');
  expect(tagPrompt(page, true)).not.toContain('[verse], [chorus]');
});

test('lyrics with double spaces for line breaks come out one line per line, sections apart', () => {
  expect(layLyrics('[verse]  The kitchen lights are low,  The vinyl spins.  [Chorus]  Dancing with you,  my love.'))
    .toBe('[verse]\nThe kitchen lights are low,\nThe vinyl spins.\n\n[chorus]\nDancing with you,\nmy love.');
});

import { describe as describeMusic } from '../shared/core/describe';
import { crucibleText, type TextModel } from '../shared/core/text-model';

test('what the lyrics are about rides after the description, and never on an instrumental', async () => {
  const sent: string[] = [];
  const client = {
    models: async () => [{ id: 'qwen3.5-4b-bside', installed: true }],
    chat: async (options: { messages: { role: string; content: string }[] }) => {
      sent.push(options.messages[options.messages.length - 1]?.content ?? '');
      return { content: JSON.stringify(fields), finishReason: 'stop' };
    },
  } as never;
  const writer = crucibleText(client, 'qwen3.5-4b-bside');
  await describeMusic(writer, page, 'retro soul ballad', false, 'a banana going brown, bittersweet');
  // v2: the task tag is the user message's first line.
  expect(sent[0]).toBe('[describe]\nretro soul ballad\nThe lyrics: a banana going brown, bittersweet');
  const answer = await describeMusic(writer, page, 'retro soul ballad', true, 'a banana going brown');
  expect(sent[1]).toBe('[describe]\nretro soul ballad');
  expect(answer.lyrics).toBeNull();
  expect(answer.tags.some((tag) => /voice/i.test(tag))).toBe(false);
});

test('any writer answers describe: Claude gets the content and the prompt, without the task tag', async () => {
  const asked: { tag: string; user: string; system: string }[] = [];
  const claude: TextModel = {
    name: 'claude-sonnet-5-5',
    ask: async (request) => { asked.push(request); return { content: JSON.stringify(fields), truncated: false }; },
  };
  const answer = await describeMusic(claude, page, 'retro soul ballad', false, 'a banana going brown');
  expect(asked[0]!.tag).toBe('[describe]');
  expect(asked[0]!.user).toBe('retro soul ballad\nThe lyrics: a banana going brown');
  expect(answer.model).toBe('claude-sonnet-5-5');
  const cut: TextModel = { name: 'w', ask: async () => ({ content: '{', truncated: true }) };
  await expect(describeMusic(cut, page, 'retro soul ballad')).rejects.toThrow('ran out of room');
});
