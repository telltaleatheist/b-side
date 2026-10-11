import { expect, test } from 'bun:test';

import type { Playlist } from '../shared/types';
import { edgeScroll, orderAfterDrop, SongDragService } from '../src/app/core/song-drag.service';

const ORDER = ['a', 'b', 'c', 'd'];

test('a song dropped before or after another row takes that place', () => {
  expect(orderAfterDrop(ORDER, 'a', 'c', false)).toEqual(['b', 'a', 'c', 'd']);
  expect(orderAfterDrop(ORDER, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
  expect(orderAfterDrop(ORDER, 'd', 'a', false)).toEqual(['d', 'a', 'b', 'c']);
  expect(orderAfterDrop(ORDER, 'b', 'd', true)).toEqual(['a', 'c', 'd', 'b']);
});

test('a drop that leaves the order as it was changes nothing', () => {
  expect(orderAfterDrop(ORDER, 'b', 'b', true)).toBeNull();
  expect(orderAfterDrop(ORDER, 'b', 'c', false)).toBeNull();
  expect(orderAfterDrop(ORDER, 'b', 'a', true)).toBeNull();
  expect(orderAfterDrop(ORDER, 'x', 'a', true)).toBeNull();
});

test('near the top or bottom edge it scrolls, faster closer in; in the middle it stays', () => {
  expect(edgeScroll(300, 0, 600)).toBe(0);
  expect(edgeScroll(0, 0, 600)).toBe(-18);
  expect(edgeScroll(600, 0, 600)).toBe(18);
  expect(edgeScroll(32, 0, 600)).toBe(-9);
  expect(edgeScroll(-40, 0, 600)).toBe(-18);
  expect(edgeScroll(10, 0, 0)).toBe(0);
});

test('a song moves between playlists only: never into an album, never out of one', () => {
  const playlist = (id: string, album = false) => ({ id, album: album ? {} : null }) as unknown as Playlist;
  expect(SongDragService.allows(playlist('p'), playlist('q'))).toBe(true);
  expect(SongDragService.allows(playlist('p'), playlist('p'))).toBe(false);
  expect(SongDragService.allows(playlist('p'), playlist('a', true))).toBe(false);
  expect(SongDragService.allows(playlist('a', true), playlist('q'))).toBe(false);
  expect(SongDragService.allows(playlist('p'), null)).toBe(false);
});
