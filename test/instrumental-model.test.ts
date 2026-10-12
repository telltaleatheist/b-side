import { expect, test } from 'bun:test';
import type { CrucibleClient, JobRequest } from '@crucible/client';

import type { Disk } from '../shared/core/disk';
import { InstrumentalModelGate } from '../shared/core/instrumental-model';
import { JobRunner, type Landed, type StripOptions } from '../shared/core/jobs';
import { VOICED_S, vocalStem } from '../shared/core/strip';
import { INSTRUMENTAL_MODEL, SONG_MODEL, type JobView } from '../shared/types';

// Owen, 2026-10-12: an instrumental goes to the server's instrumental model (yue2-3b with the
// composing adapter, Crucible 2.0.7) when it has one; there the strip is a safety net, run only
// when the meter finds a voice. Without the model, everything is as it was: yue2-3b, stripped.

const pc = { name: 'pc', url: 'http://pc:7100', token: 't' };
const disk: Disk = {
  mkdir: async () => undefined, list: async () => null, readText: async () => null, writeText: async () => undefined,
  exists: async () => false, move: async () => undefined, copy: async () => undefined, remove: async () => undefined,
};

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i += 1) await new Promise((rest) => setTimeout(rest, 5));
}

/** A 16-bit mono WAV at `rate`: `loudSeconds` of a loud square wave after `quietSeconds` of silence. */
function stemWav(quietSeconds: number, loudSeconds: number, rate = 50): Uint8Array {
  const samples = [...new Array(quietSeconds * rate).fill(0), ...Array.from({ length: loudSeconds * rate }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5))];
  const data = samples.length * 2;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const put = (at: number, text: string): void => { for (let i = 0; i < 4; i++) bytes[at + i] = text.charCodeAt(i); };
  put(0, 'RIFF'); view.setUint32(4, 36 + data, true); put(8, 'WAVE');
  put(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  put(36, 'data'); view.setUint32(40, data, true);
  samples.forEach((s, i) => view.setInt16(44 + i * 2, Math.round(s * 32767), true));
  return bytes;
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

/** A fake Crucible whose separator's vocal stem holds `voiceSeconds` of voice; `has`: it lists the instrumental model installed. */
function fakeServer(has: boolean, voiceSeconds: number) {
  const sent = new Map<string, JobRequest>();
  const order: JobRequest[] = [];
  const released: string[] = [];
  const finished = new Set<string>();
  const client = {
    info: async () => ({ server: { version: '2.0.7' }, jobTypes: ['audio', 'denoise'], features: [] }),
    models: async () => [{ id: SONG_MODEL, installed: true }, ...(has ? [{ id: INSTRUMENTAL_MODEL, installed: true }] : [])],
    submit: async (request: JobRequest) => {
      order.push(request);
      const id = `${request.type}-${order.length}`;
      sent.set(id, request);
      return id;
    },
    events: async function* (id: string) {
      await until(() => finished.has(id));
      const format = (sent.get(id)?.params['format'] as string) ?? 'flac';
      yield { id: 1, event: 'done', data: renderDone(Number(id.split('-')[1]), `audio.${format}`) };
    },
    job: async (id: string) => {
      const check = sent.get(id)?.clientRef?.startsWith('b-sides:voice-check') === true;
      return {
        jobId: id, status: 'done', progress: 1, position: null, removal: null, error: null,
        artifacts: check ? ['song_(vocals)_vocals_mel_band_roformer.wav'] : ['song_(vocals)_vocals_mel_band_roformer.mp3', 'song_(other)_vocals_mel_band_roformer.mp3'],
      };
    },
    artifact: async () => stemWav(2, voiceSeconds),
    releaseArtifacts: async (id: string) => { released.push(id); },
    cancel: async () => ({}),
  } as unknown as CrucibleClient;
  const strips: StripOptions = { can: async () => true, pollMs: 1 };
  return { client, order, released, strips, finish: (id: string) => finished.add(id) };
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
    disk, 'pending.json', async (_server, jobId, artifact) => { fetched.push(`${jobId}/${artifact}`); return 3; }, () => server.client, server.strips,
    (at, client) => gate.pick(at, client),
  );
}

test('the gate asks a server once and names the instrumental model only where it is installed', async () => {
  const lines: string[] = [];
  let asked = 0;
  let now = 0;
  const gate = new InstrumentalModelGate((line) => lines.push(line), 1000, () => now);
  const client = { models: async () => { asked += 1; return [{ id: INSTRUMENTAL_MODEL, installed: asked > 1 }]; } } as unknown as CrucibleClient;
  for (let i = 0; i < 3; i += 1) expect(await gate.pick(pc, client)).toBe(SONG_MODEL);
  expect(asked).toBe(1);
  now = 5000;
  expect(await gate.pick(pc, client)).toBe(INSTRUMENTAL_MODEL);
  expect(lines.length).toBe(2);
  const broken = { models: async () => { throw new Error('no route'); } } as unknown as CrucibleClient;
  expect(await new InstrumentalModelGate(() => undefined).pick(pc, broken)).toBe(SONG_MODEL);
});

