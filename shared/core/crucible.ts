/**
 * crucible — B-Sides' door to a Crucible server, main process only.
 *
 * Everything goes through the official SDK (`@crucible/client`): jobs, job
 * events, install tasks, artifacts, `info()`, chat (describe -> tags), and —
 * since 1.0.100 — the playground page and its presets. The SDK reads each
 * answer strictly and raises one error type per failure; `refusal.ts` turns
 * those into what the screen shows.
 */
import { CrucibleClient, CrucibleRefused, type InstallingDetails, type ModelInfo, type PlaygroundField, type PlaygroundPreset } from '@crucible/client';

import { Refusal } from './refusal';
import type { StoredServer } from './servers';
import { SONG_MODEL, TAG_MODELS, type NumberField, type Preset, type ServerProbe, type SongForm, type SongPage } from '../types';

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
/** How long the server may take to install a model B-Sides needs (a download of up to tens of GB). */
const INSTALL_MS = 90 * 60_000;
const INSTALL_POLL_MS = 3000;

/**
 * Start installing `model` when the server lacks it: a chat loads a model that is installed
 * (it waits in the server's line while it loads) but never installs one, and a load job on a
 * missing model is refused `installing` and begins the install (install-on-submit). Null when
 * nothing needed installing: the model is there (the load job then just loads it), or it is
 * not a local model at all (an upstream account).
 */
export async function startInstall(client: CrucibleClient, model: string): Promise<InstallingDetails | null> {
  const row = (await client.models()).find((entry) => entry.id === model);
  if (row === undefined || row.installed) return null;
  try {
    await client.loadModel(model);
    return null;
  } catch (error) {
    if (!(error instanceof CrucibleRefused) || error.code !== 'installing') throw error;
    return error.details as InstallingDetails;
  }
}

/**
 * Have `model` installed before anything asks it: startInstall, then its task followed to its
 * end, `step` told the server's words each time. Another task holding the install lane
 * (`task_busy`) is waited out and the install asked again. All within INSTALL_MS.
 */
export async function installModel(client: CrucibleClient, model: string, step: (detail: string) => Promise<void>): Promise<void> {
  const until = Date.now() + INSTALL_MS;
  for (;;) {
    const details = await startInstall(client, model);
    if (details === null) return;
    for (;;) {
      if (Date.now() > until) {
        throw new Refusal('model_install_slow', `The server is still installing ${model} after ${INSTALL_MS / 60_000} minutes; try again once it is done.`);
      }
      const task = await client.task(details.task_id);
      if (task.state === 'done') break;
      if (task.state !== 'running') {
        throw new Refusal('model_install_failed', `The server could not install ${model}: ${task.error?.message ?? task.state}`);
      }
      await step(task.message ?? details.message);
      await new Promise((rest) => setTimeout(rest, INSTALL_POLL_MS));
    }
    // Its own install done: installed now. Another task's done: ask again, which may start ours.
    if (details.reason === 'installing') return;
  }
}

/**
 * Which tag model (TAG_MODELS, best first) this server gets, from what it publishes: its
 * models' memory estimates against what its card leaves for models (`/v1/capability`'s
 * total less the desktop's allowance), the gate a load actually meets (Crucible 1.0.117).
 * Among the ones that fit, one already installed wins (no download on the first
 * describe); else the best that fits, which installs on its first use. A model the
 * server's build does not have, or not for its backend, is not a choice.
 *
 * Until Crucible picks the size itself (its `lyrics` verb, VERB-SIZING phase 2), this is
 * the one place B-Sides decides it.
 */
export function chooseTagModel(models: readonly ModelInfo[], cardBytes: number): { model: string | null; reason: string | null } {
  const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  const fitting: ModelInfo[] = [];
  const why: string[] = [];
  for (const id of TAG_MODELS) {
    const row = models.find((m) => m.id === id);
    if (row === undefined) why.push(`${id} is not in this server's build`);
    else if (!row.backendSupported) why.push(`${id} has no build for this server's backend`);
    else if (row.memoryBytesEstimate !== null && row.memoryBytesEstimate > cardBytes) {
      why.push(`${id} needs ${gib(row.memoryBytesEstimate)} and the card leaves ${gib(cardBytes)} for models`);
    } else fitting.push(row);
  }
  const chosen = fitting.find((row) => row.installed) ?? fitting[0];
  if (chosen !== undefined) return { model: chosen.id, reason: null };
  return { model: null, reason: `No tag model fits this server: ${why.join('; ')}.` };
}

export async function songPage(server: StoredServer): Promise<SongPage> {
  const client = clientFor(server);
  const [pages, models, card] = await Promise.all([client.playground(), client.models(), client.capability({ timeoutMs: INFO_MS })]);
  const tagModel = chooseTagModel(models, card.totalBytes - card.desktopAllowanceBytes);
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
    tagModel: tagModel.model,
    tagModelReason: tagModel.reason,
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
