import { expect, test } from 'bun:test';

import { titleOf } from '../src/app/core/import.service';

test('a dropped file is titled from its name', () => {
  expect(titleOf('oh-banana-soul-ballad.flac')).toBe('Oh Banana Soul Ballad');
  expect(titleOf('night_drive  v2.mp3')).toBe('Night Drive V2');
  expect(titleOf('Already Fine.wav')).toBe('Already Fine');
});
