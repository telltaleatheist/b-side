import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CrucibleClient, JobRequest } from '@crucible/client';

import { nodeDisk } from '../electron/node-disk';
import type { Disk } from '../shared/core/disk';
import { HubCore, instrumentalName } from '../shared/core/hub-core';
import { JobRunner, type Landed, type StripOptions } from '../shared/core/jobs';
import { instrumentalStem, StripGate, stripVerdict, versionAtLeast } from '../shared/core/strip';
import { SINGLES_NAME, type JobView, type Song } from '../shared/types';

// Owen, 2026-10-11: any song can be made into an instrumental version through Crucible's separator
// (2.0.4+). Renders are never stripped (Owen, 2026-10-12: the separator damages YuE2's audio). These
// run on a fake server; what only a real 2.0.4 shows (the stems' sound, the session's timing) is
// not tested here.

const pc = { name: 'pc', url: 'http://pc:7100', token: 't' };
const disk: Disk = {
  mkdir: async () => undefined, list: async () => null, readText: async () => null, writeText: async () => undefined,
  exists: async () => false, move: async () => undefined, copy: async () => undefined, remove: async () => undefined,
};

const info = (version: string, jobTypes = ['audio', 'denoise'], features: string[] = []) => ({ server: { version }, jobTypes, features });

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i += 1) await new Promise((rest) => setTimeout(rest, 5));
}

test('a server strips from Crucible 2.0.4, with its separator on; before, and without it, it does not', () => {
  expect(versionAtLeast('2.0.4', [2, 0, 4])).toBe(true);
  expect(versionAtLeast('2.0.10.dev3', [2, 0, 4])).toBe(true);
  expect(versionAtLeast('2.1.0+abc', [2, 0, 4])).toBe(true);
  expect(versionAtLeast('2.0.3', [2, 0, 4])).toBe(false);
  expect(versionAtLeast('1.9.99', [2, 0, 4])).toBe(false);
  expect(versionAtLeast('nonsense', [2, 0, 4])).toBe(false);
  expect(stripVerdict(info('2.0.4')).can).toBe(true);
  expect(stripVerdict(info('2.0.2')).why).toContain('2.0.4');
  expect(stripVerdict(info('2.0.4', ['audio'])).can).toBe(false);
  // A feature flag, when a server offers one, wins over the version.
  expect(stripVerdict(info('2.0.2', ['audio', 'denoise'], ['denoise.any-input'])).can).toBe(true);
});

test('the gate asks each server once, and says a server that cannot strip once in the log', async () => {
  const lines: string[] = [];
  let asked = 0;
  let now = 0;
  const gate = new StripGate((line) => lines.push(line), 1000, () => now);
  const client = { info: async () => { asked += 1; return info('2.0.2'); } } as unknown as CrucibleClient;
  for (let i = 0; i < 5; i += 1) expect(await gate.can(pc, client)).toBe(false);
  expect(asked).toBe(1);
  now = 5000;
  expect(await gate.can(pc, client)).toBe(false);
  expect(asked).toBe(2);
  expect(lines.length).toBe(1);
  expect(lines[0]).toContain('cannot take the voice out');
});

test('the instrumental stem is "(other)", never the vocals; a lone non-voice stem otherwise', () => {
  const stems = ['song_(vocals)_vocals_mel_band_roformer.mp3', 'song_(other)_vocals_mel_band_roformer.mp3'];
  expect(instrumentalStem(stems)).toBe('song_(other)_vocals_mel_band_roformer.mp3');
  expect(instrumentalStem(['a_(Vocals)_m.wav', 'a_(Instrumental)_m.wav'])).toBe('a_(Instrumental)_m.wav');
  expect(instrumentalStem(['a_(vocals)_m.wav', 'a_(backing)_m.wav'])).toBe('a_(backing)_m.wav');
  expect(instrumentalStem(['a_(vocals)_m.wav'])).toBeNull();
});

/** A YuE2 render's `done`, as the SDK reads it. */
function renderDone(seed: number) {
  return {
    artifacts: ['audio.flac'],
    extra: {
      audio: {
        model: 'yue2-3b', kind: 'song', hf_repo: 'r', revision: 'v', backend: 'cuda-linux', engine: 'yue', dtype: 'bf16',
        prompt: null, tags: 'lo-fi', lyrics: null, duration_s: 100, seed, steps: null, cfg: null, format: 'flac',
        instrumental: true, planning_lyrics: null, length: null, artifact: 'audio.flac', score: null, audio_seconds: 99.5,
        sample_rate: 48000, channels: 2, seconds: 60, stage_seconds: null, peak_bytes: null, stage_peak_bytes: null,
        memory_bytes_estimate: 1, memory_basis: 'x', low_vram: false, decode_stages: null, stages_at_cap: null,
      },
    },
  };
}

