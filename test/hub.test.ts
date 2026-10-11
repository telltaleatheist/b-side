import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Hub } from '../electron/hub/hub';
import type { HubEvent, LibraryView, Take } from '../shared/types';

// The hub as a browser or the phone meets it: real HTTP on a real port, no Electron.
let root: string;
let hub: Hub;
let base: string;
let key: string;

const desktop = { 'X-BSide-Client': 'desktop', 'X-BSide-Client-Kind': 'desktop' };
const tab = { 'X-BSide-Client': 'tab-abcdef12', 'X-BSide-Client-Kind': 'web' };

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-hub-'));
  const userData = path.join(root, 'userData');
  const appRoot = path.join(root, 'app');
  fs.mkdirSync(userData);
  fs.mkdirSync(appRoot);
  fs.writeFileSync(path.join(appRoot, 'index.html'), '<!doctype html><title>B-Side</title>');
  fs.writeFileSync(path.join(appRoot, 'main-ABCDEFGH.js'), 'console.log(1)');
  const port = 20000 + Math.floor(Math.random() * 20000);
  // Turned off by hand: the default is shared, and these tests stay on this computer.
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ hubPort: port, sharing: false }));
  // Forward slashes, as a caller on Windows may well pass it: the root check must still hold.
  hub = new Hub({ userData, defaultLibraryDir: path.join(root, 'library'), appRoot: appRoot.replace(/\\/g, '/'), version: '0.0.0-test' });
  await hub.start();
  ({ url: base, key } = hub.localAddress());
});

afterAll(async () => {
  await hub.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

function api(route: string, init: RequestInit & { client?: Record<string, string> } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'X-BSide-Key': key, ...(init.client ?? desktop) };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${base}${route}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
}

async function addTake(client: string, kind: 'desktop' | 'web', seed: number): Promise<Take> {
  return hub.takes.add({
    client,
    kind,
    title: `Take ${seed}`,
    extension: 'flac',
    fill: async (file: string) => { const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, seed]); fs.writeFileSync(file, bytes); return bytes.byteLength; },
    model: 'yue2-3b',
    params: { tags: 'folk', lyrics: '[verse]\nhello', instrumental: false, cfg: null, seed },
    server: { name: 'pc', url: 'http://pc:7100' },
    jobId: `job-${seed}`,
    createdAt: new Date(Date.UTC(2026, 9, 4, 6, 0, seed)).toISOString(),
    durationS: 12,
    batch: null,
    effective: { seed },
  });
}

/** The first event on a client's stream: its snapshot. */
async function snapshotOf(client: Record<string, string>): Promise<Extract<HubEvent, { type: 'snapshot' }>['snapshot']> {
  const controller = new AbortController();
  const query = `client=${client['X-BSide-Client']}&kind=${client['X-BSide-Client-Kind']}&key=${encodeURIComponent(key)}`;
  const response = await fetch(`${base}/api/events?${query}`, { signal: controller.signal });
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  let text = '';
  while (!text.includes('\n\n')) {
    const { value } = await reader.read();
    text += new TextDecoder().decode(value);
  }
  controller.abort();
  const event = JSON.parse(text.slice('data: '.length, text.indexOf('\n\n'))) as HubEvent;
  if (event.type !== 'snapshot') throw new Error(`first event was ${event.type}`);
  return event.snapshot;
}

test('the web app is served without a key; index.html for any page that is not a file', async () => {
  const page = await fetch(`${base}/settings`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('<title>B-Side</title>');
  const script = await fetch(`${base}/main-ABCDEFGH.js`);
  expect(script.headers.get('cache-control')).toContain('immutable');
  expect((await fetch(`${base}/../../secret`)).status).toBe(200); // normalised by URL parsing: it is just index.html
});

test('no key by default (as Ollama); once required, every /api request needs it and says so by code', async () => {
  expect((await fetch(`${base}/api/settings`)).status).toBe(200);
  expect((await api('/api/settings/require-key', { method: 'PUT', body: JSON.stringify({ requireKey: true }) })).status).toBe(200);
  try {
    const response = await fetch(`${base}/api/settings`);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('hub_key');
    const wrong = await fetch(`${base}/api/settings`, { headers: { 'X-BSide-Key': `${key}x` } });
    expect(wrong.status).toBe(401);
    expect((await api('/api/settings')).status).toBe(200);
  } finally {
    await api('/api/settings/require-key', { method: 'PUT', body: JSON.stringify({ requireKey: false }) });
  }
});

test('settings: sharing turned off stays off: this computer only, no links', async () => {
  const settings = (await (await api('/api/settings')).json()) as Record<string, unknown>;
  expect(settings).toMatchObject({ sharing: false, requireKey: false, local: true, links: [] });
});

test('a client\'s snapshot holds its own takes only', async () => {
  const mine = await addTake('desktop', 'desktop', 1);
  await addTake('tab-abcdef12', 'web', 2);
  const snapshot = await snapshotOf(desktop);
  expect(snapshot.hub.app).toBe('b-side');
  expect(snapshot.takes.map((t) => t.id)).toEqual([mine.id]);
  expect(snapshot.jobs).toEqual([]);
});

test('take audio streams with Range, so a player can seek', async () => {
  const take = await addTake('desktop', 'desktop', 3);
  const whole = await fetch(`${base}/api/takes/${take.id}/audio?key=${encodeURIComponent(key)}`);
  expect(whole.status).toBe(200);
  expect(whole.headers.get('content-type')).toBe('audio/flac');
  expect([...new Uint8Array(await whole.arrayBuffer())]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 3]);
  const part = await api(`/api/takes/${take.id}/audio`, { headers: { Range: 'bytes=2-4' } });
  expect(part.status).toBe(206);
  expect(part.headers.get('content-range')).toBe('bytes 2-4/10');
  expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([2, 3, 4]);
});

