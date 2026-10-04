/**
 * crucible — B-Side's door to a Crucible server, main process only.
 *
 * Jobs, job events, install tasks, artifacts and `info()` go through the
 * official SDK (`@crucible/client`). The playground routes — the song page and
 * its presets — have no SDK helper, so `playgroundCall` is a small typed fetch
 * that sends the same headers the SDK does (`Authorization: Bearer`,
 * `X-Crucible-Api: 1`, `X-Crucible-Client`) and reads the same error envelope
 * (`{"error": {"code", "message", "details"}}`).
 */
import { API_VERSION, CrucibleClient } from '@crucible/client';

import { Refusal } from './refusal';
import type { StoredServer } from './servers';
import {
  SONG_MODEL,
  type NumberField,
  type Preset,
  type ServerProbe,
  type SongForm,
  type SongPage,
  type TagConflict,
  type TagGroup,
} from '../shared/types';

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

// ─────────────────────────────────────────────────────────────────────────────
// The playground routes
// ─────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

async function playgroundCall(server: StoredServer, method: 'GET' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<Json> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${server.token}`,
    'X-Crucible-Api': String(API_VERSION),
    'X-Crucible-Client': CLIENT_NAME,
    'User-Agent': CLIENT_NAME,
  };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(`${server.url}${path}`, init);
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
    throw new Refusal('unreachable', `${server.name} (${server.url}) could not be reached${cause}`);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const envelope = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    if (envelope && typeof envelope.code === 'string' && typeof envelope.message === 'string') {
      throw new Refusal(envelope.code, envelope.message, response.status, envelope.details ?? null);
    }
    throw new Refusal(`http_${response.status}`, `${server.name} answered HTTP ${response.status} with no named refusal: ${text.slice(0, 200)}`, response.status);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Refusal('protocol', `${path} on ${server.name} did not answer a JSON object`);
  }
  return parsed as Json;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberField(field: Json | undefined): NumberField | null {
  if (field === undefined) return null;
  return {
    default: numberOrNull(field['default']),
    min: numberOrNull(field['min']),
    max: numberOrNull(field['max']),
    step: numberOrNull(field['step']),
    hint: text(field['hint']),
  };
}

function suggestionsOf(raw: unknown): TagGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((group): group is Json => typeof group === 'object' && group !== null)
    .map((group) => ({
      group: String(group['group']),
      tags: Array.isArray(group['tags']) ? group['tags'].filter((t): t is string => typeof t === 'string') : [],
    }));
}

function conflictsOf(raw: unknown): Record<string, TagConflict[]> {
  const map: Record<string, TagConflict[]> = {};
  if (typeof raw !== 'object' || raw === null) return map;
  for (const [tag, rules] of Object.entries(raw as Json)) {
    if (!Array.isArray(rules)) continue;
    map[tag.toLowerCase()] = rules
      .filter((rule): rule is Json => typeof rule === 'object' && rule !== null)
      .map((rule) => ({ tag: String(rule['tag']), why: String(rule['why']) }));
  }
  return map;
}

/** `GET /v1/playground`, read down to the `yue2-3b` audio page. */
export async function songPage(server: StoredServer): Promise<SongPage> {
  const body = await playgroundCall(server, 'GET', '/v1/playground');
  const pages = Array.isArray(body['pages']) ? (body['pages'] as Json[]) : [];
  const page = pages.find((p) => p['id'] === SONG_MODEL && p['job_type'] === 'audio');
  if (page === undefined) {
    throw new Refusal('unknown_model', `${server.name} has no ${SONG_MODEL} song model (its build does not declare one).`);
  }
  const fields = Array.isArray(page['fields']) ? (page['fields'] as Json[]) : [];
  const named = (name: string): Json | undefined => fields.find((field) => field['name'] === name);
  const tags = named('tags');
  const lyrics = named('lyrics');
  if (page['available'] === true && tags === undefined) {
    throw new Refusal('page_unreadable', `${server.name}'s ${SONG_MODEL} page has no tags field; is this a newer Crucible than B-Side knows?`);
  }
  return {
    model: SONG_MODEL,
    name: text(page['name']) ?? SONG_MODEL,
    standing: text(page['standing']) ?? 'unavailable',
    available: page['available'] === true,
    reason: text(page['reason']),
    downloadBytes: numberOrNull(page['download_bytes']),
    tagsPlaceholder: text(tags?.['placeholder']),
    tagsHint: text(tags?.['hint']),
    suggestions: suggestionsOf(tags?.['suggestions']),
    conflicts: conflictsOf(tags?.['conflicts']),
    lyricsPlaceholder: text(lyrics?.['placeholder']),
    lyricsHint: text(lyrics?.['hint']),
    instrumental: named('instrumental') !== undefined,
    cfg: numberField(named('cfg')),
    seed: numberField(named('seed')),
  };
}

function presetsOf(body: Json): Preset[] {
  const raw = Array.isArray(body['presets']) ? (body['presets'] as Json[]) : [];
  return raw.map((preset) => ({
    name: String(preset['name']),
    params: (typeof preset['params'] === 'object' && preset['params'] !== null ? preset['params'] : {}) as Preset['params'],
    savedAt: String(preset['saved_at']),
  }));
}

const presetsPath = (name?: string): string =>
  `/v1/playground/presets/${encodeURIComponent(SONG_MODEL)}${name === undefined ? '' : `/${encodeURIComponent(name)}`}`;

export async function listPresets(server: StoredServer): Promise<Preset[]> {
  return presetsOf(await playgroundCall(server, 'GET', presetsPath()));
}

/**
 * `PUT` a preset: the form's own params, never a seed (the server refuses one —
 * a preset is a sound, not one take of it). Lyrics are left out of an
 * instrumental, as the form leaves them out of its request.
 */
export async function savePreset(server: StoredServer, name: string, form: SongForm): Promise<Preset[]> {
  const params: Record<string, string | number | boolean> = { instrumental: form.instrumental };
  if (form.tags.trim() !== '') params['tags'] = form.tags;
  if (!form.instrumental && form.lyrics.trim() !== '') params['lyrics'] = form.lyrics;
  if (form.cfg !== null) params['cfg'] = form.cfg;
  await playgroundCall(server, 'PUT', presetsPath(name.trim()), { params });
  return listPresets(server);
}

export async function deletePreset(server: StoredServer, name: string): Promise<Preset[]> {
  await playgroundCall(server, 'DELETE', presetsPath(name));
  return listPresets(server);
}
