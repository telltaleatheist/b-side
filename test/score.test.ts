import { expect, test } from 'bun:test';
import { SCORE_INPUT, settleSong, songJob } from '../shared/core/jobs';
import { trackSong } from '../shared/core/albums';

const ABC = 'X:1\nT:Waltz\nM:3/4\nL:1/16\nQ:1/4=76\nV:Vocal\nV:Ins\nK:Em\n% verse\nV:Vocal\nE4 E4 E4 |\nV:Ins\nZ4 |\n';

test('a full score goes as the one named input, and nothing Crucible refuses beside it (Victoria, 2026-10-13)', () => {
  // Instrumental: the score alone, no planning lyrics, no negative, no header, tags as given.
  const inst = settleSong({ tags: 'cello melody, A minor, waltz, 64 BPM, instrumental', instrumental: true, seed: 7, score: ABC });
  const job = songJob(inst, 'mp3', 'k', undefined, false, true, true);
  const wire = job.params as Record<string, unknown>;
  expect(wire['score']).toBe(SCORE_INPUT);
  expect(Object.keys(job.inputs)).toEqual([SCORE_INPUT]);
  const input = job.inputs[SCORE_INPUT] as { inline: Uint8Array };
  expect(new TextDecoder().decode(input.inline)).toBe(ABC);
  expect(wire['instrumental']).toBe(true);
  expect(wire).not.toHaveProperty('lyrics');
  expect(wire).not.toHaveProperty('planning_lyrics');
  expect(wire).not.toHaveProperty('negative_tags');
  expect(wire).not.toHaveProperty('key');
  expect(wire).not.toHaveProperty('meter');
  expect(wire['tags']).toBe('cello melody, A minor, waltz, 64 BPM, instrumental');
  // Sung: the words go as written (their sections are the score's).
  const sung = songJob({ tags: 'mezzo-soprano, waltz', lyrics: '[Verse]\nla', instrumental: false, score: ABC }, 'mp3', 'k', undefined, false, true, true).params as Record<string, unknown>;
  expect(sung['score']).toBe(SCORE_INPUT);
  expect(sung['lyrics']).toBe('[Verse]\nla');
  expect(sung).not.toHaveProperty('key');
  // Without a score: no input at all.
  expect(songJob({ tags: 'x', lyrics: 'y', instrumental: false }, 'mp3', 'k').inputs).toEqual({});
});

test('an album track sent from a score carries no aim and no planning set', () => {
  const page = { length: true } as Parameters<typeof trackSong>[2];
  const scored = trackSong({ tags: 'x', instrumental: true, aim: { min: 100, max: 200 }, score: ABC }, 3, page);
  expect(scored.score).toBe(ABC);
  expect(scored).not.toHaveProperty('min_duration_s');
  expect(scored).not.toHaveProperty('planning_set');
  const planned = trackSong({ tags: 'x', instrumental: true, aim: { min: 100, max: 200 } }, 3, page);
  expect(planned.min_duration_s).toBe(100);
  expect(planned.planning_set).toBeDefined();
});
