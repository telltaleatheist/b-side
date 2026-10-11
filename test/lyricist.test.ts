import { expect, test } from 'bun:test';
import { CLAUDE_SHAPES, claudeLyricsUser, SONG_SHAPES } from '../shared/core/lyricist';

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
