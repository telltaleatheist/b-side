/**
 * presets — the sounds the person saved, kept by B-Sides itself in `presets.json`
 * (Owen, 2026-10-11: presets are the app's, not one server's; Crucible serves models).
 *
 * Before 1.0.13 they lived on each Crucible server (its playground presets). Those are
 * brought over once per server, the first time that server answers, and left where they
 * were: nothing on a server is deleted, so a preset is never lost in the move. A server
 * preset whose name is taken by a different sound comes over as "<name> (<server>)".
 */
import { join, type Disk } from './disk';
import type { StoredServer } from './servers';
import type { Preset, SongForm } from '../types';
import { cleanPhrase } from '../tags';

interface Document {
  presets: Preset[];
  /** The server URLs whose presets have been brought over. */
  imported: string[];
}

/** How long a server that did not answer is left before its presets are asked for again. */
const RETRY_MS = 60_000;

export type ServerPresets = (server: StoredServer) => Promise<readonly Preset[]>;

/**
 * A preset is the form's own params, never a seed (a preset is a sound, not one take of it).
 * Lyrics are left out of an instrumental, as the form leaves them out of its request.
 */
export function presetParams(form: SongForm): Record<string, string | number | boolean> {
  const params: Record<string, string | number | boolean> = { instrumental: form.instrumental };
  if (form.tags.trim() !== '') params['tags'] = form.tags;
  if (!form.instrumental && form.lyrics.trim() !== '') params['lyrics'] = form.lyrics;
  if (form.cfg !== null) params['cfg'] = form.cfg;
  // The lead is its own param (Owen, 2026-10-11); a preset from before has none.
  // Kept as words, never as the code the text model once wrote it in (`["searing lead guitar melody"][0]`).
  const lead = typeof form.lead === 'string' ? cleanPhrase(form.lead) : '';
  if (lead !== '') params['lead'] = lead;
  return params;
}

function sameParams(a: Preset['params'], b: Preset['params']): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => a[key] === b[key]);
}

export class PresetStore {
  private document: Document | null = null;
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly disk: Disk,
    private readonly dataDir: string,
    private readonly fromServer: ServerPresets,
    private readonly now: () => number = Date.now,
  ) {}

  private get file(): string {
    return join(this.dataDir, 'presets.json');
  }

  private async read(): Promise<Document> {
    if (this.document !== null) return this.document;
    const text = await this.disk.readText(this.file);
    let document: Document = { presets: [], imported: [] };
    if (text !== null) {
      try {
        const stored = JSON.parse(text) as Partial<Document>;
        document = {
          presets: Array.isArray(stored.presets) ? stored.presets.filter((p) => typeof p?.name === 'string' && typeof p.params === 'object') : [],
          imported: Array.isArray(stored.imported) ? stored.imported.filter((url) => typeof url === 'string') : [],
        };
      } catch (err) {
        // Never overwritten while unreadable: the presets would be lost. Set aside, then started afresh.
        console.error(`[presets] ${this.file} could not be read; kept as presets.unreadable.json:`, err);
        await this.disk.copy(this.file, join(this.dataDir, 'presets.unreadable.json'));
      }
    }
    this.document = document;
    return document;
  }

  private async write(document: Document): Promise<void> {
    await this.disk.mkdir(this.dataDir);
    await this.disk.writeText(this.file, JSON.stringify(document, null, 2));
    this.document = document;
  }

  /** Bring over the presets of each server not brought over yet; one that does not answer is tried again later. */
  private async importFrom(servers: readonly StoredServer[]): Promise<void> {
    const document = await this.read();
    const due = servers.filter((server) =>
      !document.imported.includes(server.url) && this.now() - (this.failedAt.get(server.url) ?? -Infinity) >= RETRY_MS);
    if (due.length === 0) return;
    const answers = await Promise.all(due.map(async (server) => {
      try {
        return { server, presets: await this.fromServer(server) };
      } catch (err) {
        this.failedAt.set(server.url, this.now());
        console.error(`[presets] could not bring over ${server.name}'s presets yet:`, err);
        return null;
      }
    }));
    let presets = [...document.presets];
    const imported = [...document.imported];
    for (const answer of answers) {
      if (answer === null) continue;
      for (const preset of answer.presets) {
        const same = presets.find((p) => p.name === preset.name);
        if (same !== undefined && sameParams(same.params, preset.params)) continue;
        let name = preset.name;
        if (same !== undefined) name = `${preset.name} (${answer.server.name})`;
        if (presets.some((p) => p.name === name)) continue;
        presets = [...presets, { name, params: { ...preset.params }, savedAt: preset.savedAt }];
      }
      imported.push(answer.server.url);
    }
    await this.write({ presets, imported });
  }

  async list(servers: readonly StoredServer[]): Promise<Preset[]> {
    await this.importFrom(servers);
    const { presets } = await this.read();
    return [...presets].sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(servers: readonly StoredServer[], name: string, form: SongForm): Promise<Preset[]> {
    await this.importFrom(servers);
    const document = await this.read();
    const wanted = name.trim();
    const preset: Preset = { name: wanted, params: presetParams(form), savedAt: new Date(this.now()).toISOString() };
    await this.write({ ...document, presets: [...document.presets.filter((p) => p.name !== wanted), preset] });
    return this.list(servers);
  }

  async remove(servers: readonly StoredServer[], name: string): Promise<Preset[]> {
    await this.importFrom(servers);
    const document = await this.read();
    await this.write({ ...document, presets: document.presets.filter((p) => p.name !== name) });
    return this.list(servers);
  }
}
