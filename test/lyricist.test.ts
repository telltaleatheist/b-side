import { expect, test } from 'bun:test';
import { CLAUDE_SHAPES, claudeLyricsUser, shapeFor, SONG_SHAPES } from '../shared/core/lyricist';

test('"Lyrics length" sets the shape: 4 lines, 8 lines, the song\'s own, or more of it (Owen, 2026-10-12)', () => {
  const song = { title: 'Ithaca', tags: 'English, folk', about: 'the long way home', brief: '' };
  const shapeLine = (length?: 'very-short' | 'short' | 'normal' | 'long'): string =>
    claudeLyricsUser({ ...song, ...(length ? { length } : {}) }).split('\n').find((line) => line.startsWith('Shape: ')) as string;
  expect(shapeLine('very-short')).toBe('Shape: verse (4 lines) only. The whole song is these 4 lines: no chorus, no bridge, no intro or outro.');
  expect(shapeLine('short')).toBe('Shape: verse (4 lines), chorus (4 lines). The whole song is these 8 lines: no bridge, no intro or outro.');
  expect(CLAUDE_SHAPES).toContain(shapeLine('normal').slice('Shape: '.length));
  expect(CLAUDE_SHAPES).toContain(shapeLine().slice('Shape: '.length));
  // Long: one more verse and chorus before the bridge, every verse 8 lines.
  expect(shapeFor('long', 'verse, chorus, verse, chorus, bridge, chorus')).toBe('verse, chorus, verse, chorus, verse, chorus, bridge, chorus; every verse 8 lines.');
  expect(shapeFor('long', 'verse, pre-chorus, chorus, verse, pre-chorus, chorus, bridge, chorus')).toBe('verse, pre-chorus, chorus, verse, pre-chorus, chorus, verse, pre-chorus, chorus, bridge, chorus; every verse 8 lines.');
  // No bridge: after the last chorus, before any outro.
  expect(shapeFor('long', 'chorus, verse, chorus, verse, chorus')).toBe('chorus, verse, chorus, verse, chorus, verse, chorus; every verse 8 lines.');
  expect(shapeFor('long', 'verse, chorus, verse, chorus, outro (4 lines)')).toBe('verse, chorus, verse, chorus, verse, chorus, outro (4 lines); every verse 8 lines.');
});

test("an album's tracks are handed different shapes, in turn", () => {
  const tracks = ['A', 'B', 'C'];
  const shapes = tracks.map((title, at) =>
    claudeLyricsUser({ title, tags: 'pop', about: '', brief: '', album: { title: 'X', artist: 'Y', blurb: '', tracks, at } })
      .split('\n').find((line) => line.startsWith('Shape: ')));
  expect(shapes).toEqual(CLAUDE_SHAPES.slice(0, 3).map((shape) => `Shape: ${shape}`));
});

test('no shape asks for an intro or outro shorter than 4 lines', () => {
  for (const shape of SONG_SHAPES) expect(shape).not.toMatch(/(intro|outro)(?! \(4 lines\))/);
});

test('"Pronounce phonetically" asks for names written as they sound', () => {
  const song = { title: 'Ithaca', tags: 'English, folk', about: 'the long way home', brief: '' };
  expect(claudeLyricsUser({ ...song, phonetic: true })).toContain('per-SEF-oh-nee');
  expect(claudeLyricsUser(song)).not.toContain('Pronounce phonetically');
});
