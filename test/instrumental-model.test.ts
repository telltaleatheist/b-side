import { expect, test } from 'bun:test';
import type { CrucibleClient, JobRequest } from '@crucible/client';

import type { Disk } from '../shared/core/disk';
import { InstrumentalModelGate } from '../shared/core/instrumental-model';
import { JobRunner, type Landed } from '../shared/core/jobs';
import { INSTRUMENTAL_MODEL, SONG_MODEL } from '../shared/types';

// Owen, 2026-10-12: an instrumental goes to the server's instrumental model (yue2-3b with the
// composing adapter, Crucible 2.0.7) when it has one, else to yue2-3b. Either way the render lands
// as made: the separator is never run on a render (it damages YuE2's audio).

const pc = { name: 'pc', url: 'http://pc:7100', token: 't' };
const disk: Disk = {
  mkdir: async () => undefined, list: async () => null, readText: async () => null, writeText: async () => undefined,
  exists: async () => false, move: async () => undefined, copy: async () => undefined, remove: async () => undefined,
};

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i += 1) await new Promise((rest) => setTimeout(rest, 5));
}

function renderDone(seed: number, artifact: string) {
  return {
    artifacts: [artifact],
    extra: {
      audio: {
        model: 'yue2-3b', kind: 'song', hf_repo: 'r', revision: 'v', backend: 'cuda-linux', engine: 'yue', dtype: 'bf16',
        prompt: null, tags: 'lo-fi', lyrics: null, duration_s: 100, seed, steps: null, cfg: null, format: artifact.split('.')[1],
        instrumental: true, planning_lyrics: null, length: null, artifact, score: null, audio_seconds: 99.5,
        sample_rate: 48000, channels: 2, seconds: 60, stage_seconds: null, peak_bytes: null, stage_peak_bytes: null,
        memory_bytes_estimate: 1, memory_basis: 'x', low_vram: false, decode_stages: null, stages_at_cap: null,
      },
    },
  };
}

/** A fake Crucible; `has`: it lists the instrumental model installed. Renders finish when `finish(id)` is called. */
function fakeServer(has: boolean) {
  const sent: JobRequest[] = [];
  const finished = new Set<string>();
  const client = {
    catalog: async () => [{ kind: 'model', id: SONG_MODEL, installed: true }, ...(has ? [{ kind: 'model', id: INSTRUMENTAL_MODEL, installed: true }] : [])],
    submit: async (request: JobRequest) => {
      sent.push(request);
      return `${request.type}-${sent.length}`;
    },
    events: async function* (id: string) {
      await until(() => finished.has(id));
      const format = (sent[Number(id.split('-')[1]) - 1]?.params['format'] as string) ?? 'flac';
      yield { id: 1, event: 'done', data: renderDone(4, `audio.${format}`) };
    },
    cancel: async () => ({}),
  } as unknown as CrucibleClient;
  return { client, sent, finish: (id: string) => finished.add(id) };
}

function runner(server: ReturnType<typeof fakeServer>, landed: Landed[], fetched: string[]): JobRunner {
  const gate = new InstrumentalModelGate(() => undefined);
  return new JobRunner(
    {
      publish: () => undefined,
      land: async (landing) => {
        await landing.fill('x');
        landed.push(landing);
        return { take: { id: `take-${landed.length}` } as never, songId: null };
      },
      server: () => pc,
    },
    disk, 'pending.json', async (_server, jobId, artifact) => { fetched.push(`${jobId}/${artifact}`); return 3; }, () => server.client, null,
    (at, client) => gate.pick(at, client),
  );
}

test('the gate asks a server\'s catalog once (the audio models are not in /v1/models) and names the instrumental model only where it is installed', async () => {
  const lines: string[] = [];
  let asked = 0;
  let now = 0;
  const gate = new InstrumentalModelGate((line) => lines.push(line), 1000, () => now);
  const client = { catalog: async () => { asked += 1; return [{ kind: 'model', id: INSTRUMENTAL_MODEL, installed: asked > 1 }]; } } as unknown as CrucibleClient;
  for (let i = 0; i < 3; i += 1) expect(await gate.pick(pc, client)).toBe(SONG_MODEL);
  expect(asked).toBe(1);
  now = 5000;
  expect(await gate.pick(pc, client)).toBe(INSTRUMENTAL_MODEL);
  expect(lines.length).toBe(2);
  const broken = { catalog: async () => { throw new Error('no route'); } } as unknown as CrucibleClient;
  expect(await new InstrumentalModelGate(() => undefined).pick(pc, broken)).toBe(SONG_MODEL);
});

test('on a server with the instrumental model, an instrumental goes to it, in the song format, and lands as made', async () => {
  const server = fakeServer(true);
  const landed: Landed[] = [];
  const fetched: string[] = [];
  const jobs = runner(server, landed, fetched);
  const [job] = jobs.generate(pc, { id: 'c', kind: 'desktop' }, { params: { tags: 'lo-fi', instrumental: true, seed: 4 }, count: 1 }, 'mp3', null, 'new-songs');
  await until(() => server.sent.length === 1);
  const render = server.sent[0] as JobRequest;
  expect(render.model).toBe(INSTRUMENTAL_MODEL);
  expect(render.params['instrumental']).toBe(true);
  expect(render.params['format']).toBe('mp3');
  expect(render.hold).toBeUndefined();
  expect(jobs.list('c')[0]?.model).toBe(INSTRUMENTAL_MODEL);
  server.finish('audio-1');
  await until(() => landed.length === 1);
  // No separator job of any kind: the render itself is the song.
  expect(server.sent.length).toBe(1);
  const song = landed[0] as Landed;
  expect(song.extension).toBe('mp3');
  expect(song.strip).toBeUndefined();
  expect(song.job.model).toBe(INSTRUMENTAL_MODEL);
  expect(song.job.key).toBe(job?.key as string);
  expect(fetched).toEqual(['audio-1/audio.mp3']);
});

test('without the instrumental model, an instrumental goes to yue2-3b, and lands as made too', async () => {
  const server = fakeServer(false);
  const landed: Landed[] = [];
  const fetched: string[] = [];
  const jobs = runner(server, landed, fetched);
  jobs.generate(pc, { id: 'c', kind: 'desktop' }, { params: { tags: 'lo-fi', instrumental: true, seed: 4 }, count: 1 }, 'mp3', null, 'new-songs');
  await until(() => server.sent.length === 1);
  expect(server.sent[0]?.model).toBe(SONG_MODEL);
  expect(server.sent[0]?.params['format']).toBe('mp3');
  server.finish('audio-1');
  await until(() => landed.length === 1);
  expect(server.sent.length).toBe(1);
  expect(landed[0]?.strip).toBeUndefined();
  expect(landed[0]?.job.model).toBe(SONG_MODEL);
  expect(fetched).toEqual(['audio-1/audio.mp3']);
});

test('a sung song goes to yue2-3b whatever the server has', async () => {
  const server = fakeServer(true);
  const jobs = runner(server, [], []);
  jobs.generate(pc, { id: 'c', kind: 'desktop' }, { params: { tags: 'pop', lyrics: '[verse]\nhi', instrumental: false }, count: 1 }, 'mp3', null, 'new-songs');
  await until(() => server.sent.length === 1);
  expect(server.sent[0]?.model).toBe(SONG_MODEL);
  expect(jobs.list('c')[0]?.model).toBe(SONG_MODEL);
});
