import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { adoptOldFolder, mergeServers } from '../electron/adopt-old-folder';

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsides-adopt-'));
  made.push(dir);
  return dir;
}

function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

test('servers in both lists are kept once, the newer entry winning, and the server in use stays the new one', () => {
  const merged = mergeServers(
    { servers: [{ name: 'pc', token: 'new' }], active: 'pc' },
    { servers: [{ name: 'pc', token: 'old' }, { name: 'mac', token: 'm' }], active: 'mac' },
  );
  expect(merged.servers).toEqual([{ name: 'pc', token: 'new' }, { name: 'mac', token: 'm' }]);
  expect(merged.active).toBe('pc');
});

test('an existing new folder is merged into, not skipped: servers, the old hub key, takes, and the rest', () => {
  const root = scratch();
  const from = path.join(root, 'B-Side');
  const to = path.join(root, 'B-Sides');
  write(path.join(from, 'servers.json'), { servers: [{ name: 'pc', token: 'old' }, { name: 'mac', token: 'm' }], active: 'pc' });
  write(path.join(from, 'settings.json'), { hubKey: 'OLD-KEY' });
  write(path.join(from, 'pending.json'), '[]');
  write(path.join(from, 'takes', 'a.mp3'), 'a');
  write(path.join(from, 'Local Storage', 'x'), 'chromium');
  write(path.join(to, 'servers.json'), { servers: [{ name: 'pc', token: 'new' }], active: 'pc' });
  write(path.join(to, 'settings.json'), { hubKey: 'NEW-KEY' });
  write(path.join(to, 'takes', 'b.mp3'), 'b');

  expect(adoptOldFolder(from, to)).toBe('merged');
  const servers = JSON.parse(fs.readFileSync(path.join(to, 'servers.json'), 'utf8'));
  expect(servers.servers.map((s: { name: string }) => s.name)).toEqual(['pc', 'mac']);
  expect(servers.servers[0].token).toBe('new');
  expect(JSON.parse(fs.readFileSync(path.join(to, 'settings.json'), 'utf8')).hubKey).toBe('OLD-KEY');
  expect(fs.existsSync(path.join(to, 'pending.json'))).toBe(true);
  expect(fs.readdirSync(path.join(to, 'takes')).sort()).toEqual(['a.mp3', 'b.mp3']);
  expect(fs.existsSync(path.join(to, 'Local Storage'))).toBe(false);
  expect(fs.existsSync(from)).toBe(false);
  expect(fs.existsSync(`${from} (merged into B-Sides)`)).toBe(true);
  // Once only: the old folder is out of the way.
  expect(adoptOldFolder(from, to)).toBe('none');
});

test('with no new folder yet, it is a plain rename', () => {
  const root = scratch();
  write(path.join(root, 'B-Side', 'servers.json'), { servers: [] });
  expect(adoptOldFolder(path.join(root, 'B-Side'), path.join(root, 'B-Sides'))).toBe('renamed');
  expect(fs.existsSync(path.join(root, 'B-Sides', 'servers.json'))).toBe(true);
});
