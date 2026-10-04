import { expect, test } from 'bun:test';

import { trackTags } from '../shared/core/albums';

const PRESET = 'lo-fi, dreamy, saxophone, jazz, soul, 70 BPM, Instrumental, no vocals';

test("an album keeps the person's tags exactly, and adds only the track's turn", () => {
  expect(trackTags(PRESET, 'rain texture, brushed drums', false)).toBe(`${PRESET}, rain texture, brushed drums`);
});

test('a turn never repeats the core, nor brings a voice into an instrumental album', () => {
  expect(trackTags(PRESET, 'Jazz, soft female voice, upright bass', false)).toBe(`${PRESET}, upright bass`);
});

test('an instrumental track says so; a sung one drops "instrumental"', () => {
  expect(trackTags('city pop, warm synths', 'slap bass', false)).toBe('city pop, warm synths, slap bass, instrumental');
  expect(trackTags('city pop, instrumental, warm synths', 'raspy male vocal', true)).toBe('city pop, warm synths, raspy male vocal');
});
