import { expect, test } from 'bun:test';
import type { ModelInfo } from '@crucible/client';

import { chooseTagModel } from '../shared/core/crucible';

const GIB = 1024 ** 3;

/** Only the fields chooseTagModel reads; the rest of a row does not matter here. */
function row(id: string, memoryGib: number | null, installed: boolean, backendSupported = true): ModelInfo {
  return { id, installed, backendSupported, memoryBytesEstimate: memoryGib === null ? null : memoryGib * GIB } as unknown as ModelInfo;
}

const FULL = 'qwen3.5-4b-bside';
const FOUR = 'qwen3.5-4b-bside-4bit';

test('a card that holds the full model gets it', () => {
  expect(chooseTagModel([row(FULL, 12.5, true), row(FOUR, 5, false)], 24 * GIB)).toEqual({ model: FULL, reason: null });
});

test('an 8 GiB card gets the 4-bit model, installed or not (it installs on first use)', () => {
  expect(chooseTagModel([row(FULL, 12.5, true), row(FOUR, 5, false)], 8 * GIB).model).toBe(FOUR);
  expect(chooseTagModel([row(FULL, 12.5, false), row(FOUR, 5, true)], 8 * GIB).model).toBe(FOUR);
});

test('among models that fit, an installed one wins over a download', () => {
  expect(chooseTagModel([row(FULL, 12.5, false), row(FOUR, 5, true)], 24 * GIB).model).toBe(FOUR);
});

test('a Mac (no 4-bit build for its backend) keeps the full model', () => {
  expect(chooseTagModel([row(FULL, null, true), row(FOUR, 5, false, false)], 64 * GIB).model).toBe(FULL);
});

test('an older server without the 4-bit model still gets the full one where it fits', () => {
  expect(chooseTagModel([row(FULL, 12.5, true)], 24 * GIB).model).toBe(FULL);
});

test('a card that holds neither says why, model by model', () => {
  const chosen = chooseTagModel([row(FULL, 12.5, true), row(FOUR, 5, false)], 4 * GIB);
  expect(chosen.model).toBeNull();
  expect(chosen.reason).toContain(`${FULL} needs 12.5 GiB and the card has 4.0 GiB`);
  expect(chosen.reason).toContain(`${FOUR} needs 5.0 GiB`);
});

test('a server whose build has neither says so', () => {
  expect(chooseTagModel([], 24 * GIB).reason).toContain('is not in this server\'s build');
});
