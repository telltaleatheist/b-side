import { expect, test } from 'bun:test';

import { levelsOf, readWav } from '../shared/core/voice-check';

function wav16(samples: number[], rate: number): Uint8Array {
  const data = samples.length * 2;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const put = (at: number, text: string): void => { for (let i = 0; i < 4; i++) bytes[at + i] = text.charCodeAt(i); };
  put(0, 'RIFF'); view.setUint32(4, 36 + data, true); put(8, 'WAVE');
  put(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, data, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.round(s * 32767), true));
  return bytes;
}

test('a quiet second and a loud one read as such', () => {
  const rate = 100;
  const silent = new Array(rate).fill(0);
  const loud = Array.from({ length: rate }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5));
  const { samples, rate: read } = readWav(wav16([...silent, ...loud], rate));
  expect(read).toBe(rate);
  const levels = levelsOf(samples, read);
  expect(levels.perSecond).toEqual([-100, -6]);
  expect(levels.secondsAbove['-20']).toBe(1);
  expect(levels.loudest).toBe(-6);
});
