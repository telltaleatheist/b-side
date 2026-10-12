/**
 * album-templates — planned albums saved by name, to start the next one from (Victoria, 2026-10-12:
 * "Both": a draft on the device to finish later, and templates by name for a series, such as her
 * poems albums). Kept by the hub in `templates.json` beside presets.json, so the phone and the
 * desktop see the same ones. A template is checked as an album's plan is (plannedAlbum), so one
 * that saves is one that makes.
 */
import { join, type Disk } from './disk';
import { Refusal } from './refusal';
import type { AlbumTemplate, AlbumTemplateSummary, AlbumTrackPlan } from '../types';

interface Document {
  templates: AlbumTemplate[];
}

/** What a template is saved from: the album's own choices and its plan, checked by the caller. */
export type TemplateBody = Omit<AlbumTemplate, 'name' | 'savedAt'> & { readonly plan: AlbumTrackPlan };

export class TemplateStore {
  private document: Document | null = null;

  constructor(
    private readonly disk: Disk,
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private get file(): string {
    return join(this.dataDir, 'templates.json');
  }

  private async read(): Promise<Document> {
    if (this.document !== null) return this.document;
    const text = await this.disk.readText(this.file);
    let document: Document = { templates: [] };
    if (text !== null) {
      try {
        const stored = JSON.parse(text) as Partial<Document>;
        document = {
          templates: Array.isArray(stored.templates)
            ? stored.templates.filter((t) => typeof t?.name === 'string' && Array.isArray(t.plan?.tracks))
            : [],
        };
      } catch (err) {
        // Never overwritten while unreadable: the templates would be lost. Set aside, then started afresh.
        console.error(`[templates] ${this.file} could not be read; kept as templates.unreadable.json:`, err);
        await this.disk.copy(this.file, join(this.dataDir, 'templates.unreadable.json'));
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

  /** Every template, by name: its name, when it was saved, and how many songs it plans. */
  async list(): Promise<AlbumTemplateSummary[]> {
    const { templates } = await this.read();
    return [...templates]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, savedAt: t.savedAt, tracks: t.plan.tracks.length }));
  }

  /** One template whole, to fill the plan with. */
  async get(name: string): Promise<AlbumTemplate> {
    const found = (await this.read()).templates.find((t) => t.name === name);
    if (found === undefined) throw new Refusal('template_missing', `There is no template called "${name}".`, 404);
    return found;
  }

  /** Save under `name` (a template of that name is replaced). */
  async save(name: string, body: TemplateBody): Promise<AlbumTemplateSummary[]> {
    const wanted = name.replace(/\s+/g, ' ').trim();
    if (wanted === '') throw new Refusal('template_name', 'Name the template first.');
    if (wanted.length > 120) throw new Refusal('template_name', `A template's name is at most 120 characters; this one is ${wanted.length}.`);
    const document = await this.read();
    const template: AlbumTemplate = { ...body, name: wanted, savedAt: new Date(this.now()).toISOString() };
    await this.write({ templates: [...document.templates.filter((t) => t.name !== wanted), template] });
    return this.list();
  }

  async remove(name: string): Promise<AlbumTemplateSummary[]> {
    const document = await this.read();
    await this.write({ templates: document.templates.filter((t) => t.name !== name) });
    return this.list();
  }
}
