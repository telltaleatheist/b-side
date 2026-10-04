import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { normaliseUrl, ServerRegistry } from '../electron/servers';

// A made-up token for the fixture: never a real one.
const TOKEN = 'not-a-real-token-123';
let dir: string;
let registry: ServerRegistry;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-servers-'));
  registry = new ServerRegistry(path.join(dir, 'servers.json'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a pairing line adds its server, makes it active, and keeps the token out of the view', async () => {
  const views = await registry.addPairing(`crucible://Mac%20Studio@192.168.68.20:7100/#${TOKEN}`);
  expect(views).toEqual([{ name: 'Mac Studio', url: 'http://192.168.68.20:7100', hasToken: true, active: true }]);
  expect(JSON.stringify(views)).not.toContain(TOKEN);
  expect(registry.active().token).toBe(TOKEN);
});

test('the same name paired again replaces its address and token instead of adding a second', async () => {
  await registry.addPairing(`crucible://pc@10.0.0.1:7100/#${TOKEN}`);
  const views = await registry.addPairing('crucible://pc@10.0.0.2:7100/#other-made-up-token');
  expect(views).toHaveLength(1);
  expect(registry.get('pc')).toEqual({ name: 'pc', url: 'http://10.0.0.2:7100', token: 'other-made-up-token' });
});

test('a line that is not a pairing line is refused, and nothing is stored', async () => {
  const bad = [
    'http://10.0.0.1:7100',
    'crucible://10.0.0.1:7100/#tok',
    'crucible://pc@10.0.0.1/#tok',
    'crucible://pc@10.0.0.1:7100',
    'crucible://pc@10.0.0.1:7100#tok',
  ];
  for (const line of bad) {
    await expect(registry.addPairing(line)).rejects.toThrow();
  }
  expect(registry.views()).toEqual([]);
});

test('an edit with no token keeps the stored one; the active server follows a rename', async () => {
  await registry.add({ name: 'pc', url: '10.0.0.1:7100', token: TOKEN });
  await registry.update('pc', { name: 'desk', url: 'http://10.0.0.1:7100/v1/', token: null });
  expect(registry.active()).toEqual({ name: 'desk', url: 'http://10.0.0.1:7100', token: TOKEN });
});

test('removing the active server hands "in use" to the next one; removing the last leaves none', async () => {
  await registry.add({ name: 'a', url: 'http://a:7100', token: TOKEN });
  await registry.add({ name: 'b', url: 'http://b:7100', token: TOKEN });
  await registry.setActive('b');
  await registry.remove('b');
  expect(registry.active().name).toBe('a');
  await registry.remove('a');
  expect(() => registry.active()).toThrow('No Crucible server is chosen');
});

test('a hand-entered server needs a token and a unique name', async () => {
  await expect(registry.add({ name: 'pc', url: 'http://pc:7100', token: '' })).rejects.toThrow('token');
  await registry.add({ name: 'pc', url: 'http://pc:7100', token: TOKEN });
  await expect(registry.add({ name: 'pc', url: 'http://pc2:7100', token: TOKEN })).rejects.toThrow('already');
});

test('addresses are normalised the way the SDK wants them', () => {
  expect(normaliseUrl('192.168.1.20:7100')).toBe('http://192.168.1.20:7100');
  expect(normaliseUrl('http://host:7100/v1/')).toBe('http://host:7100');
  expect(() => normaliseUrl('  ')).toThrow();
});