test('saving a take into a playlist files it once; leaving its last playlist deletes it', async () => {
  const take = await addTake('desktop', 'desktop', 4);
  let library = (await (await api('/api/playlists', { method: 'POST', body: JSON.stringify({ name: 'Porch' }) })).json()) as LibraryView;
  const porch = library.playlists.find((p) => p.name === 'Porch');
  expect(porch).toBeDefined();
  library = (await (await api(`/api/playlists/${porch!.id}/songs`, { method: 'POST', body: JSON.stringify({ takeId: take.id }) })).json()) as LibraryView;
  const songId = library.playlists.find((p) => p.id === porch!.id)!.songs[0] as string;
  expect(hub.takes.get(take.id).savedAs).toBe(songId);
  library = (await (await api(`/api/playlists/${porch!.id}/songs`, { method: 'POST', body: JSON.stringify({ takeId: take.id }) })).json()) as LibraryView;
  expect(library.songs.filter((s) => s.id === songId)).toHaveLength(1);

  const audio = await api(`/api/songs/${songId}/audio`);
  expect([...new Uint8Array(await audio.arrayBuffer())]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 4]);

  library = (await (await api(`/api/playlists/${porch!.id}/songs/${songId}`, { method: 'DELETE' })).json()) as LibraryView;
  expect(library.songs.some((s) => s.id === songId)).toBe(false);
  expect((await api(`/api/songs/${songId}/audio`)).status).toBe(404);
});

test('a take is removed only by its own device; a missing one is a 404 with a code', async () => {
  const take = await addTake('tab-abcdef12', 'web', 5);
  const refused = await api(`/api/takes/${take.id}`, { method: 'DELETE' });
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('take_not_yours');
  expect((await api(`/api/takes/${take.id}`, { method: 'DELETE', client: tab })).status).toBe(200);
  const missing = await api(`/api/takes/${take.id}/audio`);
  expect(missing.status).toBe(404);
});

test('a request that does not say which device it is from is refused by name', async () => {
  const response = await fetch(`${base}/api/jobs`, {
    method: 'POST',
    headers: { 'X-BSide-Key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ params: {}, count: 1 }),
  });
  expect(response.status).toBe(400);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('client_invalid');
});

test('generating with no Crucible server chosen says how to get one', async () => {
  const response = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ params: { tags: 'folk' }, count: 1 }) });
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('no_server');
});

test('an unknown route is a 404 that names it', async () => {
  const response = await api('/api/nothing-here');
  expect(response.status).toBe(404);
  expect(((await response.json()) as { error: { message: string } }).error.message).toContain('/api/nothing-here');
});

