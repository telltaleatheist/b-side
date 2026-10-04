/**
 * crucible — B-Side's door to a Crucible server, main process only.
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
import { SONG_MODEL, type NumberField, type Preset, type ServerProbe, type SongForm, type SongPage } from '../shared/types';

export const CLIENT_NAME = 'b-side';

export function clientFor(server: StoredServer): CrucibleClient {
  return new CrucibleClient({ url: server.url, token: server.token, clientName: CLIENT_NAME });
}

/** `GET /v1/info`: who answered, for the settings screen's connection test. */
export async function probe(server: StoredServer): Promise<ServerProbe> {
  const info = await clientFor(server).info();
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
    throw new Refusal('page_unreadable', `${server.name}'s ${SONG_MODEL} page has no tags field; is this a newer Crucible than B-Side knows?`);
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
    // The server keys conflicts lower-cased already; B-Side looks them up the same way.
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
