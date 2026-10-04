import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { TakeStore, type NewTake } from '../electron/takes';
import type { ClientKind, TakeGoneReason } from '../shared/types';

let dir: string;
let gone: [string, TakeGoneReason][];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-takes-'));
  gone = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function store(perClient: Partial<Record<ClientKind, number>> = {}, bytes = 1_000_000): TakeStore {
  const made = new TakeStore(dir, { perClient: { desktop: 200, ios: 60, web: 40, ...perClient }, bytes });
  made.onGone((take, reason) => gone.push([take.id, reason]));
  return made;
}

let clock = Date.UTC(2026, 9, 4, 6, 0, 0);
function take(client: string, kind: ClientKind, seed: number, size = 10): NewTake {
  clock += 1000;
  return {
    client,
    kind,
    title: `Take ${seed}`,
    extension: 'flac',
    bytes: new Uint8Array(size).fill(seed),
    model: 'yue2-3b',
    params: { tags: 'pop', lyrics: null, instrumental: true, cfg: null, seed },
    server: { name: 'pc', url: 'http://pc:7100' },
    jobId: `job-${seed}`,
    createdAt: new Date(clock).toISOString(),
    durationS: 30,
    batch: null,
    effective: { seed },
  };
}

test('a take is audio + sidecar in its client\'s playing list, and survives a restart', async () => {
  const takes = store();
  await takes.open();
  const added = await takes.add(take('desktop', 'desktop', 1));
  await takes.add(take('tab-123456', 'web', 2));
  expect(fs.readFileSync(takes.audioPath(added.id))).toEqual(Buffer.from(new Uint8Array(10).fill(1)));

  const again = store();
  await again.open();
  expect(again.list('desktop').map((t) => t.id)).toEqual([added.id]);
  expect(again.clients()).toEqual(new Map<string, ClientKind>([['desktop', 'desktop'], ['tab-123456', 'web']]));
});

test('a client over its count loses its oldest takes first, and only its own', async () => {
  const takes = store({ web: 2 });
  await takes.open();
  const other = await takes.add(take('tab-aaaaaa', 'web', 1));
  const first = await takes.add(take('tab-bbbbbb', 'web', 2));
  const second = await takes.add(take('tab-bbbbbb', 'web', 3));
  const third = await takes.add(take('tab-bbbbbb', 'web', 4));
  expect(takes.list('tab-bbbbbb').map((t) => t.id)).toEqual([second.id, third.id]);
  expect(takes.list('tab-aaaaaa').map((t) => t.id)).toEqual([other.id]);
  expect(gone).toEqual([[first.id, 'client_cap']]);
  expect(fs.existsSync(path.join(dir, first.file))).toBe(false);
});

test('the whole cache over its bytes loses the oldest takes of anybody, never the one just added', async () => {
  const takes = store({}, 25);
  await takes.open();
  const a = await takes.add(take('desktop', 'desktop', 1));
  const b = await takes.add(take('ios-phone1', 'ios', 2));
  const c = await takes.add(take('desktop', 'desktop', 3));
  expect(gone).toEqual([[a.id, 'disk_budget']]);
  expect(takes.totalBytes()).toBe(20);
  // One take larger than the budget is still kept: it is the one somebody is about to hear.
  const big = await takes.add(take('desktop', 'desktop', 4, 40));
  expect(takes.list('desktop').map((t) => t.id)).toEqual([big.id]);
  expect(gone.map(([id]) => id)).toEqual([a.id, b.id, c.id]);
});

test('only its own client may remove a take; a closed client loses them all', async () => {
  const takes = store();
  await takes.open();
  const mine = await takes.add(take('tab-cccccc', 'web', 1));
  await takes.add(take('tab-cccccc', 'web', 2));
  await expect(takes.remove(mine.id, 'desktop')).rejects.toThrow('another device');
  await takes.remove(mine.id, 'tab-cccccc');
  expect(gone).toEqual([[mine.id, 'removed']]);
  await takes.removeClient('tab-cccccc', 'client_closed');
  expect(takes.list('tab-cccccc')).toEqual([]);
  expect(fs.readdirSync(dir)).toEqual([]);
});

test('broken cache entries are cleared at open: unreadable sidecars, audio with no sidecar, half writes', async () => {
  const takes = store();
  await takes.open();
  const kept = await takes.add(take('desktop', 'desktop', 1));
  fs.writeFileSync(path.join(dir, 'junk.json'), 'not json');
  fs.writeFileSync(path.join(dir, 'orphan.flac'), 'x');
  fs.writeFileSync(path.join(dir, 'half.flac.writing'), 'x');
  const again = store();
  await again.open();
  expect(again.list('desktop').map((t) => t.id)).toEqual([kept.id]);
  expect(fs.readdirSync(dir).sort()).toEqual([`${kept.id}.flac`, `${kept.id}.json`]);
});

test('marking a take saved records the library song it became', async () => {
  const takes = store();
  await takes.open();
  const added = await takes.add(take('desktop', 'desktop', 9));
  await takes.markSaved(added.id, 'song-9');
  const again = store();
  await again.open();
  expect(again.get(added.id).savedAs).toBe('song-9');
});