/** A fake Crucible: renders finish when `finish(id)` is called; denoise jobs answer `denoise`. */
function fakeServer(denoise: 'done' | 'failed' = 'done') {
  const sent: JobRequest[] = [];
  const released: string[] = [];
  const sessions: string[] = [];
  const finished = new Set<string>();
  const client = {
    info: async () => info('2.0.4'),
    submit: async (request: JobRequest) => {
      sent.push(request);
      return `${request.type}-${sent.length}`;
    },
    events: async function* (id: string) {
      await until(() => finished.has(id));
      yield { id: 1, event: 'done', data: renderDone(Number(id.split('-')[1])) };
    },
    job: async (id: string) => ({
      jobId: id, status: denoise, progress: 1, position: null, removal: null,
      error: denoise === 'failed' ? { code: 'denoise_failed', message: 'the separator crashed' } : null,
      artifacts: ['song_(vocals)_vocals_mel_band_roformer.mp3', 'song_(other)_vocals_mel_band_roformer.mp3'],
    }),
    releaseArtifacts: async (id: string) => { released.push(id); },
    upload: async () => ({ blobId: 'blob-1', bytes: 3, sha256: '' }),
    cancel: async () => ({}),
  } as unknown as CrucibleClient;
  const strips: StripOptions = {
    session: async () => {
      sessions.push('open');
      return { client, close: async () => sessions.push('close') };
    },
    readFile: async () => new Uint8Array([1, 2, 3]),
    pollMs: 1,
  };
  return { client, sent, released, sessions, strips, finish: (id: string) => finished.add(id) };
}

function runner(server: ReturnType<typeof fakeServer>, landed: Landed[], ended: JobView[] = [], fetched: string[] = [], strips: StripOptions | null = server.strips): JobRunner {
  return new JobRunner(
    {
      publish: () => undefined,
      ended: (job) => { ended.push(job); },
      land: async (landing) => {
        await landing.fill('x');
        landed.push(landing);
        return { take: { id: `take-${landed.length}` } as never, songId: null };
      },
      server: () => pc,
    },
    disk, 'pending.json', async (_server, jobId, artifact) => { fetched.push(`${jobId}/${artifact}`); return 3; }, () => server.client, strips,
  );
}

test('a render, instrumental or sung, is never stripped (Owen, 2026-10-12): its format, no hold, no separator', async () => {
  for (const params of [{ tags: 'lo-fi', instrumental: true, seed: 4 }, { tags: 'pop', lyrics: '[verse]\nhi', instrumental: false }]) {
    const server = fakeServer();
    const landed: Landed[] = [];
    const fetched: string[] = [];
    const jobs = runner(server, landed, [], fetched);
    jobs.generate(pc, { id: 'c', kind: 'desktop' }, { params, count: 1 }, 'mp3', null, 'new-songs');
    await until(() => server.sent.length === 1);
    expect(server.sent[0]?.params['format']).toBe('mp3');
    expect(server.sent[0]?.hold).toBeUndefined();
    server.finish('audio-1');
    await until(() => landed.length === 1);
    expect(server.sent.length).toBe(1);
    expect(landed[0]?.strip).toBeUndefined();
    // The fake renders a FLAC whatever is asked: what lands is the render itself, by its own name.
    expect(landed[0]?.extension).toBe('flac');
    expect(fetched).toEqual(['audio-1/audio.flac']);
    expect(server.released).toEqual([]);
  }
});

test('an instrumental version uploads the library file and lands linked to its original', async () => {
  const server = fakeServer();
  const landed: Landed[] = [];
  const jobs = runner(server, landed);
  const song = { id: 'song-1', title: 'Blue Hour', params: { tags: 'jazz', lyrics: '[verse]\nla', instrumental: false, cfg: null, seed: 9 }, durationS: 120 } as unknown as Song;
  const [job] = jobs.versions(pc as never, { id: 'c', kind: 'desktop' }, [{ song, file: 'C:\\lib\\song-1.mp3' }], 'mp3', 'blue-instrumental');
  expect(job?.title).toBe('Blue Hour');
  expect(job?.playlist).toBe('blue-instrumental');
  await until(() => landed.length === 1);
  expect(server.sent[0]?.inputs).toEqual({ 'song.mp3': { blobId: 'blob-1' } });
  expect(landed[0]?.strip).toEqual({ jobId: 'denoise-1', of: 'song-1' });
  expect(landed[0]?.extension).toBe('mp3');
  // One song: no session; a playlist's several share one.
  expect(server.sessions).toEqual([]);
});

