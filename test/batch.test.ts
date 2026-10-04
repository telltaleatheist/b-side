import { expect, test } from 'bun:test';

import { batchCount, batchSeeds, MAX_BATCH, MAX_SEED } from '../shared/batch';

test('a fixed seed becomes seed, seed+1, ... in submission order', () => {
  expect(batchSeeds(41, 3)).toEqual([41, 42, 43]);
});

test('no seed means the server chooses one for every job', () => {
  expect(batchSeeds(null, 4)).toEqual([null, null, null, null]);
});

test('seeds past the largest the server takes wrap to 0, so a run never repeats one', () => {
  expect(batchSeeds(MAX_SEED - 1, 3)).toEqual([MAX_SEED - 1, MAX_SEED, 0]);
});

test('the count is 1 to 20, whole', () => {
  expect(batchCount(0)).toBe(1);
  expect(batchCount(-5)).toBe(1);
  expect(batchCount(Number.NaN)).toBe(1);
  expect(batchCount(3.9)).toBe(3);
  expect(batchCount(500)).toBe(MAX_BATCH);
  expect(batchSeeds(7, 500)).toHaveLength(MAX_BATCH);
});
