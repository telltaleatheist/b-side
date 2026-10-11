import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { nodeDisk } from '../electron/node-disk';
import { PresetStore } from '../shared/core/presets';
import type { StoredServer } from '../shared/core/servers';
import type { Preset } from '../shared/types';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-presets-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const pc: StoredServer = { name: 'PC', url: 'http://pc:8000', token: '' };
const mac: StoredServer = { name: 'Mac', url: 'http://mac:8000', token: '' };
const preset = (name: string, tags: string): Preset => ({ name, params: { instrumental: false, tags }, savedAt: '2026-10-01T00:00:00Z' });
const form = { tags: 'doom metal', lyrics: '', instrumental: true, cfg: null };

test("each server's presets come over once and stay on the server", async () => {
  const asked: string[] = [];
  const held: Record<string, Preset[]> = {
    [pc.url]: [preset('Dusk', 'synthwave'), preset('Storm', 'metal')],
    [mac.url]: [preset('Dusk', 'synthwave'), preset('Storm', 'folk')],
  };
  const store = new PresetStore(nodeDisk, dir, async (server) => { asked.push(server.name); return held[server.url] ?? []; });
  const names = (await store.list([pc, mac])).map((p) => p.name);
  // The same sound under the same name is one preset; a different one keeps its server's name beside it.
  expect(names).toEqual(['Dusk', 'Storm', 'Storm (Mac)']);
  await store.list([pc, mac]);
  expect(asked).toEqual(['PC', 'Mac']);
  // Kept by the app: a fresh store reads them from disk without asking again.
  const reopened = new PresetStore(nodeDisk, dir, async () => { throw new Error('asked again'); });
  expect((await reopened.list([pc, mac])).map((p) => p.name)).toEqual(['Dusk', 'Storm', 'Storm (Mac)']);
});

test('a server that does not answer is asked again later, and nothing is lost meanwhile', async () => {
  let now = 0;
  let up = false;
  const store = new PresetStore(nodeDisk, dir, async () => { if (!up) throw new Error('offline'); return [preset('Old', 'jazz')]; }, () => now);
  await store.save([pc], 'New', form);
  expect((await store.list([pc])).map((p) => p.name)).toEqual(['New']);
  up = true;
  expect((await store.list([pc])).map((p) => p.name)).toEqual(['New']);
  now = 61_000;
  expect((await store.list([pc])).map((p) => p.name)).toEqual(['New', 'Old']);
});

test('saving keeps the form without a seed; deleting one brought over does not bring it back', async () => {
  const store = new PresetStore(nodeDisk, dir, async () => [preset('Old', 'jazz')]);
  const saved = await store.save([pc], ' Doom ', { ...form, lyrics: 'never kept for an instrumental' });
  expect(saved.find((p) => p.name === 'Doom')?.params).toEqual({ instrumental: true, tags: 'doom metal' });
  expect((await store.remove([pc], 'Old')).map((p) => p.name)).toEqual(['Doom']);
  expect((await new PresetStore(nodeDisk, dir, async () => [preset('Old', 'jazz')]).list([pc])).map((p) => p.name)).toEqual(['Doom']);
});
