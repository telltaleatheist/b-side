import { expect, test } from 'bun:test';
import { CrucibleUnreachable, type CrucibleClient } from '@crucible/client';

import { trackSong } from '../shared/core/albums';
import type { Disk } from '../shared/core/disk';
import { JobRunner, settleSong, songJob } from '../shared/core/jobs';
import { aimOf, structureOf } from '../shared/core/library';
import { check, namedSet, pickSet, planningLyrics } from '../shared/planning-sets';
import type { JobView, SongPage, SongParams } from '../shared/types';

// Crucible has no default planning set (Owen, 2026-10-11): every instrumental B-Sides sends, from
// every path, carries planning lyrics that pass check, and never planning_set, lyrics or a range.

const pc = { name: 'pc', url: 'http://pc:7100', token: 't' } as never;

function disk(pending: string | null = null): Disk {
  return {
    mkdir: async () => undefined, list: async () => null, readText: async () => pending, writeText: async () => undefined,
    exists: async () => false, move: async () => undefined, copy: async () => undefined, remove: async () => undefined,
  };
}

/** What a request must be when it is an instrumental's. */
function planned(params: Record<string, unknown>): string {
  expect(params['instrumental']).toBe(true);
  expect(typeof params['planning_lyrics']).toBe('string');
  expect(() => check(params['planning_lyrics'] as string)).not.toThrow();
  for (const gone of ['planning_set', 'lyrics', 'min_duration_s', 'max_duration_s']) expect(gone in params).toBe(false);
  return params['planning_lyrics'] as string;
}

/** A server that takes every song and then reads as `status` once its stream drops. */
function server(status: Record<string, unknown> = { status: 'running' }) {
  const sent: Record<string, unknown>[] = [];
  const client = {
    submit: async (job: { params: Record<string, unknown> }) => { sent.push(job.params); return `j${sent.length}`; },
    events: async function* () { throw new CrucibleUnreachable('http://pc:7100', 'the server went away'); },
    job: async () => ({ status: 'interrupted', error: null, removal: null, ...status }),
    cancel: async () => undefined,
  } as unknown as CrucibleClient;
  return { client, sent };
}

function runnerOn(client: CrucibleClient, ended: JobView[] = [], pending: string | null = null): JobRunner {
  return new JobRunner(
    { publish: () => undefined, ended: (job) => { ended.push(job); }, land: async () => { throw new Error('nothing lands'); }, server: () => pc },
    disk(pending), 'pending.json', async () => 0, () => client,
  );
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !done(); i += 1) await new Promise((rest) => setTimeout(rest, 5));
}

test("an instrumental's request carries its seed's set as planning_lyrics, and no planning_set", () => {
  const job = songJob(settleSong({ tags: 'lo-fi', instrumental: true, seed: 13 }), 'mp3', 'k');
  expect(planned(job.params)).toBe(pickSet(13).lyrics);
  expect(job.params['seed']).toBe(13);
  expect(job.model).toBe('yue2-3b');
});

test('an instrumental goes to yue2-3b, never held (Owen, 2026-10-12: base for everything, no separator on a render)', () => {
  const job = songJob(settleSong({ tags: 'lo-fi', instrumental: true, seed: 13 }), 'mp3', 'k');
  expect(job.model).toBe('yue2-3b');
  expect(job.params['instrumental']).toBe(true);
  expect(job.hold).toBeUndefined();
});

test("an instrumental's aim sizes its set, and goes no further than B-Sides", () => {
  const params = settleSong({ tags: 'lo-fi', instrumental: true, seed: 0, min_duration_s: 300, max_duration_s: 360 });
  expect(planned(songJob(params, 'mp3', 'k').params)).toBe(planningLyrics(pickSet(0), { min: 300, max: 360 }).lyrics);
  expect(planningLyrics(pickSet(0), { min: 300, max: 360 }).lyrics).not.toBe(pickSet(0).lyrics);
});

test('an instrumental sent with lyrics still goes with planning lyrics, not the bare tags', () => {
  planned(songJob(settleSong({ tags: 'lo-fi', instrumental: true, lyrics: '[Verse]\n\n[Chorus]', seed: 2 }), 'mp3', 'k').params);
});

test('an instrumental settled with no seed draws one, and its set is that seed\'s', () => {
  const params = settleSong({ tags: 'lo-fi', instrumental: true });
  expect(typeof params.seed).toBe('number');
  expect(params.planning_set).toBe(pickSet(params.seed as number).id);
});

