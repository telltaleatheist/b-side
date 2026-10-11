/**
 * voice-check — how much voice an instrumental holds, measured, not heard.
 *
 * Owen, 2026-10-11: instrumentals still carry stray voices now and then (gibberish, humming,
 * yelling); speech recognition is no use on gibberish, so the question is only whether a
 * separator pulls a voice out and how much. Crucible's `denoise` verb with `vocals-roformer`
 * splits "every voice in the track, singing included" into its own stem; this reads that
 * stem's level, second by second. The threshold that tells a voiced song from a clean one
 * comes from listening tests, not from here.
 */
import type { CrucibleClient } from '@crucible/client';

import { Refusal } from './refusal';

export interface VoiceLevels {
  /** The vocal stem's RMS level in dBFS, one per second. */
  readonly perSecond: readonly number[];
  /** Its RMS over the whole song, dBFS. */
  readonly overall: number;
  /** Its loudest second, dBFS. */
  readonly loudest: number;
  /** Seconds at or above each threshold (dBFS): -50, -40, -30, -20. */
  readonly secondsAbove: Readonly<Record<string, number>>;
}

export interface VoiceCheck extends VoiceLevels {
  /** The vocal stem itself (WAV), to listen to. */
  readonly stem: Uint8Array;
  readonly jobId: string;
}

const SEPARATOR = 'vocals-roformer';
const POLL_MS = 1500;

/** Samples of a WAV (PCM 16/24/32 or float 32), mixed to mono, in -1..1, and its rate. */
export function readWav(bytes: Uint8Array): { samples: Float32Array; rate: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Refusal('wav_unreadable', 'The vocal stem is not a WAV file.');
  let at = 12;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format's first two bytes.
      if (format === 0xfffe) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      const width = bits / 8;
      const frames = Math.floor(Math.min(size, bytes.length - body) / (width * channels));
      const samples = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame++) {
        let sum = 0;
        for (let channel = 0; channel < channels; channel++) {
          const p = body + (frame * channels + channel) * width;
          if (format === 3 && bits === 32) sum += view.getFloat32(p, true);
          else if (bits === 16) sum += view.getInt16(p, true) / 32768;
          else if (bits === 24) sum += ((view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16)) / 8388608);
          else if (bits === 32) sum += view.getInt32(p, true) / 2147483648;
          else throw new Refusal('wav_unreadable', `The vocal stem's format (${format}, ${bits} bit) is not one B-Sides reads.`);
        }
        samples[frame] = sum / channels;
      }
      return { samples, rate };
    }
    at = body + size + (size % 2);
  }
  throw new Refusal('wav_unreadable', 'The vocal stem has no audio in it.');
}

const db = (rms: number): number => (rms <= 1e-10 ? -100 : 20 * Math.log10(rms));

/** The levels of a mono signal: RMS per second, overall, loudest, and time over each threshold. */
export function levelsOf(samples: Float32Array, rate: number): VoiceLevels {
  const perSecond: number[] = [];
  let total = 0;
  for (let start = 0; start < samples.length; start += rate) {
    const end = Math.min(samples.length, start + rate);
    let sum = 0;
    for (let i = start; i < end; i++) sum += (samples[i] as number) ** 2;
    total += sum;
    perSecond.push(Math.round(db(Math.sqrt(sum / Math.max(1, end - start))) * 10) / 10);
  }
  const secondsAbove: Record<string, number> = {};
  for (const threshold of [-50, -40, -30, -20]) secondsAbove[String(threshold)] = perSecond.filter((level) => level >= threshold).length;
  return {
    perSecond,
    overall: Math.round(db(Math.sqrt(total / Math.max(1, samples.length))) * 10) / 10,
    loudest: perSecond.length === 0 ? -100 : Math.max(...perSecond),
    secondsAbove,
  };
}

/** Separate `wav` (44.1 kHz WAV or FLAC, the separator's own rate) and measure its vocal stem. */
export async function voiceCheck(client: CrucibleClient, wav: Uint8Array, filename: string): Promise<VoiceCheck> {
  const uploaded = await client.upload(wav, { filename });
  const jobId = await client.submit({
    type: 'denoise', model: SEPARATOR, params: { stems: 'primary' }, inputs: { [filename]: { blobId: uploaded.blobId } }, clientRef: `b-sides:voice-check:${filename}`,
  });
  for (;;) {
    const status = await client.job(jobId);
    if (status.status === 'done') {
      const name = status.artifacts.find((artifact) => /vocal/i.test(artifact)) ?? status.artifacts[0];
      if (name === undefined) throw new Refusal('voice_check_empty', 'The separator answered without a stem.');
      const stem = await client.artifact(jobId, name);
      const { samples, rate } = readWav(stem);
      return { ...levelsOf(samples, rate), stem, jobId };
    }
    if (['failed', 'cancelled', 'interrupted', 'removed'].includes(status.status)) {
      throw new Refusal('voice_check_failed', `The separator's job ${status.status}: ${status.error?.message ?? 'no reason given'}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