test('a dropped song file lands in New Songs (made the first time), or in the playlist it was dropped on', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const put = (query: string): Promise<Response> =>
    fetch(`${base}/api/import/song?${query}`, { method: 'PUT', body: bytes, headers: { 'X-BSide-Key': key, ...desktop } });
  const first = await put('name=oh-banana.flac&title=Oh%20Banana&duration=204.2');
  expect(first.status).toBe(200);
  let view = (await first.json()) as LibraryView;
  const singles = view.playlists.find((p) => p.name === 'New Songs');
  expect(singles).toBeDefined();
  const song = view.songs.find((s) => s.id === singles?.songs[0]);
  expect(song).toMatchObject({ title: 'Oh Banana', durationS: 204.2, bytes: 5, model: 'imported' });
  expect(song?.file.endsWith('.flac')).toBe(true);

  const made = (await (await api('/api/playlists', { method: 'POST', body: JSON.stringify({ name: 'Road' }) })).json()) as LibraryView;
  const road = made.playlists.find((p) => p.name === 'Road') as { id: string };
  view = (await (await put(`name=drive.mp3&playlist=${road.id}`)).json()) as LibraryView;
  const into = view.playlists.find((p) => p.id === road.id);
  expect(into?.songs.length).toBe(1);
  expect(view.songs.find((s) => s.id === into?.songs[0])?.title).toBe('drive');
  expect(view.playlists.find((p) => p.name === 'New Songs')?.songs.length).toBe(1);

  const wrong = await put('name=notes.txt');
  expect(wrong.status).toBe(400);
});

test('a song\'s lyrics can be set (and its title kept)', async () => {
  const view = (await (await fetch(`${base}/api/import/song?name=words.mp3`, { method: 'PUT', body: new Uint8Array([9]), headers: { 'X-BSide-Key': key, ...desktop } })).json()) as LibraryView;
  const song = view.songs.find((s) => s.title === 'words') as { id: string };
  const after = (await (await api(`/api/songs/${song.id}`, { method: 'PATCH', body: JSON.stringify({ lyrics: '[verse]\r\nhello there\r\n' }) })).json()) as LibraryView;
  expect(after.songs.find((s) => s.id === song.id)?.params).toMatchObject({ lyrics: '[verse]\nhello there', instrumental: false });
  expect(after.songs.find((s) => s.id === song.id)?.title).toBe('words');
});

test('another B-Sides reads who this one is, and its library, with the address alone', async () => {
  const info = (await (await fetch(`${base}/api/info`, { headers: tab })).json()) as { app: string; hostname: string };
  expect(info.app).toBe('b-side');
  expect(typeof info.hostname).toBe('string');
  const library = await fetch(`${base}/api/library`, { headers: tab });
  expect(library.status).toBe(200);
  expect(library.headers.get('access-control-allow-origin')).toBe('*');
});

test("an album's cover can be the person's own image, which replaces the one before", async () => {
  const meta = {
    artist: 'X', blurb: '', cover: null, ask: { description: 'd', tags: [], minutes: 15, sung: false },
    plan: null, stage: 'done', sent: 0, madeS: 0, refusal: null, server: 'pc', writer: null,
  };
  const file = '20261010-010000-9.mp3';
  await fetch(`${base}/api/import/files/${file}`, { method: 'PUT', body: new Uint8Array([7]), headers: { 'X-BSide-Key': key, ...desktop } });
  const song = { id: '20261010-010000-9', title: 'T', file, model: 'yue2-3b', params: { tags: null, lyrics: null, instrumental: true, cfg: null, seed: 1 }, server: { name: 'pc', url: 'http://pc:7100' }, jobId: 'j', createdAt: new Date().toISOString(), durationS: 1, batch: null, album: null, bytes: 1, effective: null };
  const imported = await api('/api/import/albums', { method: 'POST', body: JSON.stringify({ id: 'own-cover', name: 'Own Cover', createdAt: new Date().toISOString(), album: meta, songs: [song] }) });
  expect(imported.status).toBe(200);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
  const first = (await (await api('/api/albums/own-cover/cover', { method: 'PUT', body: JSON.stringify({ image: png, type: 'image/png' }) })).json()) as LibraryView;
  const cover = first.playlists.find((p) => p.id === 'own-cover')?.album?.cover as string;
  expect(cover).toMatch(/^own-cover-.*\.cover\.png$/);
  const served = await api('/api/albums/own-cover/cover');
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  await new Promise((rest) => setTimeout(rest, 5));
  const second = (await (await api('/api/albums/own-cover/cover', { method: 'PUT', body: JSON.stringify({ image: png, type: 'image/jpeg' }) })).json()) as LibraryView;
  expect(second.playlists.find((p) => p.id === 'own-cover')?.album?.cover).toMatch(/\.cover\.jpg$/);
  const refused = await api('/api/albums/own-cover/cover', { method: 'PUT', body: JSON.stringify({ image: png, type: 'image/svg+xml' }) });
  expect(refused.status).toBe(400);
});