test('a set B-Sides no longer has is replaced by the seed\'s', () => {
  expect(settleSong({ instrumental: true, seed: 5, planning_set: 'gone' }).planning_set).toBe(pickSet(5).id);
  expect(settleSong({ instrumental: true, seed: 5, planning_set: 'harbor' }).planning_set).toBe('harbor');
});

test('an instrumental that skipped settleSong with no seed is a bug, said at once', () => {
  expect(() => songJob({ tags: 'lo-fi', instrumental: true }, 'mp3', 'k')).toThrow(/settleSong/);
});

test('a sung song is sent as before, with no range and no planning lyrics', () => {
  const params = settleSong({ tags: 'pop', lyrics: '[verse]\nla', instrumental: false, min_duration_s: 180, max_duration_s: 300 });
  expect(songJob(params, 'mp3', 'k').params).toEqual({ format: 'mp3', tags: 'pop', lyrics: '[verse]\nla', instrumental: false });
});

test('Make: a single instrumental with no seed goes with a seed and that seed\'s set', async () => {
  const { client, sent } = server();
  const runner = runnerOn(client);
  const [view] = runner.generate(pc, { id: 'c', kind: 'desktop' }, { params: { tags: 'lo-fi', instrumental: true }, count: 1 }, 'flac');
  await until(() => sent.length === 1);
  expect(planned(sent[0]!)).toBe(pickSet(sent[0]!['seed'] as number).lyrics);
  expect(view!.seed).toBe(sent[0]!['seed'] as number);
  expect(view!.params.planning_set).toBe(pickSet(view!.seed as number).id);
  await runner.cancel(view!.key).catch(() => undefined);
});

test('Make N in a row from a seed: seed, seed+1, ... each with its own set', async () => {
  const { client, sent } = server();
  const runner = runnerOn(client);
  const made = runner.generate(pc, { id: 'c', kind: 'desktop' }, { params: { tags: 'lo-fi', instrumental: true, seed: 20 }, count: 3 }, 'flac');
  await until(() => sent.length === 3);
  expect(sent.map((params) => planned(params))).toEqual([20, 21, 22].map((seed) => pickSet(seed).lyrics));
  for (const job of made) await runner.cancel(job.key).catch(() => undefined);
});

test('a preset (its own tags, cfg and lead) sent as an instrumental goes with planning lyrics', async () => {
  const { client, sent } = server();
  const runner = runnerOn(client);
  const preset: SongParams = { tags: 'ambient, slow', lead: 'cello', instrumental: true, cfg: 1.5, min_duration_s: 60, max_duration_s: 120 };
  const [view] = runner.generate(pc, { id: 'phone', kind: 'phone' }, { params: preset, count: 1 }, 'mp3');
  await until(() => sent.length === 1);
  expect(planned(sent[0]!)).toBe(planningLyrics(pickSet(sent[0]!['seed'] as number), { min: 60, max: 120 }).lyrics);
  expect(sent[0]!['cfg']).toBe(1.5);
  await runner.cancel(view!.key).catch(() => undefined);
});

test("an album's instrumental tracks take the sets in turn, and a remake of a track takes its set again", async () => {
  const page = { length: true } as SongPage;
  const track = (at: number): SongParams => trackSong({ tags: 'folk', instrumental: true, aim: { min: 120, max: 180 } }, at, page);
  expect([0, 1, 2, 9, 10, 11].map((at) => track(at).planning_set)).toEqual(['lantern', 'harbor', 'meadow', 'northlight', 'lantern', 'harbor']);
  expect(trackSong({ tags: 'pop', lyrics: '[verse]\nla', instrumental: false }, 3, page).planning_set).toBeUndefined();
  const { client, sent } = server();
  const runner = runnerOn(client);
  const made = [0, 1, 2, 1].flatMap((at) => runner.generate(pc, { id: 'album:a', kind: 'desktop' }, { params: track(at), count: 1 }, 'flac', { id: 'a', track: at }));
  await until(() => sent.length === 4);
  const sets = ['lantern', 'harbor', 'meadow', 'harbor'].map((id) => planningLyrics(namedSet(id)!, { min: 120, max: 180 }).lyrics);
  expect(sent.map((params) => planned(params))).toEqual(sets);
  for (const job of made) await runner.cancel(job.key).catch(() => undefined);
});

