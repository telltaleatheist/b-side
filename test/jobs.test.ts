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
