import { expect, test } from 'bun:test';

import { songJob } from '../shared/core/jobs';

test('a song job carries the wire names, the format and a client_ref naming the song', () => {
  const job = songJob({ tags: 'soul, warm', lyrics: '[verse]\nhi', instrumental: false, cfg: 1.5, seed: 7 }, 'mp3', 'k-42');
  expect(job).toEqual({
    type: 'audio',
    model: 'yue2-3b',
    params: { format: 'mp3', tags: 'soul, warm', lyrics: '[verse]\nhi', instrumental: false, cfg: 1.5, seed: 7 },
    inputs: {},
    clientRef: 'b-sides:k-42',
  });
});

test('a song job leaves out what was not given', () => {
  expect(songJob({ tags: 'lo-fi' }, 'flac', 'k').params).toEqual({ format: 'flac', tags: 'lo-fi' });
});

test('a length aim goes on the wire; a planning set only on an instrumental', () => {
  const instrumental = songJob({ tags: 'lo-fi', instrumental: true, min_duration_s: 120, max_duration_s: 180, planning_set: 'harbor' }, 'mp3', 'k');
  expect(instrumental.params).toMatchObject({ min_duration_s: 120, max_duration_s: 180, planning_set: 'harbor' });
  const sung = songJob({ tags: 'pop', lyrics: '[verse]\nla', instrumental: false, min_duration_s: 180, max_duration_s: 300, planning_set: 'harbor' }, 'mp3', 'k');
  expect(sung.params).toMatchObject({ min_duration_s: 180, max_duration_s: 300 });
  expect('planning_set' in sung.params).toBe(false);
});
