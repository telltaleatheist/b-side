import { expect, test } from 'bun:test';
import type { CrucibleClient, JobRequest } from '@crucible/client';

import type { Disk } from '../shared/core/disk';
import { JobRunner, VOICE_TRIES, type Landed, type StripOptions } from '../shared/core/jobs';
import { VOICED_S } from '../shared/core/strip';

// Owen, 2026-10-12: "render a song, do vocal sep, and if there are vocals, throw it away and
// re-render up to twice. if after a total of three songs (two re-rolls), if theres still voice, keep
// the one with the lowest amount of voice". The separator only listens: what lands is a render as made.

const pc = { name: 'pc', url: 'http://pc:7100', token: 't' };
const disk: Disk = {
  mkdir: async () => undefined, list: async () => null, readText: async () => null, writeText: async () => undefined,
  exists: async () => false, move: async () => undefined, copy: async () => undefined, remove: async () => undefined,
};

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i += 1) await new Promise((rest) => setTimeout(rest, 5));
}

/** A mono 16-bit WAV at 100 Hz: `loud` seconds of voice (-6 dBFS), then `quiet` seconds of silence. */
function stem(loud: number, quiet = 5): Uint8Array {
  const rate = 100;
  const frames = (loud + quiet) * rate;
  const bytes = new Uint8Array(44 + frames * 2);
  const view = new DataView(bytes.buffer);
  const put = (at: number, text: string): void => { for (let i = 0; i < 4; i += 1) bytes[at + i] = text.charCodeAt(i); };
  put(0, 'RIFF'); view.setUint32(4, 36 + frames * 2, true); put(8, 'WAVE');
  put(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < loud * rate; i += 1) view.setInt16(44 + i * 2, i % 2 === 0 ? 16000 : -16000, true);
  return bytes;
}

function renderDone(seed: number) {
  return {
    artifacts: ['audio.mp3'],
    extra: {
      audio: {
        model: 'yue2-3b', kind: 'song', hf_repo: 'r', revision: 'v', backend: 'cuda-linux', engine: 'yue', dtype: 'bf16',
        prompt: null, tags: 'lo-fi', lyrics: null, duration_s: 100, seed, steps: null, cfg: null, format: 'mp3',
        instrumental: true, planning_lyrics: null, length: null, artifact: 'audio.mp3', score: null, audio_seconds: 99.5,
        sample_rate: 48000, channels: 2, seconds: 60, stage_seconds: null, peak_bytes: null, stage_peak_bytes: null,
        memory_bytes_estimate: 1, memory_basis: 'x', low_vram: false, decode_stages: null, stages_at_cap: null,
      },
    },
  };
}

/** A fake Crucible: the nth render has `voices[n]` seconds of voice; renders end at once. */
function fakeServer(voices: readonly number[], meterFails = false) {
  const sent: JobRequest[] = [];
  const released: string[] = [];
  const meterOf = new Map<string, string>();
  const client = {
    submit: async (request: JobRequest) => {
      sent.push(request);
      const id = `${request.type}-${sent.length}`;
      if (request.type === 'denoise') meterOf.set(id, (Object.values(request.inputs)[0] as { artifact: { jobId: string } }).artifact.jobId);
      return id;
    },
    artifactRef: (jobId: string, name: string) => ({ artifact: { jobId, name } }),
    events: async function* (id: string) {
      yield { id: 1, event: 'done', data: renderDone(Number(id.split('-')[1]) * 100) };
    },
    job: async (id: string) => ({
      jobId: id, status: meterFails ? 'failed' : 'done', progress: 1, position: null, removal: null,
      error: meterFails ? { code: 'denoise_failed', message: 'the separator crashed' } : null,
      artifacts: ['song_(vocals)_vocals_mel_band_roformer.wav'],
    }),
    artifact: async (id: string) => {
      const renders = sent.filter((r) => r.type === 'audio');
      const render = meterOf.get(id) as string;
      const n = sent.findIndex((_, at) => `audio-${at + 1}` === render);
      return stem(voices[renders.indexOf(sent[n] as JobRequest)] ?? 0);
    },
    releaseArtifacts: async (id: string) => { released.push(id); },
    cancel: async () => ({}),
  } as unknown as CrucibleClient;
  const strips: StripOptions = { meter: async () => true, pollMs: 1 };
  return { client, sent, released, strips, renders: () => sent.filter((r) => r.type === 'audio') };
}

