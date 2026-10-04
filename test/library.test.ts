import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { Library, type NewSong } from '../electron/library';

let dir: string;
let library: Library;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-library-'));
  library = new Library(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function song(seed: number, at: Date): NewSong {
  return {
    title: `Song ${seed}`,
    extension: 'flac',
    bytes: new Uint8Array([102, 76, 97, 67, seed]),
    model: 'yue2-3b',
    params: { tags: 'pop, 88 BPM', lyrics: '[Verse]\nla la', instrumental: false, cfg: 1, seed },
    server: { name: 'pc', url: 'http://pc:7100' },
    jobId: `job-${seed}`,
    durationS: 181.5,
    batch: { index: 1, of: 2 },
    effective: { seed, audio_seconds: 181.5 },
    createdAt: at,
  };
}

test('a song is its audio and its sidecar, and the library lists it back after a restart', async () => {
  const added = await library.add(song(7, new Date(2026, 9, 4, 1, 2, 3)));
  expect(fs.existsSync(path.join(dir, added.file))).toBe(true);
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, `${added.id}.json`), 'utf8'));
  expect(sidecar).toMatchObject({ bside: 1, jobId: 'job-7', album: null, effective: { seed: 7 } });
  expect(sidecar.params).toEqual({ tags: 'pop, 88 BPM', lyrics: '[Verse]\nla la', instrumental: false, cfg: 1, seed: 7 });

  const reopened = await new Library(dir).list();
  expect(reopened.songs.map((s) => s.id)).toEqual([added.id]);
  expect(reopened.problems).toEqual([]);
});

test('songs list oldest first, and two takes in one second get distinct ids', async () => {
  const at = new Date(2026, 9, 4, 1, 2, 3);
  const later = await library.add(song(2, new Date(2026, 9, 4, 1, 2, 9)));
  const first = await library.add(song(1, at));
  const twin = await library.add(song(1, at));
  expect(twin.id).not.toBe(first.id);
  expect((await library.list()).songs.map((s) => s.id)).toEqual([first.id, twin.id, later.id]);
});

test('rename changes the title only; delete removes both files', async () => {
  const added = await library.add(song(3, new Date()));
  const renamed = await library.rename(added.id, '  Morning kettle  ');
  expect(renamed.title).toBe('Morning kettle');
  expect(renamed.file).toBe(added.file);
  await library.remove(added.id);
  expect(fs.readdirSync(dir)).toEqual([]);
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