test('folders: made, renamed, filled, reordered and deleted over the API; the snapshot and every client see them', async () => {
  const call = async (route: string, method: string, body?: unknown): Promise<LibraryView> => {
    const response = await api(route, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    expect(response.status).toBe(200);
    return (await response.json()) as LibraryView;
  };
  let view = await call('/api/folders', 'POST', { name: 'Greek Myths' });
  const myths = view.folders?.find((f) => f.name === 'Greek Myths') as { id: string };
  view = await call('/api/folders', 'POST', { name: 'Odyssey', parent: myths.id });
  const odyssey = view.folders?.find((f) => f.name === 'Odyssey') as { id: string; parent: string | null };
  expect(odyssey.parent).toBe(myths.id);
  view = await call(`/api/folders/${odyssey.id}`, 'PATCH', { name: 'The Odyssey' });
  expect(view.folders?.find((f) => f.id === odyssey.id)?.name).toBe('The Odyssey');

  view = await call('/api/playlists', 'POST', { name: 'Sirens' });
  const sirens = view.playlists.find((p) => p.name === 'Sirens') as { id: string };
  view = await call('/api/playlists', 'POST', { name: 'Cyclops' });
  const cyclops = view.playlists.find((p) => p.name === 'Cyclops') as { id: string };
  await call(`/api/playlists/${sirens.id}`, 'PATCH', { folder: odyssey.id });
  view = await call(`/api/playlists/${cyclops.id}`, 'PATCH', { folder: odyssey.id, before: sirens.id });
  expect(view.playlists.filter((p) => p.folder === odyssey.id).map((p) => p.name)).toEqual(['Cyclops', 'Sirens']);

  // Out to the top, and the folder moved to the top too.
  view = await call(`/api/folders/${odyssey.id}`, 'PATCH', { parent: null });
  expect(view.folders?.find((f) => f.id === odyssey.id)?.parent).toBeNull();

  const snapshot = await snapshotOf(tab);
  expect(snapshot.library.folders?.map((f) => f.name)).toEqual(['Greek Myths', 'The Odyssey']);

  // Deleted: its albums and playlists move up a level, never deleted.
  view = await call(`/api/folders/${odyssey.id}`, 'DELETE');
  expect(view.folders?.some((f) => f.id === odyssey.id)).toBe(false);
  expect(view.playlists.filter((p) => p.id === sirens.id || p.id === cyclops.id).map((p) => p.folder)).toEqual([null, null]);

  const missing = await api(`/api/folders/${odyssey.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'x' }) });
  expect(missing.status).toBe(404);
  expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('folder_missing');
  const nowhere = await api(`/api/playlists/${sirens.id}`, { method: 'PATCH', body: JSON.stringify({ folder: 'gone' }) });
  expect(nowhere.status).toBe(404);
  const empty = await api(`/api/folders/${myths.id}`, { method: 'PATCH', body: JSON.stringify({}) });
  expect(((await empty.json()) as { error: { code: string } }).error.code).toBe('body_invalid');
});

test("Make → Album's folder: the new album lands in it; a folder that is gone is refused, and nothing is started", async () => {
  // A server nobody answers at: the album is filed, then its writing fails on its own time.
  expect((await api('/api/servers', { method: 'POST', body: JSON.stringify({ name: 'nowhere', url: 'http://127.0.0.1:9', token: 't' }) })).status).toBe(200);
  try {
    const made = (await (await api('/api/folders', { method: 'POST', body: JSON.stringify({ name: 'Lullabies' }) })).json()) as LibraryView;
    const lullabies = made.folders?.find((f) => f.name === 'Lullabies') as { id: string };
    const ask = { description: 'lullabies', tags: [], minutes: 15 };
    const refused = await api('/api/albums', { method: 'POST', body: JSON.stringify({ ...ask, folder: 'gone' }) });
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('folder_missing');
    const before = ((await (await api('/api/library')).json()) as LibraryView).playlists.length;
    const started = await api('/api/albums', { method: 'POST', body: JSON.stringify({ ...ask, folder: lullabies.id }) });
    expect(started.status).toBe(200);
    const { id } = (await started.json()) as { id: string };
    const library = (await (await api('/api/library')).json()) as LibraryView;
    expect(library.playlists.length).toBe(before + 1);
    expect(library.playlists.find((p) => p.id === id)?.folder).toBe(lullabies.id);
    await api(`/api/playlists/${id}`, { method: 'DELETE' });
  } finally {
    await api('/api/servers/nowhere', { method: 'DELETE' });
  }
});

test("an album's download lists its songs in order, with the cover", async () => {
  const files = await hub.albumFiles('own-cover');
  expect(files.name).toBe('Own Cover');
  expect(files.tracks.map((track) => track.title)).toEqual(['T']);
  expect(files.tracks[0]?.lyrics).toBeNull();
  expect(files.cover).toMatch(/\.cover\.jpg$/);
  expect(fs.existsSync(files.tracks[0]?.file as string)).toBe(true);
});
