/**
 * crucible — B-Sides' door to a Crucible server, main process only.
 *
 * Everything goes through the official SDK (`@crucible/client`): jobs, job
 * events, install tasks, artifacts, `info()`, chat (describe -> tags), and —
 * since 1.0.100 — the playground page and its presets. The SDK reads each
 * answer strictly and raises one error type per failure; `refusal.ts` turns
 * those into what the screen shows.
 */
import { CrucibleClient, type PlaygroundField, type PlaygroundPreset } from '@crucible/client';

import { Refusal } from './refusal';
import type { StoredServer } from './servers';
import { SONG_MODEL, type NumberField, type Preset, type ServerProbe, type SongForm, type SongPage } from '../types';

/** The app's name; each install adds its own (`b-sides@<host>`), set by the hub that runs it. */
export const APP_CLIENT = 'b-sides';
let installName = APP_CLIENT;

/**
 * Crucible counts every request from one client name as one client: in its queue, and as items of
 * that name's open queue session. So each install says who it is (QUEUE.md "Give each install its
 * own client name"): a desktop and a phone never join, or hold up, each other's work.
 */
export function setClientName(name: string): void {
  installName = name;
}

export function clientName(): string {
  return installName;
}

/** A client for this server under this install's name, or `as` for a run that must stay apart (an album's session). */
export function clientFor(server: StoredServer, as: string = installName): CrucibleClient {
  return new CrucibleClient({ url: server.url, token: server.token, clientName: as });
}

/** A probe's clock (guide §5.3, §11): a sleeping or unplugged server must not hang Test or the install check. */
const PING_MS = 4000;
const INFO_MS = 8000;

/** `GET /v1/ping` then `GET /v1/info`, each on a clock: who answered, for the connection test. */
export async function probe(server: StoredServer): Promise<ServerProbe> {
  const client = clientFor(server);
  let info: Awaited<ReturnType<CrucibleClient['info']>>;
  try {
    await client.ping({ timeoutMs: PING_MS });
    info = await client.info({ timeoutMs: INFO_MS });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || (error.cause instanceof Error && error.cause.name === 'TimeoutError'))) {
      throw new Refusal('server_timeout', `${server.url} did not answer within a few seconds: asleep, off, or not on this network.`);
    }
    throw error;
  }
  return {
    name: info.server.name,
    version: info.server.version,
    backend: info.host.backend,
    audio: info.jobTypes.includes('audio'),
  };
}

function numberField(field: PlaygroundField | undefined): NumberField | null {
  if (field === undefined) return null;
  return {
    default: typeof field.default === 'number' ? field.default : null,
    min: field.min,
    max: field.max,
    step: field.step,
    hint: field.hint,
  };
}

/** `GET /v1/playground`, read down to the `yue2-3b` audio page. */
export async function songPage(server: StoredServer): Promise<SongPage> {
  const pages = await clientFor(server).playground();
  const page = pages.find((p) => p.id === SONG_MODEL && p.jobType === 'audio');
  if (page === undefined) {
    throw new Refusal('unknown_model', `${server.name} has no ${SONG_MODEL} song model (its build does not declare one).`);
  }
  const named = (name: string): PlaygroundField | undefined => page.fields.find((field) => field.name === name);
  const tags = named('tags');
  const lyrics = named('lyrics');
  if (page.available && tags === undefined) {
    throw new Refusal('page_unreadable', `${server.name}'s ${SONG_MODEL} page has no tags field; is this a newer Crucible than B-Sides knows?`);
  }
  return {
    model: SONG_MODEL,
    name: page.name,
    standing: page.standing,
    available: page.available,
    reason: page.reason,
    downloadBytes: page.downloadBytes,
    tagsPlaceholder: tags?.placeholder ?? null,
    tagsHint: tags?.hint ?? null,
    suggestions: tags?.suggestions ?? [],
    // The server keys conflicts lower-cased already; B-Sides looks them up the same way.
    conflicts: tags?.conflicts ?? {},
    lyricsPlaceholder: lyrics?.placeholder ?? null,
    lyricsHint: lyrics?.hint ?? null,
    instrumental: named('instrumental') !== undefined,
    cfg: numberField(named('cfg')),
    seed: numberField(named('seed')),
  };
}

function presetOf(preset: PlaygroundPreset): Preset {
  return { name: preset.name, params: preset.params, savedAt: preset.savedAt };
}

export async function listPresets(server: StoredServer): Promise<Preset[]> {
  return (await clientFor(server).playgroundPresets(SONG_MODEL)).map(presetOf);
}

/**
 * Save a preset: the form's own params, never a seed (the server refuses one —
 * a preset is a sound, not one take of it). Lyrics are left out of an
 * instrumental, as the form leaves them out of its request.
 */
export async function savePreset(server: StoredServer, name: string, form: SongForm): Promise<Preset[]> {
  const params: Record<string, string | number | boolean> = { instrumental: form.instrumental };
  if (form.tags.trim() !== '') params['tags'] = form.tags;
  if (!form.instrumental && form.lyrics.trim() !== '') params['lyrics'] = form.lyrics;
  if (form.cfg !== null) params['cfg'] = form.cfg;
  await clientFor(server).savePlaygroundPreset(SONG_MODEL, name.trim(), params);
  return listPresets(server);
}

export async function deletePreset(server: StoredServer, name: string): Promise<Preset[]> {
  await clientFor(server).deletePlaygroundPreset(SONG_MODEL, name);
  return listPresets(server);
}

/**
 * A fresh sampling seed for one chat. Without one the engine samples from its
 * own fixed seed, and a model loaded fresh answers the same request word for
 * word: two albums from one description came out with the same names
 * (2026-10-08), temperature 0.9 or not.
 */
export function chatSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}
