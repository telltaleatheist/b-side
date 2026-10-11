import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { nodeDisk } from '../electron/node-disk';
import { ADOPTED_PLAYLIST, Library, type ImportedAlbum, type NewSong } from '../shared/core/library';
import type { AlbumMeta } from '../shared/types';

let dir: string;
let scratch: string;
let library: Library;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-library-'));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-take-'));
  library = new Library(nodeDisk, dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(scratch, { recursive: true, force: true });
});

function song(seed: number, at: Date): NewSong {
  const audio = path.join(scratch, `take-${seed}-${at.getTime()}.flac`);
  fs.writeFileSync(audio, new Uint8Array([102, 76, 97, 67, seed]));
  return {
    title: `Song ${seed}`,
    model: 'yue2-3b',
    params: { tags: 'pop, 88 BPM', lyrics: '[Verse]\nla la', instrumental: false, cfg: 1, seed },
    server: { name: 'pc', url: 'http://pc:7100' },
    jobId: `job-${seed}`,
    durationS: 181.5,
    batch: { index: 1, of: 2 },
    effective: { seed, audio_seconds: 181.5 },
    createdAt: at.toISOString(),
    audioFrom: audio,
    bytes: 5,
  };
}

test('saving to a playlist files the song (audio + sidecar) and lists it back after a restart', async () => {
  const playlist = await library.createPlaylist('Kitchen');
  const saved = await library.saveTo(playlist.id, null, song(7, new Date(2026, 9, 4, 1, 2, 3)));
  expect(fs.readFileSync(path.join(dir, saved.file))).toEqual(Buffer.from([102, 76, 97, 67, 7]));
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${saved.id}.json`), 'utf8'));
  expect(sidecar).toMatchObject({ bside: 1, jobId: 'job-7', album: null, effective: { seed: 7 } });

  const reopened = await new Library(nodeDisk, dir).list();
  expect(reopened.songs.map((s) => s.id)).toEqual([saved.id]);
  expect(reopened.playlists).toEqual([{ ...playlist, songs: [saved.id] }]);
  expect(reopened.problems).toEqual([]);
});

test('a take saved to a second playlist is the same song, not a copy; saving twice to one is a no-op', async () => {
  const a = await library.createPlaylist('A');
  const b = await library.createPlaylist('B');
  const take = song(3, new Date(2026, 9, 4, 1, 2, 3));
  const first = await library.saveTo(a.id, null, take);
  const again = await library.saveTo(b.id, first.id, take);
  await library.saveTo(b.id, first.id, take);
  expect(again.id).toBe(first.id);
  const view = await library.list();
  expect(view.songs).toHaveLength(1);
  expect(view.playlists.map((p) => p.songs)).toEqual([[first.id], [first.id]]);
});

test('a song lives while a playlist holds it: leaving the last one deletes it', async () => {
  const a = await library.createPlaylist('A');
  const b = await library.createPlaylist('B');
  const saved = await library.saveTo(a.id, null, song(4, new Date()));
  await library.addTo(b.id, saved.id);
  expect(await library.removeFrom(a.id, saved.id)).toBe(false);
  expect(fs.existsSync(path.join(dir, saved.file))).toBe(true);
  expect(await library.removeFrom(b.id, saved.id)).toBe(true);
  expect(fs.existsSync(path.join(dir, saved.file))).toBe(false);
  expect(fs.existsSync(path.join(dir, `${saved.id}.json`))).toBe(false);
});

test('deleting a playlist deletes the songs only it held', async () => {
  const a = await library.createPlaylist('A');
  const b = await library.createPlaylist('B');
  const shared = await library.saveTo(a.id, null, song(1, new Date(2026, 9, 4, 1, 0, 0)));
  const only = await library.saveTo(a.id, null, song(2, new Date(2026, 9, 4, 1, 0, 1)));
  await library.addTo(b.id, shared.id);
  expect(await library.deletePlaylist(a.id)).toBe(1);
  const view = await library.list();
  expect(view.songs.map((s) => s.id)).toEqual([shared.id]);
  expect(view.playlists.map((p) => p.name)).toEqual(['B']);
  expect(fs.existsSync(path.join(dir, only.file))).toBe(false);
});

test('playlist names are required and unique (case-insensitive); reorder must list the same songs', async () => {
  await expect(library.createPlaylist('  ')).rejects.toThrow('needs a name');
  const a = await library.createPlaylist('Road trip');
  await expect(library.createPlaylist('road TRIP')).rejects.toThrow('already a playlist');
  const one = await library.saveTo(a.id, null, song(1, new Date(2026, 9, 4, 1, 0, 0)));
  const two = await library.saveTo(a.id, null, song(2, new Date(2026, 9, 4, 1, 0, 1)));
  await library.reorder(a.id, [two.id, one.id]);
  expect((await library.list()).playlists[0]?.songs).toEqual([two.id, one.id]);
  await expect(library.reorder(a.id, [two.id])).rejects.toThrow('each of its songs once');
  await expect(library.reorder(a.id, [two.id, two.id])).rejects.toThrow('each of its songs once');
  await library.renamePlaylist(a.id, 'Long drive');
  expect((await library.list()).playlists[0]?.name).toBe('Long drive');
});

test('songs from before playlists are adopted into one playlist, once', async () => {
  const a = await library.createPlaylist('A');
  const saved = await library.saveTo(a.id, null, song(5, new Date()));
  // A v1 library: the song's files with no playlist file at all.
  fs.rmSync(path.join(dir, 'playlists.json'));
  await library.adoptLoose();
  await library.adoptLoose();
  const view = await library.list();
  expect(view.playlists.map((p) => [p.name, p.songs])).toEqual([[ADOPTED_PLAYLIST, [saved.id]]]);
});

test('rename changes the title only', async () => {
  const a = await library.createPlaylist('A');
  const saved = await library.saveTo(a.id, null, song(3, new Date()));
  const renamed = await library.rename(saved.id, '  Morning kettle  ');
  expect(renamed.title).toBe('Morning kettle');
  expect(renamed.file).toBe(saved.file);
});

test('a sidecar that does not read is a listed problem, never deleted; foreign .json is ignored', async () => {
  fs.writeFileSync(path.join(dir, 'broken.json'), '{"bside": 1, "id": "other"}');
  fs.writeFileSync(path.join(dir, 'notes.json'), '{"something": "else"}');
  const view = await library.list();
  expect(view.songs).toEqual([]);
  expect(view.problems).toHaveLength(1);
  expect(fs.existsSync(path.join(dir, 'broken.json'))).toBe(true);
});

test('an id cannot climb out of the library folder', async () => {
  await expect(library.rename('../servers', 'x')).rejects.toThrow('not a song');
  expect(() => library.audioPath('..\\..\\secret.flac')).toThrow();
});

const ALBUM: AlbumMeta = {
  artist: 'Velvet Circuit', blurb: 'Rain.', cover: null,
  ask: { description: 'trip-hop', tags: [], minutes: 30, sung: false },
  plan: null, stage: 'done', sent: 2, madeS: 186, refusal: null, server: 'pc', writer: 'qwen3.8-27b',
};

test('an album sent from a phone is filed with its songs, and sending it again replaces it', async () => {
  // A phone's library, to take the sidecars from (as the phone would send them).
  const phoneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-phone-'));
  const phone = new Library(nodeDisk, phoneDir);
  const made = await phone.createAlbum('Static Bloom', ALBUM);
  const one = await phone.saveTo(made.id, null, song(1, new Date(2026, 9, 4, 1, 0, 0)));
  const sidecar = JSON.parse(fs.readFileSync(path.join(phoneDir, `${one.id}.json`), 'utf8'));
  // The files arrive first, then the album.
  fs.copyFileSync(path.join(phoneDir, one.file), library.importPath(one.file));
  const sent: ImportedAlbum = { id: made.id, name: 'Static Bloom', createdAt: made.createdAt, album: ALBUM, songs: [sidecar] };
  await library.importAlbum(sent);
  await library.importAlbum(sent);
  const view = await library.list();
  expect(view.playlists.map((p) => [p.id, p.name, p.songs, p.album?.artist])).toEqual([[made.id, 'Static Bloom', [one.id], 'Velvet Circuit']]);
  expect(view.songs.map((s) => [s.title, s.bytes])).toEqual([['Song 1', 5]]);
  fs.rmSync(phoneDir, { recursive: true, force: true });
});

test('an album whose audio did not arrive is refused, and nothing is filed', async () => {
  const sent: ImportedAlbum = {
    id: 'a1', name: 'X', createdAt: new Date().toISOString(), album: ALBUM,
    songs: [{ id: '20261004-010000-1', title: 'T', file: '20261004-010000-1.mp3', model: 'yue2-3b', params: { tags: null, lyrics: null, instrumental: true, cfg: null, seed: 1 }, server: { name: 'pc', url: 'http://pc:7100' }, jobId: 'j', createdAt: new Date().toISOString(), durationS: 1, batch: null, album: null, bytes: 1, effective: null }],
  };
  await expect(library.importAlbum(sent)).rejects.toThrow('did not arrive');
  expect((await library.list()).playlists).toEqual([]);
});

test('an upload can only land as a song or a cover inside the library', () => {
  expect(() => library.importPath('../evil.mp3')).toThrow();
  expect(() => library.importPath('notes.txt')).toThrow();
  expect(library.importPath('abc-1.cover.png')).toBe(path.join(dir, 'abc-1.cover.png'));
});

// ── folders (Victoria, 2026-10-11) ────────────────────────────────────────────

test('a library from before folders loads unchanged: no folders, playlists as they were, the file left alone', async () => {
  const old = { bsidePlaylists: 1, playlists: [{ id: 'p1', name: 'Old', songs: [], createdAt: '2026-10-01T00:00:00.000Z' }] };
  const text = `${JSON.stringify(old, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, 'playlists.json'), text);
  const view = await library.list();
  expect(view.folders).toEqual([]);
  expect(view.playlists).toEqual(old.playlists);
  // A playlist edit writes no folders key while there are none.
  await library.renamePlaylist('p1', 'Old');
  expect(fs.readFileSync(path.join(dir, 'playlists.json'), 'utf8')).toBe(text);
});

