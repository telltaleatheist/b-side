import { expect, test } from 'bun:test';
import type { ModelInfo } from '@crucible/client';

import { chooseTagModel } from '../shared/core/crucible';

const GIB = 1024 ** 3;

/** Only the fields chooseTagModel reads; the rest of a row does not matter here. */
function row(id: string, memoryGib: number | null, installed: boolean, backendSupported = true): ModelInfo {
  return { id, installed, backendSupported, memoryBytesEstimate: memoryGib === null ? null : memoryGib * GIB } as unknown as ModelInfo;
}

const MODEL = 'qwen3.5-4b-bside';

test('an 8 GiB card (7 GiB for models) holds the Q8_0 GGUF', () => {
  expect(chooseTagModel([row(MODEL, 5.9, true)], 7 * GIB)).toEqual({ model: MODEL, reason: null });
});

test('not installed yet is still the choice: it installs on its first use', () => {
  expect(chooseTagModel([row(MODEL, 5.9, false)], 7 * GIB).model).toBe(MODEL);
});

test('a Mac (no estimate on its row) gets it', () => {
  expect(chooseTagModel([row(MODEL, null, true)], 64 * GIB).model).toBe(MODEL);
});

test('a card that cannot hold it says why', () => {
  const chosen = chooseTagModel([row(MODEL, 5.9, true)], 4 * GIB);
  expect(chosen.model).toBeNull();
  expect(chosen.reason).toContain(`${MODEL} needs 5.9 GiB and the card leaves 4.0 GiB for models`);
});

test('a server whose build lacks it, or lacks it for its backend, says so', () => {
  expect(chooseTagModel([], 24 * GIB).reason).toContain("is not in this server's build");
  expect(chooseTagModel([row(MODEL, 5.9, true, false)], 24 * GIB).reason).toContain('no build for this server');
});

test('the removed 4-bit id is ignored, never chosen', () => {
  expect(chooseTagModel([row('qwen3.5-4b-bside-4bit', 3, true), row(MODEL, 5.9, true)], 7 * GIB).model).toBe(MODEL);
});
