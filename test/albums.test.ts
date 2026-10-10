import { expect, test } from 'bun:test';

import { trackTags } from '../shared/core/albums';

const PRESET = 'lo-fi, dreamy, saxophone, jazz, soul, 70 BPM, Instrumental, no vocals';

test("an album keeps the person's tags exactly, and adds only the track's turn", () => {
  expect(trackTags(PRESET, 'rain texture, brushed drums', false)).toBe(`${PRESET}, rain texture, brushed drums`);
});

test('a turn never repeats the core, nor brings a voice into an instrumental album', () => {
  expect(trackTags(PRESET, 'Jazz, soft female voice, upright bass', false)).toBe(`${PRESET}, upright bass`);
});

test('an instrumental track says so; a sung one drops "instrumental"', () => {
  expect(trackTags('city pop, warm synths', 'slap bass', false)).toBe('city pop, warm synths, slap bass, instrumental');
  expect(trackTags('city pop, instrumental, warm synths', 'raspy male vocal', true)).toBe('city pop, warm synths, raspy male vocal');
});

import { albumProgress } from '../src/app/core/album-progress';
import type { AlbumMeta } from '../shared/types';

function album(change: Partial<AlbumMeta>): AlbumMeta {
  return {
    artist: '', blurb: '', cover: null, plan: null, stage: 'planning', sent: 0, madeS: 0, refusal: null,
    server: 'mac', writer: null, ask: { description: 'x', tags: [], minutes: 30, sung: true }, ...change,
  };
}

test('the progress line says what the maker is doing, and the bar only goes forward', () => {
  const planning = albumProgress(album({}));
  expect(planning.waiting).toBe(true);
  const lyrics = albumProgress(album({ step: { kind: 'lyrics', done: 3, of: 13 } }));
  expect(lyrics.label).toBe('Writing lyrics: 4 of 13…');
  const cover = albumProgress(album({ step: { kind: 'cover', done: 0, of: 1 } }));
  expect(cover.label).toBe('Painting the album art…');
  expect(cover.share).toBeGreaterThan(lyrics.share);
  const making = albumProgress(album({ stage: 'making', madeS: 900 }));
  expect(making.label).toBe('Making the music: 15 of 30 min');
  expect(making.share).toBeGreaterThan(cover.share);
  expect(albumProgress(album({ stage: 'done', madeS: 1900 })).share).toBe(1);
});

import { AlbumMaker, type AlbumHooks } from '../shared/core/albums';
import type { AlbumMeta } from '../shared/types';

/** An album with four planned tracks, cover painted, as a fake hub holds it. */
function fakeAlbum(meta: Partial<AlbumMeta>, songs: { title: string; durationS: number }[], flying: number[] = []) {
  const tracks = ['One', 'Two', 'Three', 'Four'].map((title) => ({ title, tags: 'folk', lyrics: null }));
  let stored: AlbumMeta = {
    artist: 'A', blurb: '', cover: 'c.png', ask: { description: '', tags: [], minutes: 10, sung: false },
    plan: { title: 'T', artist: 'A', blurb: '', coverPrompt: '', tracks }, stage: 'stopped', sent: 3, madeS: 0,
    refusal: null, server: 'pc', writer: 'w', ...meta,
  };
  const rendered: number[] = [];
  const hooks: AlbumHooks = {
    meta: async () => stored,
    update: async (_id, next) => { stored = next; },
    server: () => ({ name: 'pc', url: 'http://pc:7100', token: 't' }) as never,
    client: () => { throw new Error('no server in this test'); },
    page: async () => null,
    paint: async () => 'c.png',
    removeCover: async () => undefined,
    render: (_id, track) => { rendered.push(track); },
    inFlight: () => flying.length + rendered.length,
    retitle: async () => undefined,
    cancelInFlight: async () => undefined,
    made: async () => songs,
    flyingTracks: () => flying,
    renameSong: async () => undefined,
    lyricist: () => null,
  };
  return { maker: new AlbumMaker(hooks), rendered, meta: () => stored };
}

test('Continue: a stopped album makes again the tracks it lost, first, then carries on', async () => {
  // Tracks 0-2 were sent; only One landed (Two failed, Three was lost when the app closed).
  const album = fakeAlbum({}, [{ title: 'One', durationS: 150 }]);
  await album.maker.resume('a');
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(album.rendered).toEqual([1, 2]);
  expect(album.meta().stage).toBe('making');
  expect(album.meta().madeS).toBe(150);
  expect(album.meta().redo).toEqual([]);
});

test('Continue never sends again a track still on the server', async () => {
  const album = fakeAlbum({}, [{ title: 'One', durationS: 150 }], [2]);
  await album.maker.resume('a');
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(album.rendered).toEqual([1]);
});

test('the last track landing finishes the album: its own job is not one still in flight', async () => {
  // 450 s made of 600, and a 160 s track lands; its own job is still listed while it is filed.
  const album = fakeAlbum({ stage: 'making', sent: 3, madeS: 450, ask: { description: '', tags: [], minutes: 10, sung: false } }, [], [2]);
  await album.maker.landed('a', 160);
  expect(album.meta().stage).toBe('done');
  expect(album.rendered).toEqual([]);
});

test("an instrumental album drops a singer even from the person's own tags", () => {
  expect(trackTags('soul, warm male vocal, Hammond organ', 'brushed drums', false)).toBe('soul, Hammond organ, brushed drums, instrumental');
  expect(trackTags('soul, warm male vocal, Hammond organ', 'brushed drums', true)).toBe('soul, warm male vocal, Hammond organ, brushed drums');
});