test('folders group playlists and albums, nest, and keep across a restart and playlist edits', async () => {
  const myths = await library.createFolder('Greek Myths');
  const lullabies = await library.createFolder('Lullabies');
  const inner = await library.createFolder('Odyssey', myths.id);
  await library.createAlbum('Sirens', ALBUM, inner.id);
  const plain = await library.createPlaylist('Kitchen');
  await library.movePlaylist(plain.id, lullabies.id);
  // A playlist edit (a new playlist) keeps the folders.
  await library.createPlaylist('Loose');
  const view = await new Library(nodeDisk, dir).list();
  expect(view.folders?.map((f) => [f.name, f.parent])).toEqual([['Greek Myths', null], ['Lullabies', null], ['Odyssey', myths.id]]);
  expect(view.playlists.map((p) => [p.name, p.folder ?? null])).toEqual([['Sirens', inner.id], ['Kitchen', lullabies.id], ['Loose', null]]);
  expect(view.playlists[0]?.album?.artist).toBe('Velvet Circuit');
  await expect(library.createAlbum('Nowhere', ALBUM, 'gone')).rejects.toThrow('no longer in the library');
});

test('moving and reordering: before a sibling, or last; never into itself; never before something elsewhere', async () => {
  const a = await library.createFolder('A');
  const b = await library.createFolder('B');
  const c = await library.createFolder('C');
  await library.moveFolder(c.id, null, a.id);
  expect((await library.list()).folders?.map((f) => f.name)).toEqual(['C', 'A', 'B']);
  await library.moveFolder(a.id, b.id);
  await expect(library.moveFolder(b.id, a.id)).rejects.toThrow('inside itself');
  await expect(library.moveFolder(b.id, b.id)).rejects.toThrow('inside itself');
  await expect(library.moveFolder(c.id, null, a.id)).rejects.toThrow('same place');

  const one = await library.createPlaylist('One');
  const two = await library.createPlaylist('Two');
  const three = await library.createPlaylist('Three');
  await library.movePlaylist(three.id, null, one.id);
  expect((await library.list()).playlists.map((p) => p.name)).toEqual(['Three', 'One', 'Two']);
  await library.movePlaylist(one.id, a.id);
  await library.movePlaylist(two.id, a.id, one.id);
  const view = await library.list();
  expect(view.playlists.filter((p) => p.folder === a.id).map((p) => p.name)).toEqual(['Two', 'One']);
  await expect(library.movePlaylist(three.id, null, one.id)).rejects.toThrow('same folder');
  await expect(library.movePlaylist(three.id, 'nope')).rejects.toThrow('no longer in the library');
  // Out again, to the top.
  await library.movePlaylist(one.id, null);
  expect((await library.list()).playlists.find((p) => p.id === one.id)?.folder).toBeNull();
});

