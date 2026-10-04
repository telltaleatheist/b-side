import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';

import { batchCount } from '@shared/batch';
import { addTags, clashesWith, joinTags, splitTags, toggleTag } from '@shared/tags';
import type { Preset, RefusalView, SongForm, SongPage, SongParams } from '@shared/types';

import { api } from './bside';
import { JobsService } from './jobs.service';
import { ServersService } from './servers.service';

/**
 * The studio's state: the active server's song page and presets, and the form.
 *
 * It lives in a service rather than the page so a trip to Settings and back
 * keeps what was typed. The page (suggestions, conflicts, cfg limits) and the
 * presets are re-read from the server whenever the active server changes.
 */
@Injectable({ providedIn: 'root' })
export class StudioService {
  private readonly servers = inject(ServersService);
  private readonly jobs = inject(JobsService);

  readonly page = signal<SongPage | null>(null);
  readonly pageRefusal = signal<RefusalView | null>(null);
  readonly loadingPage = signal(false);

  readonly presets = signal<Preset[]>([]);
  readonly presetsRefusal = signal<RefusalView | null>(null);

  // ── the form ───────────────────────────────────────────────────────────────
  readonly tags = signal<string[]>([]);
  readonly lyrics = signal('');
  readonly instrumental = signal(false);
  /** As typed; blank sends nothing and the server's default applies. */
  readonly cfg = signal('');
  readonly seed = signal('');
  readonly count = signal(1);

  /** The refusal from the last Generate press, shown by the button. */
  readonly generateRefusal = signal<RefusalView | null>(null);
  readonly sending = signal(false);

  /** Picked tags that contradict another picked tag (red chips). */
  readonly conflicted = computed(() => {
    const conflicts = this.page()?.conflicts ?? {};
    const tags = this.tags();
    return new Set(tags.filter((tag) => clashesWith(tag, tags, conflicts).length > 0).map((t) => t.toLowerCase()));
  });

  constructor() {
    if (api === null) return;
    // Whenever the active server changes (and once it is first known), read its page and presets.
    effect(() => {
      const active = this.servers.active();
      untracked(() => {
        if (active === null) {
          this.page.set(null);
          this.presets.set([]);
          this.pageRefusal.set(null);
          return;
        }
        void this.reload();
      });
    });
  }

  async reload(): Promise<void> {
    if (api === null) return;
    this.loadingPage.set(true);
    const outcome = await api.song.page();
    this.loadingPage.set(false);
    if (outcome.ok) {
      this.page.set(outcome.value);
      this.pageRefusal.set(null);
      // The server's default guidance, until somebody types their own.
      const cfg = outcome.value.cfg?.default;
      if (this.cfg() === '' && cfg !== null && cfg !== undefined) this.cfg.set(String(cfg));
    } else {
      this.page.set(null);
      this.pageRefusal.set(outcome.refusal);
    }
    await this.loadPresets();
  }

  async loadPresets(): Promise<void> {
    if (api === null) return;
    const outcome = await api.presets.list();
    if (outcome.ok) {
      this.presets.set(outcome.value);
      this.presetsRefusal.set(null);
    } else {
      this.presets.set([]);
      this.presetsRefusal.set(outcome.refusal);
    }
  }

  // ── tags ───────────────────────────────────────────────────────────────────
  addTags(text: string): void {
    this.tags.update((tags) => addTags(tags, text));
  }

  toggleTag(tag: string): void {
    this.tags.update((tags) => toggleTag(tags, tag));
  }

  removeTag(index: number): void {
    this.tags.update((tags) => tags.filter((_, at) => at !== index));
  }

  tagLine(): string {
    return joinTags(this.tags());
  }

  // ── presets ────────────────────────────────────────────────────────────────
  form(): SongForm {
    const cfg = this.cfg().trim();
    return {
      tags: this.tagLine(),
      lyrics: this.lyrics(),
      instrumental: this.instrumental(),
      cfg: cfg === '' ? null : Number(cfg),
    };
  }

  /** Fill the form from a preset: chips, lyrics, instrumental, cfg — whatever it holds. */
  applyPreset(preset: Preset): void {
    const params = preset.params;
    if (typeof params['tags'] === 'string') this.tags.set(splitTags(params['tags']));
    if (typeof params['lyrics'] === 'string') this.lyrics.set(params['lyrics']);
    if (typeof params['instrumental'] === 'boolean') this.instrumental.set(params['instrumental']);
    if (typeof params['cfg'] === 'number') this.cfg.set(String(params['cfg']));
  }

  async savePreset(name: string): Promise<RefusalView | null> {
    if (api === null) return null;
    const checked = this.params();
    if ('code' in checked) return checked;
    const outcome = await api.presets.save(name, this.form());
    if (!outcome.ok) return outcome.refusal;
    this.presets.set(outcome.value);
    return null;
  }

  async deletePreset(name: string): Promise<RefusalView | null> {
    if (api === null) return null;
    const outcome = await api.presets.remove(name);
    if (!outcome.ok) return outcome.refusal;
    this.presets.set(outcome.value);
    return null;
  }

  // ── generate ───────────────────────────────────────────────────────────────
  /**
   * The request's params, as the playground builds them: the joined chips, the
   * lyrics unless instrumental, `instrumental` itself, cfg and seed when given.
   * Whether they make a valid song is the server's to say — its refusal
   * (`audio_param_missing`, `audio_param_conflict`, ...) is shown as it comes.
   */
  params(): SongParams | RefusalView {
    const params: { -readonly [K in keyof SongParams]: SongParams[K] } = {};
    const tags = this.tagLine();
    if (tags !== '') params.tags = tags;
    if (!this.instrumental() && this.lyrics().trim() !== '') params.lyrics = this.lyrics();
    if (this.page()?.instrumental !== false) params.instrumental = this.instrumental();
    const cfg = this.cfg().trim();
    if (cfg !== '') {
      const value = Number(cfg);
      if (!Number.isFinite(value)) return { code: 'cfg_invalid', message: `Guidance "${cfg}" is not a number.` };
      params.cfg = value;
    }
    const seed = this.seed().trim();
    if (seed !== '') {
      const value = Number(seed);
      // Only the parse is ours; the server states (and refuses) its own range.
      if (!Number.isInteger(value)) {
        return { code: 'seed_invalid', message: `A seed is a whole number; "${seed}" is not one. Leave it blank for a new one each time.` };
      }
      params.seed = value;
    }
    return params;
  }

  async generate(): Promise<void> {
    const params = this.params();
    if ('code' in params) {
      this.generateRefusal.set(params);
      return;
    }
    this.sending.set(true);
    this.generateRefusal.set(null);
    const refusal = await this.jobs.generate({ params, count: batchCount(this.count()) });
    this.sending.set(false);
    this.generateRefusal.set(refusal);
  }
}
