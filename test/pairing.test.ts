import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Pairing, PairingRequest, PairingResult } from '@crucible/client';

import { PairingSessions } from '../electron/pairing';
import { ServerRegistry } from '../electron/servers';

// Made-up credentials for the fixture: never real ones.
const TOKEN = 'not-a-real-token-123';
const REQUEST: PairingRequest = {
  url: 'http://owens-pc.example:7100',
  name: 'crucible@owens-pc',
  id: 'req-1',
  deviceCode: 'device-secret',
  userCode: 'ABCD-1234',
  expiresIn: 600,
  interval: 2,
  approvalRequired: false,
};

let dir: string;
let registry: ServerRegistry;
let now: number;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-pairing-'));
  registry = new ServerRegistry(path.join(dir, 'servers.json'));
  now = 1_000_000;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function sessions(answers: PairingResult[]): { pairing: PairingSessions; polls: () => number } {
  let polls = 0;
  const pairing = new PairingSessions(
    'b-side',
    (approved: Pairing) => registry.addPaired(approved),
    async () => REQUEST,
    async () => answers[Math.min(polls++, answers.length - 1)]!,
    () => now,
  );
  return { pairing, polls: () => polls };
}

test('an address pairs, stores the server, makes the first one active, and never shows the token or device code', async () => {
  const { pairing } = sessions([{ status: 'pending' }, { status: 'approved', pairing: { name: REQUEST.name, url: REQUEST.url, token: TOKEN } }]);
  const begun = await pairing.begin('owens-pc.example');
  expect(begun).toMatchObject({ name: 'crucible@owens-pc', userCode: 'ABCD-1234', status: 'pending', pollAfterMs: 2000 });
  expect(JSON.stringify(begun)).not.toContain('device-secret');
  expect((await pairing.poll(begun.id)).status).toBe('pending');
  const done = await pairing.poll(begun.id);
  expect(done.status).toBe('approved');
  expect(JSON.stringify(done)).not.toContain(TOKEN);
  expect(registry.views()).toEqual([{ name: 'crucible@owens-pc', url: 'http://owens-pc.example:7100', hasToken: true, active: true }]);
  expect(registry.active().token).toBe(TOKEN);
});

test('a second paired server is remembered but does not take over the one in use', async () => {
  await registry.addPairing(`crucible://studio@10.0.0.5:7100/#other-made-up-token`);
  const { pairing } = sessions([{ status: 'approved', pairing: { name: REQUEST.name, url: REQUEST.url, token: TOKEN } }]);
  await pairing.poll((await pairing.begin('owens-pc.example')).id);
  expect(registry.views().map((s) => [s.name, s.active])).toEqual([['studio', true], ['crucible@owens-pc', false]]);
});

test('pairing an address again keeps the name it was given and takes the new token', async () => {
  await registry.addPairing(`crucible://My%20PC@owens-pc.example:7100/#old-made-up-token`);
  const { pairing } = sessions([{ status: 'approved', pairing: { name: REQUEST.name, url: REQUEST.url, token: TOKEN } }]);
  const done = await pairing.poll((await pairing.begin('owens-pc.example')).id);
  expect(done.name).toBe('My PC');
  expect(registry.views()).toHaveLength(1);
  expect(registry.get('My PC').token).toBe(TOKEN);
});

test('denied, expired and cancelled requests store nothing', async () => {
  const denied = sessions([{ status: 'denied' }]).pairing;
  expect((await denied.poll((await denied.begin('x')).id)).status).toBe('denied');

  const slow = sessions([{ status: 'pending' }]);
  const begun = await slow.pairing.begin('x');
  now += 601_000;
  expect((await slow.pairing.poll(begun.id)).status).toBe('expired');
  expect(slow.polls()).toBe(0);

  const cancelled = sessions([{ status: 'approved', pairing: { name: REQUEST.name, url: REQUEST.url, token: TOKEN } }]).pairing;
  const id = (await cancelled.begin('x')).id;
  cancelled.cancel(id);
  expect((await cancelled.poll(id)).status).toBe('expired');
  expect(registry.views()).toEqual([]);
});