test('deleting a folder moves what was in it up a level, in its place; nothing in it is deleted', async () => {
  const top = await library.createFolder('Top');
  const first = await library.createFolder('First');
  const mid = await library.createFolder('Mid', top.id);
  const deep = await library.createFolder('Deep', mid.id);
  await library.createFolder('Last');
  await library.moveFolder(first.id, null, top.id);
  const kept = await library.createPlaylist('Kept');
  await library.movePlaylist(kept.id, mid.id);
  const saved = await library.saveTo(kept.id, null, song(9, new Date()));
  await library.deleteFolder(mid.id);
  const view = await library.list();
  expect(view.folders?.map((f) => [f.name, f.parent])).toEqual([['First', null], ['Top', null], ['Deep', top.id], ['Last', null]]);
  expect(view.playlists.map((p) => [p.name, p.folder, p.songs])).toEqual([['Kept', top.id, [saved.id]]]);
  expect(view.songs.map((s) => s.id)).toEqual([saved.id]);
  await library.deleteFolder(top.id);
  const after = await library.list();
  expect(after.folders?.map((f) => f.name)).toEqual(['First', 'Deep', 'Last']);
  expect(after.folders?.find((f) => f.id === deep.id)?.parent).toBeNull();
  expect(after.playlists[0]?.folder).toBeNull();
});