test('a song resent after the server dropped it goes with the same planning lyrics every time', async () => {
  const { client, sent } = server({ status: 'interrupted' });
  const ended: JobView[] = [];
  runnerOn(client, ended).generate(pc, { id: 'c', kind: 'desktop' }, { params: { tags: 'lo-fi', instrumental: true }, count: 1 }, 'flac');
  await until(() => ended.length === 1);
  expect(sent.length).toBe(3);
  const first = planned(sent[0]!);
  for (const params of sent) expect(planned(params)).toBe(first);
});

test('a single retried with a new seed takes the new seed\'s set; an album track keeps its turn\'s', async () => {
  const failing = { status: 'failed', error: { code: 'worker_failed', message: 'CUDA out of memory' } };
  const single = server(failing);
  const ended: JobView[] = [];
  runnerOn(single.client, ended).generate(pc, { id: 'c', kind: 'desktop' }, { params: { tags: 'lo-fi', instrumental: true, seed: 7 }, count: 1 }, 'flac');
  await until(() => ended.length === 1);
  expect(single.sent.length).toBe(2);
  expect(planned(single.sent[0]!)).toBe(pickSet(7).lyrics);
  expect(single.sent[1]!['seed']).not.toBe(7);
  expect(planned(single.sent[1]!)).toBe(pickSet(single.sent[1]!['seed'] as number).lyrics);

  const album = server(failing);
  const albumEnded: JobView[] = [];
  const params = trackSong({ tags: 'folk', instrumental: true }, 2, { length: true } as SongPage);
  runnerOn(album.client, albumEnded).generate(pc, { id: 'album:a', kind: 'desktop' }, { params: { ...params, seed: 7 }, count: 1 }, 'flac', { id: 'a', track: 2 });
  await until(() => albumEnded.length === 1);
  expect(album.sent.map((sent) => planned(sent))).toEqual([namedSet('meadow')!.lyrics, namedSet('meadow')!.lyrics]);
});

test('an instrumental resumed from before 2026-10-11 (no set, no seed) and resent goes with planning lyrics', async () => {
  const view = {
    key: 'old', client: 'c', clientKind: 'desktop', number: 1, index: 1, batch: 1, server: 'pc', jobId: 'j0', phase: 'running',
    position: null, of: null, fraction: null, message: null, install: null, refusal: null,
    params: { tags: 'lo-fi', instrumental: true, min_duration_s: 120, max_duration_s: 180 },
    seed: null, title: null, takeId: null, since: 0, ended: null, album: null, playlist: null, songId: null,
  };
  const { client, sent } = server({ status: 'interrupted' });
  const ended: JobView[] = [];
  await runnerOn(client, ended, JSON.stringify([{ view }])).resume();
  await until(() => ended.length === 1);
  expect(sent.length).toBeGreaterThan(0);
  for (const params of sent) planned(params);
});

test("the library names the set B-Sides chose, whatever the server's record says, and an older song's from that record", () => {
  const made = { tags: 'lo-fi', lyrics: null, instrumental: true, cfg: null, seed: 3 };
  expect(structureOf({ ...made, planning_set: 'harbor' }, { planning_lyrics: { source: 'client', id: null, lyrics: '[Verse]\nla' } })).toBe('harbor');
  expect(structureOf(made, { planning_lyrics: { source: 'pool', id: 'ember' } })).toBe('ember');
  expect(structureOf(made, null)).toBeNull();
});

test("the library holds the score's length against the aim B-Sides kept; an older song keeps the server's verdict", () => {
  const made = { tags: 'lo-fi', lyrics: null, instrumental: true, cfg: null, seed: 3 };
  const aimed = { ...made, min_duration_s: 120, max_duration_s: 180 };
  const length = (seconds: number) => ({ length: { min_duration_s: null, max_duration_s: null, in_range: null, score_seconds: seconds } });
  expect(aimOf(aimed, length(200))).toEqual({ min: 120, max: 180, inRange: false });
  expect(aimOf(aimed, length(150))).toEqual({ min: 120, max: 180, inRange: true });
  expect(aimOf(aimed, null)).toEqual({ min: 120, max: 180, inRange: null });
  expect(aimOf(made, length(150))).toBeNull();
  expect(aimOf(made, { length: { min_duration_s: 60, max_duration_s: 120, in_range: true } })).toEqual({ min: 60, max: 120, inRange: true });
});
