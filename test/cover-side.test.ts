import { afterEach, expect, test } from 'bun:test';

import { coverSide } from '../shared/core/hub-core';

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

function serve(body: unknown, status = 200): void {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

const pc = { name: 'pc', url: 'http://pc:7100/', token: 't' };

test("a cover is painted at its native size when the model needs more than 256 (DreamShaper: 1024), at 256 for qwen-image", async () => {
  serve({ pages: [
    { id: 'dreamshaper-xl-lightning', facts: { quality_min_side: 768, native_size: 1024 } },
    { id: 'dreamshaper-pair', facts: { quality_min_side: 768, native_size: [1024, 1024] } },
    { id: 'dreamshaper-object', facts: { quality_min_side: 768, native_size: { width: 1024, height: 1024 } } },
    { id: 'qwen-image-2.1', facts: { quality_min_side: 256, native_size: 1024 } },
  ] });
  expect(await coverSide(pc, 'dreamshaper-xl-lightning')).toBe(1024);
  expect(await coverSide(pc, 'dreamshaper-pair')).toBe(1024);
  expect(await coverSide(pc, 'dreamshaper-object')).toBe(1024);
  expect(await coverSide(pc, 'qwen-image-2.1')).toBe(256);
});

test('a server that publishes no facts, or will not say, gets the 256 it always had', async () => {
  serve({ pages: [{ id: 'qwen-image-2.1' }] });
  expect(await coverSide(pc, 'qwen-image-2.1')).toBe(256);
  serve({ error: 'no' }, 500);
  expect(await coverSide(pc, 'qwen-image-2.1')).toBe(256);
  serve({ pages: [{ id: 'odd', facts: { quality_min_side: 700 } }] });
  expect(await coverSide(pc, 'odd')).toBe(704);
});