test('folder names: required, unique beside each other only; folders go at most four deep', async () => {
  await expect(library.createFolder('  ')).rejects.toThrow('needs a name');
  const a = await library.createFolder('Lullabies');
  await expect(library.createFolder('LULLABIES')).rejects.toThrow('already a folder');
  const b = await library.createFolder('Lullabies', a.id);
  await expect(library.renameFolder(b.id, 'x'.repeat(121))).rejects.toThrow('at most 120');
  const c = await library.createFolder('Three', b.id);
  const d = await library.createFolder('Four', c.id);
  await expect(library.createFolder('Five', d.id)).rejects.toThrow('at most 4 deep');
  const other = await library.createFolder('Other');
  await library.createFolder('Under', other.id);
  // Other holds a folder: two levels, which do not fit under Three (depth 3).
  await expect(library.moveFolder(other.id, c.id)).rejects.toThrow('at most 4 deep');
  await library.moveFolder(other.id, b.id);
});

test('a playlist filed in a folder that is gone, or a folder whose parent is gone, reads as the top', async () => {
  const shelf = {
    bsidePlaylists: 1,
    playlists: [{ id: 'p1', name: 'P', songs: [], createdAt: '2026-10-01T00:00:00.000Z', folder: 'gone' }],
    folders: [
      { id: 'f1', name: 'Orphan', parent: 'gone', createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'f2', name: 'Loop A', parent: 'f3', createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'f3', name: 'Loop B', parent: 'f2', createdAt: '2026-10-01T00:00:00.000Z' },
    ],
  };
  fs.writeFileSync(path.join(dir, 'playlists.json'), JSON.stringify(shelf));
  const view = await library.list();
  expect(view.playlists[0]?.folder).toBeNull();
  expect(view.folders?.map((f) => f.parent)).toEqual([null, null, null]);
});