test('the vocal stem is "(vocals)", never the instrumental', () => {
  expect(vocalStem(['song_(other)_m.mp3', 'song_(vocals)_m.mp3'])).toBe('song_(vocals)_m.mp3');
  expect(vocalStem(['a_(Instrumental)_m.wav', 'a_(Voice)_m.wav'])).toBe('a_(Voice)_m.wav');
  expect(vocalStem(['a_(other)_m.wav'])).toBeNull();
});

test('on a server with the instrumental model, a clean render is kept as made, in the song format, and its reading is recorded', async () => {
  const server = fakeServer(true, VOICED_S - 1);
  const landed: Landed[] = [];
  const fetched: string[] = [];
  const jobs = runner(server, landed, fetched);
  const [job] = jobs.generate(pc, { id: 'c', kind: 'desktop' }, { params: { tags: 'lo-fi', instrumental: true, seed: 4 }, count: 1 }, 'mp3', null, 'new-songs');
  await until(() => server.order.length === 1);
  const render = server.order[0] as JobRequest;
  expect(render.model).toBe(INSTRUMENTAL_MODEL);
  expect(render.params['instrumental']).toBe(true);
  // Held in the person's own format: what lands may be the render itself.
  expect(render.params['format']).toBe('mp3');
  expect(render.hold).toBe(true);
  expect(jobs.list('c')[0]?.model).toBe(INSTRUMENTAL_MODEL);
  expect(jobs.list('c')[0]?.strip?.gated).toBe(true);
  server.finish('audio-1');
  await until(() => landed.length === 1);
  // One separator job, the meter's: the vocal stem alone, as WAV.
  const check = server.order[1] as JobRequest;
  expect(check.type).toBe('denoise');
  expect(check.params).toEqual({ stems: 'primary' });
  expect(check.inputs).toEqual({ 'song.mp3': { artifact: { jobId: 'audio-1', name: 'audio.mp3' } } });
  expect(server.order.length).toBe(2);
  const song = landed[0] as Landed;
  expect(song.extension).toBe('mp3');
  expect(song.strip).toEqual({ voiceS: VOICED_S - 1 });
  expect(song.job.model).toBe(INSTRUMENTAL_MODEL);
  expect(song.job.key).toBe(job?.key as string);
  expect(fetched).toEqual(['audio-1/audio.mp3']);
  await until(() => server.released.length === 1);
  expect(server.released).toEqual(['audio-1']);
});

test('on a server with the instrumental model, a render with a voice in it is stripped after all', async () => {
  const server = fakeServer(true, VOICED_S);
  const landed: Landed[] = [];
  const fetched: string[] = [];
  const jobs = runner(server, landed, fetched);
  jobs.generate(pc, { id: 'c', kind: 'desktop' }, { params: { tags: 'lo-fi', instrumental: true, seed: 4 }, count: 1 }, 'mp3', null, 'new-songs');
  await until(() => server.order.length === 1);
  server.finish('audio-1');
  await until(() => landed.length === 1);
  expect(server.order.map((request) => request.params)).toEqual([expect.objectContaining({ format: 'mp3' }), { stems: 'primary' }, { stems: 'all', format: 'mp3' }]);
  const song = landed[0] as Landed;
  expect(song.strip).toEqual({ jobId: 'denoise-3', voiceS: VOICED_S });
  expect(fetched).toEqual(['denoise-3/song_(other)_vocals_mel_band_roformer.mp3']);
});

test('without the instrumental model, an instrumental goes to yue2-3b as a held FLAC and is stripped, as before', async () => {
  const server = fakeServer(false, 0);
  const landed: Landed[] = [];
  const fetched: string[] = [];
  const jobs = runner(server, landed, fetched);
  jobs.generate(pc, { id: 'c', kind: 'desktop' }, { params: { tags: 'lo-fi', instrumental: true, seed: 4 }, count: 1 }, 'mp3', null, 'new-songs');
  await until(() => server.order.length === 1);
  const render = server.order[0] as JobRequest;
  expect(render.model).toBe(SONG_MODEL);
  expect(render.params['format']).toBe('flac');
  expect(jobs.list('c')[0]?.strip?.gated).toBeUndefined();
  server.finish('audio-1');
  await until(() => landed.length === 1);
  expect(server.order.map((request) => request.params)).toEqual([expect.objectContaining({ format: 'flac' }), { stems: 'all', format: 'mp3' }]);
  expect(landed[0]?.strip).toEqual({ jobId: 'denoise-2' });
  expect(landed[0]?.job.model).toBe(SONG_MODEL);
});

test('a sung song goes to yue2-3b whatever the server has', async () => {
  const server = fakeServer(true, 0);
  const landed: Landed[] = [];
  const jobs = runner(server, landed, []);
  jobs.generate(pc, { id: 'c', kind: 'desktop' }, { params: { tags: 'pop', lyrics: '[verse]\nhi', instrumental: false }, count: 1 }, 'mp3', null, 'new-songs');
  await until(() => server.order.length === 1);
  expect(server.order[0]?.model).toBe(SONG_MODEL);
  const view: JobView | undefined = jobs.list('c')[0];
  expect(view?.model).toBe(SONG_MODEL);
});
