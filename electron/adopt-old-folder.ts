/**
 * adopt-old-folder — the settings folder from when the app was called B-Side (until 2026-10-05).
 *
 * The first start as B-Sides should simply rename `B-Side` to `B-Sides`. But a `B-Sides` folder
 * can already be there (Electron makes one as it starts), and then a plain rename would be skipped
 * and the app would start with no servers and a new hub key: what happened to Owen on 2026-10-05.
 * So the old folder is merged in instead:
 *
 *   servers.json   every server either list has; one in both keeps the new folder's entry (it is
 *                  the one saved last), and the server in use stays the new one's when it has one;
 *   settings.json  the old values win, the hub key above all: it is what linked phones and browsers
 *                  hold, so keeping it keeps them working;
 *   takes/         each take the new folder lacks is moved in;
 *   anything else  moved in when the new folder lacks it (Chromium's own caches are left).
 *
 * Then the old folder is renamed `<name> (merged into <new>)`, so this runs once and nothing is
 * deleted. Runs before the hub opens anything, with the single-instance lock held.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Chromium's per-profile state: the new folder's own, never mixed with another profile's. */
const CHROMIUM = new Set([
  'blob_storage', 'Cache', 'Code Cache', 'Cookies', 'Cookies-journal', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'GPUCache', 'Local Storage', 'Network Persistent State', 'Preferences', 'Session Storage', 'Shared Dictionary',
  'SharedStorage', 'Trust Tokens', 'Trust Tokens-journal', 'SingletonCookie', 'SingletonLock', 'SingletonSocket',
]);

type ServerRow = { readonly name?: unknown } & Record<string, unknown>;
type ServerList = { servers: ServerRow[]; active?: unknown } & Record<string, unknown>;

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function serverList(value: unknown): ServerList {
  if (Array.isArray(value)) return { servers: value as ServerRow[] };
  if (value !== null && typeof value === 'object' && Array.isArray((value as ServerList).servers)) return value as ServerList;
  throw new Error('not a server list');
}

/** Both server lists as one: new entries first and winning by name, then the old ones it lacked. */
export function mergeServers(newer: unknown, older: unknown): ServerList {
  const now = serverList(newer);
  const then = serverList(older);
  const names = new Set(now.servers.map((row) => row.name));
  const servers = [...now.servers, ...then.servers.filter((row) => !names.has(row.name))];
  const active = now.active ?? then.active;
  return { ...then, ...now, servers, ...(active !== undefined ? { active } : {}) };
}

/** Move `from` into `to` when `to` exists: the merge above. When it does not: a rename. */
export function adoptOldFolder(from: string, to: string): 'none' | 'renamed' | 'merged' {
  if (!fs.existsSync(from)) return 'none';
  if (!fs.existsSync(to)) {
    fs.renameSync(from, to);
    return 'renamed';
  }
  for (const entry of fs.readdirSync(from)) {
    if (CHROMIUM.has(entry)) continue;
    const source = path.join(from, entry);
    const target = path.join(to, entry);
    if (entry === 'servers.json' && fs.existsSync(target)) {
      fs.writeFileSync(target, `${JSON.stringify(mergeServers(readJson(target), readJson(source)), null, 2)}\n`);
    } else if (entry === 'settings.json' && fs.existsSync(target)) {
      const merged = { ...(readJson(target) as object), ...(readJson(source) as object) };
      fs.writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`);
    } else if (entry === 'takes' && fs.existsSync(target) && fs.statSync(source).isDirectory()) {
      for (const take of fs.readdirSync(source)) {
        if (!fs.existsSync(path.join(target, take))) fs.renameSync(path.join(source, take), path.join(target, take));
      }
    } else if (!fs.existsSync(target)) {
      fs.renameSync(source, target);
    }
  }
  fs.renameSync(from, `${from} (merged into ${path.basename(to)})`);
  return 'merged';
}
