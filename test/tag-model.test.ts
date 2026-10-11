import { expect, test } from 'bun:test';
import type { ModelInfo } from '@crucible/client';

import { chooseTagModel } from '../shared/core/crucible';

const GIB = 1024 ** 3;

/** Only the fields chooseTagModel reads; the rest of a row does not matter here. */
function row(id: string, memoryGib: number | null, installed: boolean, backendSupported = true): ModelInfo {
  return { id, installed, backendSupported, memoryBytesEstimate: memoryGib === null ? null : memoryGib * GIB } as unknown as ModelInfo;
}

// Until Crucible's chat takes a size ceiling itself (crucible-pc-1, feat/chat-verb-ceiling): the
// stock 4B at 16-bit where it fits, its 8-bit form where it does not (Owen, 2026-10-11).
const FULL = 'qwen3.5-4b';
const EIGHT = 'qwen3.5-4b-8bit';

test('a 24 GiB card gets the 16-bit 4B', () => {
  expect(chooseTagModel([row(FULL, 13.4, true), row(EIGHT, 6.3, true)], 22 * GIB)).toEqual({ model: FULL, reason: null });
});

test("an 8 GiB card (7 GiB for models) gets the 8-bit form: the 16-bit one does not fit", () => {
  expect(chooseTagModel([row(FULL, 13.4, true), row(EIGHT, 6.3, false)], 7 * GIB).model).toBe(EIGHT);
});

test('not installed yet is still the choice: it installs on its first use', () => {
  expect(chooseTagModel([row(FULL, 13.4, false)], 22 * GIB).model).toBe(FULL);
});

test('a Mac (no estimate on its row) gets the 16-bit 4B', () => {
  expect(chooseTagModel([row(FULL, null, true)], 64 * GIB).model).toBe(FULL);
});

test('a card that cannot hold either says why', () => {
  const chosen = chooseTagModel([row(FULL, 13.4, true), row(EIGHT, 6.3, true)], 4 * GIB);
  expect(chosen.model).toBeNull();
  expect(chosen.reason).toContain(`${EIGHT} needs 6.3 GiB and the card leaves 4.0 GiB for models`);
});

test('a server whose build lacks them, or lacks them for its backend, says so', () => {
  expect(chooseTagModel([], 24 * GIB).reason).toContain("is not in this server's build");
  expect(chooseTagModel([row(FULL, 13.4, true, false)], 24 * GIB).reason).toContain('no build for this server');
});

test("B-Sides' own model is not chosen for now (Owen, 2026-10-11: \"its still not working correctly\")", () => {
  expect(chooseTagModel([row('qwen3.5-4b-bside', 5.9, true), row(FULL, 13.4, true)], 22 * GIB).model).toBe(FULL);
});