test('the instrumental playlist is "<name> (Instrumental)", cut to fit, and never doubled', () => {
  expect(instrumentalName('Night Drive')).toBe('Night Drive (Instrumental)');
  expect(instrumentalName(SINGLES_NAME)).toBe('New Songs (Instrumental)');
  expect(instrumentalName('Night Drive (Instrumental)')).toBe('Night Drive (Instrumental)');
  expect(instrumentalName('x'.repeat(130)).length).toBe(120);
});

// ── the hub: naming, reuse, and songs already made instrumental ──────────────────────────────

let root: string;
let core: HubCore;
const asks: { asks: number; playlist: string }[] = [];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-strip-'));
  let vault: string | null = null;
  core = new HubCore({
    disk: nodeDisk,
    vault: { where: 'memory', read: async () => vault, write: async (text) => { vault = text; } },
    dataDir: path.join(root, 'data'),
    takeLimits: { perClient: { desktop: 10, web: 10, ios: 10 }, bytes: 1e9 },
    clientName: 'b-sides-test',
    fetchAudio: async () => 0,
    info: { app: 'b-side', version: '0.0.0', hostname: 'test' },
    sink: { send: () => undefined, broadcast: () => undefined, isClosed: () => false },
  });
  await core.open(path.join(root, 'library'));
  await core.registry.add({ name: 'pc', url: 'http://127.0.0.1:9', token: null });
  // The server's answer and the runner are stand-ins: what is tested is what the hub asks them.
  (core as unknown as { strips: { check(): Promise<unknown> } }).strips.check = async () => ({ can: true, why: null });
  asks.length = 0;
  core.jobs.versions = ((_server: unknown, _client: unknown, given: readonly unknown[], _format: unknown, playlist: string) => {
    asks.push({ asks: given.length, playlist });
    return [];
  }) as never;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function route(method: string, template: string) {
  const found = core.routes.find((each) => each.method === method && each.template === template);
  if (found === undefined) throw new Error(`no route ${method} ${template}`);
  return (params: Record<string, string>, body: Record<string, unknown> = {}) =>
    found.handler({ params, body: async () => body, client: () => ({ id: 'desktop', kind: 'desktop' }) });
}

async function songIn(playlist: string, title: string): Promise<string> {
  const file = path.join(root, `${title}.mp3`);
  fs.writeFileSync(file, 'audio');
  await core.importSong(file, { name: `${title}.mp3`, title, durationS: 60, bytes: 5 }, playlist);
  const view = await core.libraryView();
  return view.songs.find((song) => song.title === title)?.id as string;
}

test('a playlist made instrumental files into "<name> (Instrumental)", made once and then reused', async () => {
  await route('POST', '/api/playlists')({}, { name: 'Night Drive' });
  const drive = (await core.libraryView()).playlists.find((p) => p.name === 'Night Drive')?.id as string;
  await songIn(drive, 'One');
  await songIn(drive, 'Two');
  await route('POST', '/api/playlists/:id/instrumental')({ id: drive });
  await route('POST', '/api/playlists/:id/instrumental')({ id: drive });
  const named = (await core.libraryView()).playlists.filter((p) => p.name === 'Night Drive (Instrumental)');
  expect(named.length).toBe(1);
  expect(asks).toEqual([{ asks: 2, playlist: named[0]?.id as string }, { asks: 2, playlist: named[0]?.id as string }]);
});

test('one song made instrumental stays in its own playlist, with no new playlist (Owen, 2026-10-11)', async () => {
  const id = await songIn(null as never, 'Lonely');
  await route('POST', '/api/songs/:id/instrumental')({ id });
  const view = await core.libraryView();
  const home = view.playlists.find((p) => p.songs.includes(id));
  expect(view.playlists.some((p) => p.name === 'New Songs (Instrumental)')).toBe(false);
  expect(asks).toEqual([{ asks: 1, playlist: home?.id as string }]);
});

test('a server that cannot strip refuses an instrumental version by name', async () => {
  (core as unknown as { strips: { check(): Promise<unknown> } }).strips.check = async () => ({ can: false, why: 'It runs Crucible 2.0.2.' });
  const id = await songIn(null as never, 'Lonely');
  await expect(Promise.resolve(route('POST', '/api/songs/:id/instrumental')({ id }))).rejects.toThrow('2.0.2');
  expect(asks).toEqual([]);
});
