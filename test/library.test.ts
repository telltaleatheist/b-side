import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ADOPTED_PLAYLIST, Library, type NewSong } from '../electron/library';

let dir: string;
let scratch: string;
let library: Library;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-library-'));
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-take-'));
  library = new Library(dir);
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
  };
}

test('saving to a playlist files the song (audio + sidecar) and lists it back after a restart', async () => {
  const playlist = await library.createPlaylist('Kitchen');
  const saved = await library.saveTo(playlist.id, null, song(7, new Date(2026, 9, 4, 1, 2, 3)));
  expect(fs.readFileSync(path.join(dir, saved.file))).toEqual(Buffer.from([102, 76, 97, 67, 7]));
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${saved.id}.json`), 'utf8'));
  expect(sidecar).toMatchObject({ bside: 1, jobId: 'job-7', album: null, effective: { seed: 7 } });

  const reopened = await new Library(dir).list();
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
