import { expect, test } from 'bun:test';
import { songJob, settleSong } from '../shared/core/jobs';
import { NEGATIVE_CFG, NEGATIVE_VOICES, negativeLyrics, negativeTags } from '../shared/negative';

const TAGS = 'Instrumental, clean guitar melody, progressive metal, A minor, 90 BPM, no vocals, no singing, no choir, no spoken words.';

test('the negative tags name every voice first, then the song\'s own tags without its "no vocals" phrases', () => {
  expect(negativeTags(TAGS)).toBe(`${NEGATIVE_VOICES}, clean guitar melody, progressive metal, A minor, 90 BPM`);
  expect(negativeTags('instrumental')).toBe(NEGATIVE_VOICES);
});

test('the negative lyrics are a verse of the first four real lines; section tags are not lines', () => {
  expect(negativeLyrics('[Intro]\n\n[Verse]\nOne\nTwo\n\n[Chorus]\nThree\nFour\nFive\n')).toBe('[Verse]\nOne\nTwo\nThree\nFour\n');
});

test('an instrumental on a server with a negative sends negative_tags, negative_lyrics and cfg 2 (Owen, 2026-10-12)', () => {
  const params = settleSong({ tags: TAGS, instrumental: true, seed: 13 });
  const wire = songJob(params, 'mp3', 'k', undefined, false, true).params as Record<string, unknown>;
  expect(wire['negative_tags']).toBe(negativeTags(TAGS));
  expect(wire['negative_lyrics']).toMatch(/^\[Verse\]\n(.+\n){4}$/);
  expect(wire['cfg']).toBe(NEGATIVE_CFG);
  expect(wire['instrumental']).toBe(true);
  expect(wire['planning_lyrics']).toBeDefined();
  // The person's own cfg wins.
  expect((songJob({ ...params, cfg: 1.3 }, 'mp3', 'k', undefined, false, true).params as Record<string, unknown>)['cfg']).toBe(1.3);
});

test('no negative without the server, for a sung song, or for a listening test\'s exact lyrics', () => {
  const params = settleSong({ tags: TAGS, instrumental: true, seed: 13 });
  expect(songJob(params, 'mp3', 'k').params).not.toHaveProperty('negative_tags');
  expect(songJob({ tags: 'pop', lyrics: '[verse]\nla', instrumental: false }, 'mp3', 'k', undefined, false, true).params).not.toHaveProperty('negative_tags');
  expect(songJob({ ...params, experiment: { lyrics: '[Verse]\n\n[Chorus]' } }, 'mp3', 'k', undefined, false, true).params).not.toHaveProperty('negative_tags');
});
