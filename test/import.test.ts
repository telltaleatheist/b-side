import { expect, test } from 'bun:test';

import { titleOf } from '../src/app/core/import.service';

test('a dropped file is titled from its name', () => {
  expect(titleOf('oh-banana-soul-ballad.flac')).toBe('Oh Banana Soul Ballad');
  expect(titleOf('night_drive  v2.mp3')).toBe('Night Drive V2');
  expect(titleOf('Already Fine.wav')).toBe('Already Fine');
});

import { nameUrl } from '../src/app/core/peers.service';

test('a library is looked for by its computer name when its address moves', () => {
  expect(nameUrl('http://192.168.68.52:7300', 'DESKTOP-OT9RUMI')).toBe('http://desktop-ot9rumi.local:7300');
  expect(nameUrl('http://192.168.68.52:7300', 'owens-mac-studio.local')).toBe('http://owens-mac-studio.local:7300');
});