function make(server: ReturnType<typeof fakeServer>, params: Record<string, unknown> = { tags: 'lo-fi', instrumental: true, seed: 4 }) {
  const landed: Landed[] = [];
  const fetched: string[] = [];
  const jobs = new JobRunner(
    {
      publish: () => undefined,
      land: async (landing) => {
        await landing.fill('x');
        landed.push(landing);
        return { take: { id: `take-${landed.length}` } as never, songId: null };
      },
      server: () => pc,
    },
    disk, 'pending.json', async (_server, jobId, artifact) => { fetched.push(`${jobId}/${artifact}`); return 3; }, () => server.client, server.strips,
  );
  jobs.generate(pc, { id: 'c', kind: 'desktop' }, { params, count: 1 }, 'mp3', null, 'new-songs');
  return { landed, fetched };
}

test('a clean instrumental lands at once, as made: one render, held, metered, then let go', async () => {
  const server = fakeServer([0]);
  const { landed, fetched } = make(server);
  await until(() => landed.length === 1);
  expect(server.renders()).toHaveLength(1);
  expect(server.renders()[0]?.hold).toBe(true);
  expect(server.sent[1]?.type).toBe('denoise');
  expect(fetched).toEqual(['audio-1/audio.mp3']);
  expect(landed[0]?.voice).toEqual({ voiceS: 0, renders: 1 });
  expect(landed[0]?.strip).toBeUndefined();
  await until(() => server.released.includes('audio-1'));
  expect(server.released).toContain('audio-1');
});

test('a voiced render is made again with a new seed; the first clean one lands', async () => {
  const server = fakeServer([40, 0]);
  const { landed, fetched } = make(server);
  await until(() => landed.length === 1);
  const renders = server.renders();
  expect(renders).toHaveLength(2);
  expect(renders[0]?.params['seed']).toBe(4);
  expect(renders[1]?.params['seed']).not.toBe(4);
  expect(fetched).toEqual(['audio-3/audio.mp3']);
  expect(landed[0]?.voice).toEqual({ voiceS: 0, renders: 2 });
  await until(() => server.released.includes('audio-1') && server.released.includes('audio-3'));
});

test(`after ${VOICE_TRIES} voiced renders, the one with the least voice lands`, async () => {
  const server = fakeServer([40, 12, 30]);
  const { landed, fetched } = make(server);
  await until(() => landed.length === 1);
  expect(server.renders()).toHaveLength(VOICE_TRIES);
  expect(fetched).toEqual(['audio-3/audio.mp3']);
  expect(landed[0]?.voice).toEqual({ voiceS: 12, renders: 3 });
  await until(() => ['audio-1', 'audio-3', 'audio-5'].every((id) => server.released.includes(id)));
});

test(`a hum under ${VOICED_S} s is kept; a sung song is never metered`, async () => {
  const hum = fakeServer([VOICED_S - 1]);
  const kept = make(hum);
  await until(() => kept.landed.length === 1);
  expect(hum.renders()).toHaveLength(1);

  const sung = fakeServer([60]);
  const song = make(sung, { tags: 'pop', lyrics: '[verse]\nhi', instrumental: false });
  await until(() => song.landed.length === 1);
  expect(sung.sent.map((r) => r.type)).toEqual(['audio']);
  expect(sung.sent[0]?.hold).toBeUndefined();
  expect(song.landed[0]?.voice).toBeUndefined();
});

test('a meter that fails lands the render as made', async () => {
  const server = fakeServer([40], true);
  const { landed, fetched } = make(server);
  await until(() => landed.length === 1);
  expect(server.renders()).toHaveLength(1);
  expect(fetched).toEqual(['audio-1/audio.mp3']);
  expect(landed[0]?.voice).toBeUndefined();
});
