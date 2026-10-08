import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';

import { batchCount } from '@shared/batch';
import { addTags, clashesWith, joinTags, splitTags, toggleTag, withoutVoice } from '@shared/tags';
import { TAG_MODEL, type DescribeResult, type Preset, type RefusalView, type SongForm, type SongPage, type SongParams } from '@shared/types';

import { HubService } from './hub.service';
import { JobsService } from './jobs.service';
import { PlayerService } from './player.service';

/**
 * The studio's state: the active server's song page and presets, and the form.
 *
 * It lives in a service rather than the page so a trip to Settings and back
 * keeps what was typed. The page (suggestions, conflicts, cfg limits) and the
 * presets are re-read from the server whenever the active server changes.
 */
@Injectable({ providedIn: 'root' })
export class StudioService {
  private readonly hub = inject(HubService);
  private readonly jobs = inject(JobsService);
  private readonly player = inject(PlayerService);
  private readonly router = inject(Router);

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

  // ── describe the music ─────────────────────────────────────────────────────
  /** The chat model the hub asks, named in the hint. */
  readonly tagModel = TAG_MODEL;
  readonly description = signal('');
  readonly describing = signal(false);
  readonly described = signal<DescribeResult | null>(null);
  readonly describeRefusal = signal<RefusalView | null>(null);
  /** The model wrote words, but the Lyrics box held the person's own: theirs stayed. */
  readonly lyricsKept = signal(false);
  /** Seconds the describe call has been running (shown beside its progress bar). */
  readonly describeElapsed = signal(0);
  /** The words the model last wrote into the box (replaced freely; anything else is the person's). */
  private lastWritten = '';

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
    // Whenever the active server changes (and once it is first known), read its page and presets.
    effect(() => {
      const active = this.hub.activeServer();
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
    this.loadingPage.set(true);
    const outcome = await this.hub.call<SongPage>('GET', '/api/song-page');
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
    const outcome = await this.hub.call<Preset[]>('GET', '/api/presets');
    if (outcome.ok) {
      this.presets.set(outcome.value);
      this.presetsRefusal.set(null);
    } else {
      this.presets.set([]);
      this.presetsRefusal.set(outcome.refusal);
    }
  }

  /** Ask the server's tag model for tags; they replace the chips, and set Instrumental. */
  /**
   * Fill in the tags (and the lyrics when sung). `instrumental` is what the
   * person picked where they are: the song's switch, or the album's Vocals
   * choice; picked instrumental, no lyrics are written and no singer is tagged.
   */
  async describe(instrumental = this.instrumental(), forAlbum = false): Promise<void> {
    this.describing.set(true);
    this.describeRefusal.set(null);
    this.described.set(null);
    // Seconds since it was asked, for the progress line: the model can take a while to load.
    const started = Date.now();
    this.describeElapsed.set(0);
    const ticker = setInterval(() => this.describeElapsed.set(Math.floor((Date.now() - started) / 1000)), 1000);
    const outcome = await this.hub.call<DescribeResult>('POST', '/api/describe', { text: this.description(), instrumental });
    clearInterval(ticker);
    this.describing.set(false);
    if (!outcome.ok) {
      this.describeRefusal.set(outcome.refusal);
      return;
    }
    this.tags.set([...outcome.value.tags]);
    // An album's tracks follow its own Vocals choice: the song's switch and Lyrics box are not the album's.
    if (forAlbum) {
      this.described.set(outcome.value);
      return;
    }
    if (this.page()?.instrumental !== false) this.instrumental.set(outcome.value.instrumental);
    // The words it wrote fill the Lyrics box, unless the person wrote their own there.
    const written = outcome.value.lyrics;
    const box = this.lyrics().trim();
    this.lyricsKept.set(false);
    if (written !== null) {
      if (box === '' || box === this.lastWritten) {
        this.lyrics.set(written);
        this.lastWritten = written;
      } else {
        this.lyricsKept.set(true);
      }
    }
    this.described.set(outcome.value);
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
    const checked = this.params();
    if ('code' in checked) return checked;
    const outcome = await this.hub.call<Preset[]>('PUT', `/api/presets/${encodeURIComponent(name.trim())}`, this.form());
    if (!outcome.ok) return outcome.refusal;
    this.presets.set(outcome.value);
    return null;
  }

  async deletePreset(name: string): Promise<RefusalView | null> {
    const outcome = await this.hub.call<Preset[]>('DELETE', `/api/presets/${encodeURIComponent(name)}`);
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
    // A song is made to be fast (Owen, 2026-10-05): with no tags picked, the description itself is
    // the style line, straight to the song model, with no chat model in the way. "Fill in the tags"
    // is there for whoever wants the tag model's pick (and lyrics) first.
    // Instrumental means no voice (Owen, 2026-10-08): a singer among the chips (a preset's) is left out.
    const tags = (this.instrumental() ? joinTags(withoutVoice(this.tags())) : this.tagLine()) || this.description().trim();
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
    const made = await this.jobs.generate({ params, count: batchCount(this.count()) });
    this.sending.set(false);
    if (!Array.isArray(made)) {
      this.generateRefusal.set(made);
      return;
    }
    // As an album (Owen, 2026-10-07): the song is made at the end of its playlist (New Songs), shown
    // there with its progress, and plays when it lands.
    this.player.playWhenMade(made.map((job) => job.key));
    const playlist = made[0]?.playlist;
    if (playlist != null) void this.router.navigate(['/library', playlist]);
  }
}
