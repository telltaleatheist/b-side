import { computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';

import { batchCount } from '@shared/batch';
import { addTags, clashesWith, joinTags, leadFits, splitTags, toggleTag, withoutVoice } from '@shared/tags';
import {
  ALBUM_TAG_MODES, LENGTH_AIMS, type AlbumAsk, type AlbumTagMode, type AlbumTemplate, type AlbumTemplateSummary, type PlannedTrack, type DescribeResult, type Preset, type RefusalView, type SongForm, type SongPage, type SongParams } from '@shared/types';

import { HubService } from './hub.service';
import { JobsService } from './jobs.service';
import { PlayerService } from './player.service';

/**
 * The studio's state: the active server's song page, the app's presets, and the form.
 *
 * It lives in a service rather than the page so a trip to Settings and back
 * keeps what was typed. The page (suggestions, conflicts, cfg limits) is re-read
 * from the server whenever the active server changes. Presets are the app's own
 * (1.0.13); they are re-read then too, since a new server's old presets come over.
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
  /**
   * The lead: who or what carries the melody, one a song (Owen, 2026-10-11: "the user (or the ai)
   * can pick one of the available tags as 'the' melody instrument"). Sung, the singer; instrumental,
   * one instrument, sent as "<instrument> melody". Kept out of the chips; '' leaves it to the writer.
   */
  readonly lead = signal('');
  /** What the lyrics should be about, or their mood and style (Owen, 2026-10-09): a song's, or a sung album's. */
  readonly lyricsBrief = signal('');
  /** As typed; blank sends nothing and the server's default applies. */
  readonly cfg = signal('');
  readonly seed = signal('');
  readonly count = signal(1);

  // ── describe the music ─────────────────────────────────────────────────────
  /** The chat model the hub asks on this server (the full one, or 4-bit on a small card), named in the hint. */
  readonly tagModel = computed(() => this.page()?.writer ?? this.page()?.tagModel ?? null);
  readonly description = signal('');
  /** The person's own name for the song or album (Victoria, 2026-10-11); '' leaves it to the writer. */
  readonly name = signal('');
  /** Lyrics with a pre-chorus (Owen, 2026-10-11: an option, with a warning), as last chosen on this device. */
  readonly preChorus = signal(readPreChorus());
  /** "Pronounce phonetically" (Owen, 2026-10-11): as last left on this device. */
  readonly phonetic = signal(readChoice(PHONETIC_KEY));
  /** A sung album in the person's own words (Owen, 2026-10-11): on, the words box replaces the brief. */
  readonly ownWords = signal(false);
  readonly ownText = signal('');
  /** Their words given verse and chorus tags (no word changed); as last left on this device. */
  readonly addSections = signal(readChoice(ADD_SECTIONS_KEY));
  /** The length to aim for (LENGTH_AIMS' key), or '' for the server's own; songs and albums share it. */
  readonly lengthAim = signal('');
  /**
   * An album to make again (Victoria, 2026-10-10: "B-sides would start on the album fresh. That
   * way I don't have to remember the prompt again"): what it was asked, for Make to open with.
   */
  readonly remake = signal<{ readonly ask: AlbumAsk; readonly server: string } | null>(null);

  // ── Make → Album, "I want to plan it" (Victoria, 2026-10-12) ──────────────
  /** Generate for me (as before), or plan it song by song. */
  readonly albumWay = signal<'generate' | 'plan'>('generate');
  readonly planTagMode = signal<AlbumTagMode>('vibe');
  /** The tracks being planned, in order; kept on this device as a draft (PLAN_KEY) until cleared. */
  readonly planTracks = signal<PlanTrackDraft[]>([]);
  /** The templates on the hub (names and sizes), as last listed. */
  readonly templates = signal<AlbumTemplateSummary[]>([]);

  /** A new blank track: sung as the album is, its tags the album's (for "Set tags for each song"). */
  blankTrack(sung: boolean): PlanTrackDraft {
    return { title: '', lyrics: '', brief: '', briefOpen: false, tags: joinTags(this.tags()), sung, lead: '' };
  }

  /** Change one track of the plan. */
  editTrack(at: number, change: Partial<PlanTrackDraft>): void {
    this.planTracks.update((tracks) => tracks.map((track, i) => (i === at ? { ...track, ...change } : track)));
  }

  /** "Set tags for each song": a track with no tags of its own starts from the album's. */
  setTagMode(mode: AlbumTagMode): void {
    this.planTagMode.set(mode);
    if (mode !== 'per-song') return;
    const tags = joinTags(this.tags());
    this.planTracks.update((tracks) => tracks.map((track) => (track.tags.trim() === '' ? { ...track, tags } : track)));
  }

  /** Start the plan afresh: one blank track, the vibe of the album's tags. */
  clearPlan(sung: boolean): void {
    this.planTracks.set([this.blankTrack(sung)]);
    this.planTagMode.set('vibe');
  }

  /**
   * The plan as POST /api/albums takes it (AlbumAsk.plan). A track's lyrics go only when it is sung,
   * and its brief only when it has no lyrics, as the form shows them; its tags only for "Set tags
   * for each song".
   */
  planBody(albumSung: boolean): { tagMode: AlbumTagMode; tracks: PlannedTrack[] } {
    const mode = this.planTagMode();
    return {
      tagMode: mode,
      tracks: this.planTracks().map((track): PlannedTrack => {
        const lyrics = track.sung ? track.lyrics : '';
        const tags = splitTags(track.tags);
        return {
          ...(track.title.trim() !== '' ? { title: track.title.trim() } : {}),
          ...(lyrics.trim() !== '' ? { lyrics } : {}),
          ...(lyrics.trim() === '' && track.brief.trim() !== '' ? { brief: track.brief.trim() } : {}),
          ...(mode === 'per-song' && tags.length > 0 ? { tags } : {}),
          ...(track.sung !== albumSung ? { sung: track.sung } : {}),
          ...(track.lead.trim() !== '' ? { lead: track.lead.trim() } : {}),
        };
      }),
    };
  }

  /** The plan from a sent one (a template, or an album made again): every track as the form shows it. */
  private fillPlan(plan: { tagMode: AlbumTagMode; tracks: readonly PlannedTrack[] }, sung: boolean): void {
    this.planTagMode.set(plan.tagMode);
    this.planTracks.set(plan.tracks.map((track) => ({
      title: track.title ?? '',
      lyrics: track.lyrics ?? '',
      brief: track.brief ?? '',
      briefOpen: track.brief !== undefined,
      tags: track.tags !== undefined ? joinTags(track.tags) : plan.tagMode === 'per-song' ? joinTags(this.tags()) : '',
      sung: track.sung ?? sung,
      lead: track.lead ?? '',
    })));
    this.albumWay.set('plan');
  }

  async listTemplates(): Promise<RefusalView | null> {
    const outcome = await this.hub.call<AlbumTemplateSummary[]>('GET', '/api/album-templates');
    if (!outcome.ok) return outcome.refusal;
    this.templates.set(outcome.value);
    return null;
  }

  /** Save the plan, and the album's description, tags, lead and Vocals, under `name` on the hub. */
  async saveTemplate(name: string, albumSung: boolean): Promise<RefusalView | null> {
    const outcome = await this.hub.call<AlbumTemplateSummary[]>('PUT', `/api/album-templates/${encodeURIComponent(name.trim())}`, {
      description: this.description(), tags: this.tags(), lead: this.lead().trim(), sung: albumSung, plan: this.planBody(albumSung),
    });
    if (!outcome.ok) return outcome.refusal;
    this.templates.set(outcome.value);
    return null;
  }

  /** Fill the plan (and the album's description, tags and lead) from a template; answers its Vocals. */
  async loadTemplate(name: string): Promise<AlbumTemplate | RefusalView> {
    const outcome = await this.hub.call<AlbumTemplate>('GET', `/api/album-templates/${encodeURIComponent(name)}`);
    if (!outcome.ok) return outcome.refusal;
    const template = outcome.value;
    this.description.set(template.description);
    this.tags.set([...template.tags]);
    this.lead.set(template.lead);
    this.fillPlan(template.plan, template.sung);
    return template;
  }

  async deleteTemplate(name: string): Promise<RefusalView | null> {
    const outcome = await this.hub.call<AlbumTemplateSummary[]>('DELETE', `/api/album-templates/${encodeURIComponent(name)}`);
    if (!outcome.ok) return outcome.refusal;
    this.templates.set(outcome.value);
    return null;
  }

  /** Fill the form with an album's ask and open Make → Album on it, to change and make again. */
  remakeAlbum(ask: AlbumAsk, server: string): void {
    this.description.set(ask.description);
    this.tags.set([...ask.tags]);
    this.lead.set(ask.lead ?? '');
    this.lyricsBrief.set(ask.lyrics ?? '');
    if (ask.plan !== undefined) this.fillPlan(ask.plan, ask.sung);
    else this.albumWay.set('generate');
    this.ownWords.set(ask.ownWords !== undefined);
    this.ownText.set((ask.ownWords ?? []).map((track) => (track.title !== null ? `# ${track.title}\n` : '') + track.lyrics).join('\n\n---\n\n'));
    this.cfg.set(ask.cfg == null ? '' : String(ask.cfg));
    this.lengthAim.set(ask.trackLength ?? '');
    this.described.set(null);
    this.remake.set({ ask, server });
  }
  readonly describing = signal(false);
  readonly described = signal<DescribeResult | null>(null);
  readonly describeRefusal = signal<RefusalView | null>(null);
  /** The model wrote words, but the Lyrics box held the person's own: theirs stayed. */
  readonly lyricsKept = signal(false);
  /** Seconds the describe call has been running (shown beside its progress bar). */
  readonly describeElapsed = signal(0);
  /** The words the model last wrote into the box (replaced freely; anything else is the person's). */
  private lastWritten = '';
  /** The name the writer gave the song it described, and the lyrics it named (null: none). */
  readonly title = signal<string | null>(null);
  private titledLyrics = '';

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
    // The plan draft: read once, then kept as it changes, so a long poems plan survives a reload.
    const draft = readPlanDraft();
    if (draft !== null) {
      this.albumWay.set(draft.way);
      this.planTagMode.set(draft.tagMode);
      this.planTracks.set(draft.tracks);
    }
    effect(() => keepPlanDraft({ way: this.albumWay(), tagMode: this.planTagMode(), tracks: this.planTracks() }));
    // Whenever the active server changes (and once it is first known), read its page and presets.
    effect(() => {
      const active = this.hub.activeServer();
      untracked(() => {
        if (active === null) {
          this.page.set(null);
          this.pageRefusal.set(null);
          void this.loadPresets();
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
    const text = this.description().trim() || this.tagLine() || this.lyricsBrief().trim();
    const lyrics = instrumental || forAlbum ? '' : this.lyricsBrief().trim();
    const name = this.name().trim();
    const outcome = await this.hub.call<DescribeResult>('POST', '/api/describe', {
      text, instrumental, lyrics, preChorus: this.preChorus(), phonetic: this.phonetic(), ...(name !== '' && !forAlbum ? { title: name } : {}),
    });
    clearInterval(ticker);
    this.describing.set(false);
    if (!outcome.ok) {
      this.describeRefusal.set(outcome.refusal);
      return;
    }
    // The lead it picked fills Lead, and is not a chip as well (Owen, 2026-10-11). Not an instrumental
    // album's: a lead in the box is every track's, and each track names its own melody instrument.
    const lead = forAlbum && outcome.value.instrumental ? '' : outcome.value.lead ?? '';
    this.lead.set(lead);
    this.tags.set(outcome.value.tags.filter((tag) => tag.toLowerCase() !== lead.toLowerCase()));
    // An album's tracks follow its own Vocals choice: the song's switch and Lyrics box are not the album's.
    if (forAlbum) {
      this.described.set(outcome.value);
      return;
    }
    if (this.page()?.instrumental !== false) this.instrumental.set(outcome.value.instrumental);
    this.title.set(outcome.value.title ?? null);
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
        // Named for the words it wrote, which were not kept: the person's own song goes unnamed.
        this.title.set(null);
      }
    }
    this.titledLyrics = this.lyricsSent();
    this.described.set(outcome.value);
  }

  /** The lyrics a song would be sent with now ('' when instrumental). */
  private lyricsSent(): string {
    return this.instrumental() ? '' : this.lyrics().trim();
  }

  /** The writer's name for the song, while its lyrics are still the ones it named. */
  songTitle(): string | null {
    // The person's own name stands, whatever lyrics it is sent with.
    if (this.name().trim() !== '') return this.name().replace(/\s+/g, ' ').trim();
    const title = this.title();
    return title !== null && this.lyricsSent() === this.titledLyrics ? title : null;
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
      ...(this.lead().trim() !== '' ? { lead: this.lead().trim() } : {}),
    };
  }

  /**
   * Fill the form from a preset: chips, lyrics, instrumental, cfg, lead — whatever it holds. The
   * lead is its own param (Owen, 2026-10-11); a preset from before has none, and Lead is blank.
   */
  applyPreset(preset: Preset): void {
    const params = preset.params;
    if (typeof params['tags'] === 'string') this.tags.set(splitTags(params['tags']));
    if (typeof params['lyrics'] === 'string') this.lyrics.set(params['lyrics']);
    if (typeof params['instrumental'] === 'boolean') this.instrumental.set(params['instrumental']);
    if (typeof params['cfg'] === 'number') this.cfg.set(String(params['cfg']));
    this.lead.set(typeof params['lead'] === 'string' ? params['lead'] : '');
  }

  /** A lead that no longer fits after Vocals changed (a singer on an instrumental, an instrument on a sung song) is cleared. */
  fitLead(instrumental: boolean): void {
    const lead = this.lead().trim();
    if (lead !== '' && !leadFits(lead, instrumental)) this.lead.set('');
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
    // The hub puts the lead first in the tags (styleLine) and sends Crucible no `lead`.
    const lead = this.lead().trim();
    if (lead !== '') params.lead = lead;
    if (!this.instrumental() && this.lyrics().trim() !== '') params.lyrics = this.lyrics();
    if (this.page()?.instrumental !== false) params.instrumental = this.instrumental();
    const cfg = this.cfg().trim();
    if (cfg !== '') {
      const value = Number(cfg);
      if (!Number.isFinite(value)) return { code: 'cfg_invalid', message: `Guidance "${cfg}" is not a number.` };
      params.cfg = value;
    }
    // A length to aim for, when this server's YuE2 makes instrumentals (B-Sides sizes them, 2026-10-11).
    const aim = LENGTH_AIMS.find((choice) => choice.key === this.lengthAim());
    if (aim !== undefined && this.page()?.length === true) {
      params.min_duration_s = aim.min;
      params.max_duration_s = aim.max;
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
    // Asked what the lyrics are about, with none written yet: write them first (and the tags, if none).
    if (!this.instrumental() && this.lyricsBrief().trim() !== '' && this.lyrics().trim() === '') {
      const keep = this.tags().length > 0 ? [...this.tags()] : null;
      const keepLead = this.lead().trim();
      this.sending.set(true);
      await this.describe(false);
      this.sending.set(false);
      if (keep !== null) this.tags.set(keep);
      if (keepLead !== '') this.lead.set(keepLead);
      if (this.describeRefusal() !== null || this.lyrics().trim() === '') return;
    }
    const params = this.params();
    if ('code' in params) {
      this.generateRefusal.set(params);
      return;
    }
    this.sending.set(true);
    this.generateRefusal.set(null);
    const title = this.songTitle();
    const made = await this.jobs.generate({ params, count: batchCount(this.count()), ...(title !== null ? { title } : {}) });
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

/** One track of the plan as the form holds it: every box as typed (tags as one comma line). */
export interface PlanTrackDraft {
  readonly title: string;
  readonly lyrics: string;
  readonly brief: string;
  /** "Or say what it's about" opened: the brief box shows instead of the lyrics box being the only one. */
  readonly briefOpen: boolean;
  readonly tags: string;
  readonly sung: boolean;
  readonly lead: string;
}

interface PlanDraft {
  readonly way: 'generate' | 'plan';
  readonly tagMode: AlbumTagMode;
  readonly tracks: PlanTrackDraft[];
}

/** The plan draft on this device (Victoria, 2026-10-12): a draft to finish later, beside the hub's templates. */
const PLAN_KEY = 'b-sides.albumPlan';

function readPlanDraft(): PlanDraft | null {
  try {
    const text = localStorage.getItem(PLAN_KEY);
    if (text === null) return null;
    const stored = JSON.parse(text) as Partial<PlanDraft>;
    const text_ = (value: unknown): string => (typeof value === 'string' ? value : '');
    return {
      way: stored.way === 'plan' ? 'plan' : 'generate',
      tagMode: ALBUM_TAG_MODES.includes(stored.tagMode as AlbumTagMode) ? stored.tagMode as AlbumTagMode : 'vibe',
      tracks: (Array.isArray(stored.tracks) ? stored.tracks : []).map((track: Partial<PlanTrackDraft>) => ({
        title: text_(track?.title), lyrics: text_(track?.lyrics), brief: text_(track?.brief), briefOpen: track?.briefOpen === true,
        tags: text_(track?.tags), sung: track?.sung !== false, lead: text_(track?.lead),
      })),
    };
  } catch {
    // Unreadable, or a private window: no draft.
    return null;
  }
}

function keepPlanDraft(draft: PlanDraft): void {
  try {
    localStorage.setItem(PLAN_KEY, JSON.stringify(draft));
  } catch {
    // A private window, or the device's storage full: the draft is only not kept.
  }
}

const PRE_CHORUS_KEY = 'b-sides.preChorus';
export const PHONETIC_KEY = 'b-sides.phonetic';
export const ADD_SECTIONS_KEY = 'b-sides.addSections';

/** A checkbox's choice last made on this device; off until one is chosen. */
function readChoice(key: string): boolean {
  try {
    return localStorage.getItem(key) === 'yes';
  } catch {
    return false;
  }
}

/** The pre-chorus choice last made on this device; none until one is chosen. */
function readPreChorus(): boolean {
  return readChoice(PRE_CHORUS_KEY);
}

/** Keep a checkbox's choice for next time (Owen: the checkbox starts as it was last left). */
export function keepChoice(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? 'yes' : 'no');
  } catch {
    // A private window: it is only forgotten.
  }
}

/** Keep the pre-chorus choice for next time. */
export function keepPreChorus(on: boolean): void {
  keepChoice(PRE_CHORUS_KEY, on);
}
