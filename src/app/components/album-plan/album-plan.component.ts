import { CdkDrag, CdkDragHandle, CdkDragPlaceholder, CdkDropList, moveItemInArray, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, computed, inject, model, signal, type OnInit } from '@angular/core';

import { OWN_WORDS_MAX } from '@shared/own-words';
import { leadFits } from '@shared/tags';
import { PLAN_TRACKS_MAX, type AlbumTagMode, type RefusalView } from '@shared/types';

import { ConfirmService } from '../../core/confirm.service';
import { StudioService, type PlanTrackDraft } from '../../core/studio.service';
import { IconComponent } from '../icon/icon.component';
import { RefusalComponent } from '../refusal/refusal.component';

/**
 * Make → Album's "I want to plan it" (Victoria, 2026-10-12): "choose the number of songs I want on
 * the album and then go song by song and enter in the lyrics", so a poems album is made in one go.
 * Each track's lyrics box comes first, sung exactly as written; "Or say what it's about" is the
 * second choice, and a track left blank is written for her as in a generated album. Each track is
 * sung or instrumental and may have its own lead (the album's Vocals and Lead are the defaults);
 * with "Set tags for each song" each has its own tags. Tracks drag into order (the grip, by mouse or
 * touch) or move with the arrows, and can be duplicated or deleted. The plan is a draft on this
 * device until cleared; templates by name are the hub's, so every device sees them.
 */
@Component({
  selector: 'app-album-plan',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CdkDropList, CdkDrag, CdkDragHandle, CdkDragPlaceholder, IconComponent, RefusalComponent],
  template: `
    <div class="count-row">
      <label class="label" for="plan-count">Number of songs</label>
      <input id="plan-count" type="number" inputmode="numeric" min="1" [max]="maxTracks" step="1"
             [value]="studio.planTracks().length" (change)="setCount($any($event.target))" />
    </div>
    @if (countWrong(); as wrong) { <p class="hint warn">{{ wrong }}</p> }

    <div class="field">
      <span class="label">Tags</span>
      <div class="opt-chips">
        @for (mode of tagModes; track mode.key) {
          <button type="button" class="chip" [class.on]="studio.planTagMode() === mode.key" (click)="studio.setTagMode(mode.key)">{{ mode.label }}</button>
        }
      </div>
      <p class="hint">{{ tagModeHint() }}</p>
    </div>

    <div class="tracks" cdkDropList (cdkDropListDropped)="dropped($event)">
      @for (track of studio.planTracks(); track $index; let at = $index, first = $first, last = $last) {
        <div class="track" cdkDrag cdkDragLockAxis="y">
          <div class="track-head">
            <span class="grip" cdkDragHandle aria-label="Drag to move" title="Drag to move"><app-icon name="grip" [size]="16" /></span>
            <span class="num mono">{{ at + 1 }}</span>
            <input type="text" maxlength="120" autocomplete="off" class="title" [attr.aria-label]="'Song ' + (at + 1) + ' name'"
                   placeholder="Name (optional)" [value]="track.title" (input)="studio.editTrack(at, { title: $any($event.target).value })" />
          </div>
          <div class="track-tools">
            <div class="opt-chips">
              <button type="button" class="chip" [class.on]="track.sung" (click)="studio.editTrack(at, { sung: true })">Sung</button>
              <button type="button" class="chip" [class.on]="!track.sung" (click)="studio.editTrack(at, { sung: false })">Instrumental</button>
            </div>
            <div class="moves">
              <button type="button" class="icon-btn" [attr.aria-label]="'Move song ' + (at + 1) + ' up'" title="Move up" [disabled]="first" (click)="move(at, at - 1)"><app-icon name="down" [size]="18" class="up" /></button>
              <button type="button" class="icon-btn" [attr.aria-label]="'Move song ' + (at + 1) + ' down'" title="Move down" [disabled]="last" (click)="move(at, at + 1)"><app-icon name="down" [size]="18" /></button>
              <button type="button" class="ghost small" [disabled]="full()" (click)="duplicate(at)">Duplicate</button>
              <button type="button" class="icon-btn" [attr.aria-label]="'Delete song ' + (at + 1)" title="Delete" [disabled]="studio.planTracks().length <= 1" (click)="remove(at)"><app-icon name="trash" [size]="18" /></button>
            </div>
          </div>
          @if (track.sung) {
            <textarea rows="6" spellcheck="true" class="lyrics" [class.over]="track.lyrics.length > lyricsMax" [attr.aria-label]="'Song ' + (at + 1) + ' lyrics'"
                      placeholder="The lyrics, sung exactly as written. Leave empty to have them written for you."
                      [value]="track.lyrics" (input)="studio.editTrack(at, { lyrics: $any($event.target).value })"></textarea>
            @if (track.lyrics.length > lyricsMax * 0.8) {
              <p class="hint" [class.warn]="track.lyrics.length > lyricsMax">{{ track.lyrics.length }} / {{ lyricsMax }}{{ track.lyrics.length > lyricsMax ? ': too long for one song. Split it into two; nothing is cut.' : '' }}</p>
            }
            @if (track.lyrics.trim() === '') {
              @if (track.briefOpen || track.brief !== '') {
                <input type="text" maxlength="2000" autocomplete="off" [attr.aria-label]="'What song ' + (at + 1) + ' is about'"
                       placeholder="What it's about, e.g. a lighthouse keeper's last night"
                       [value]="track.brief" (input)="studio.editTrack(at, { brief: $any($event.target).value })" />
              } @else {
                <button type="button" class="link" (click)="studio.editTrack(at, { briefOpen: true })">Or say what it's about instead</button>
              }
            }
          } @else {
            <input type="text" maxlength="2000" autocomplete="off" [attr.aria-label]="'What song ' + (at + 1) + ' is about'"
                   placeholder="What it's about (optional)"
                   [value]="track.brief" (input)="studio.editTrack(at, { brief: $any($event.target).value })" />
          }
          <div class="track-more">
            <input type="text" maxlength="80" autocomplete="off" class="lead" [attr.aria-label]="'Song ' + (at + 1) + ' lead'"
                   [placeholder]="leadPlaceholder(track)"
                   [value]="track.lead" (input)="studio.editTrack(at, { lead: $any($event.target).value })" />
            @if (studio.planTagMode() === 'per-song') {
              <input type="text" autocomplete="off" spellcheck="false" class="tags" [attr.aria-label]="'Song ' + (at + 1) + ' tags'"
                     placeholder="This song's tags, with commas: e.g. flamenco, nylon guitar"
                     [value]="track.tags" (input)="studio.editTrack(at, { tags: $any($event.target).value })" />
            }
          </div>
          <p class="hint">{{ said(track) }}</p>
          <div class="drop-slot" *cdkDragPlaceholder></div>
        </div>
      }
    </div>
    <button type="button" class="ghost small add" [disabled]="full()" (click)="add()"><app-icon name="plus" [size]="16" /> Add a song</button>

    <div class="saving">
      <span class="label">Templates</span>
      <div class="save-row">
        <select aria-label="Templates" (change)="picked.set($any($event.target).value)">
          <option value="" [selected]="picked() === ''">{{ studio.templates().length ? 'Pick a template' : 'No templates yet' }}</option>
          @for (template of studio.templates(); track template.name) {
            <option [value]="template.name" [selected]="picked() === template.name">{{ template.name }} ({{ template.tracks }} {{ template.tracks === 1 ? 'song' : 'songs' }})</option>
          }
        </select>
        <button type="button" class="ghost small" [disabled]="picked() === ''" (click)="load()">Load</button>
        <button type="button" class="ghost small" [disabled]="picked() === ''" (click)="deleteTemplate()">Delete</button>
      </div>
      <form class="save-row" (submit)="$event.preventDefault(); save(templateName.value)">
        <input #templateName type="text" maxlength="120" autocomplete="off" placeholder="Save this plan as…" aria-label="Template name" />
        <button type="submit" class="ghost small">Save template</button>
      </form>
      @if (saved(); as name) { <p class="hint">Saved as "{{ name }}".</p> }
      <p class="hint">A template keeps the plan with the album's description, tags, lead and Vocals, for every device. This plan is also kept on this device as you type, until you clear it.</p>
      <div><button type="button" class="ghost small" (click)="clear()">Clear the plan</button></div>
      @if (refusal(); as refused) { <app-refusal [refusal]="refused" /> }
    </div>
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 14px; }
    .label { font-size: 15px; }
    .field { display: flex; flex-direction: column; gap: 8px; }
    .count-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .count-row input { width: 90px; }
    .opt-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .hint.warn, .lyrics.over { color: var(--warn); }
    .lyrics.over { border-color: var(--warn); }
    .tracks { display: flex; flex-direction: column; gap: 12px; }
    .track {
      display: flex; flex-direction: column; gap: 8px; padding: 12px;
      border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--bg-base, #110f0e);
    }
    .track-head { display: flex; align-items: center; gap: 8px; }
    .track-head .title { flex: 1 1 auto; min-width: 0; }
    .grip { display: inline-flex; padding: 6px 2px; color: var(--text-tertiary); cursor: grab; touch-action: none; }
    .num { min-width: 22px; text-align: right; color: var(--text-secondary); }
    .track-tools { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .moves { display: flex; align-items: center; gap: 4px; }
    .up { transform: rotate(180deg); }
    .track-more { display: flex; gap: 8px; flex-wrap: wrap; }
    .track-more .lead { flex: 1 1 160px; min-width: 0; }
    .track-more .tags { flex: 2 1 220px; min-width: 0; }
    textarea { resize: vertical; font-family: var(--font-body); line-height: 1.45; min-height: 120px; }
    .link { align-self: flex-start; border: none; background: none; padding: 0; color: var(--accent); font-size: 13px; text-decoration: underline; }
    .add { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; }
    .saving { display: flex; flex-direction: column; gap: 8px; padding-top: 6px; border-top: 1px solid var(--border-subtle); }
    .save-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .save-row select, .save-row input { flex: 1 1 180px; min-width: 0; }
    .drop-slot { min-height: 60px; border: 1px dashed var(--border-default); border-radius: var(--radius-lg); }
    .cdk-drag-preview { box-shadow: 0 12px 30px rgba(0,0,0,.5); }
    .cdk-drag-animating, .tracks.cdk-drop-list-dragging .track:not(.cdk-drag-placeholder) { transition: transform 180ms cubic-bezier(0, 0, 0.2, 1); }
  `],
})
export class AlbumPlanComponent implements OnInit {
  protected readonly studio = inject(StudioService);
  private readonly confirm = inject(ConfirmService);
  /** The album's Vocals: the default for new tracks; a template loaded sets it. */
  readonly albumSung = model.required<boolean>();

  protected readonly maxTracks = PLAN_TRACKS_MAX;
  protected readonly lyricsMax = OWN_WORDS_MAX;
  /** Her words for the three (Victoria, 2026-10-12). */
  protected readonly tagModes: readonly { key: AlbumTagMode; label: string }[] = [
    { key: 'vibe', label: 'Keep the general vibe of the album tags' },
    { key: 'exact', label: 'Stick exactly to the tags' },
    { key: 'per-song', label: 'Set tags for each song' },
  ];
  protected readonly tagModeHint = computed(() => ({
    vibe: 'Each song varies on the album\'s tags: its own instruments, mood and tempo.',
    exact: 'Every song keeps exactly the album\'s tags; only a tempo is added when they set none.',
    'per-song': 'Each song has its own tags, kept exactly (only a tempo added when they set none). They start as the album\'s.',
  }[this.studio.planTagMode()]));
  protected readonly full = computed(() => this.studio.planTracks().length >= PLAN_TRACKS_MAX);
  protected readonly countWrong = signal<string | null>(null);
  protected readonly picked = signal('');
  protected readonly saved = signal<string | null>(null);
  protected readonly refusal = signal<RefusalView | null>(null);

  ngOnInit(): void {
    if (this.studio.planTracks().length === 0) this.studio.clearPlan(this.albumSung());
    void this.studio.listTemplates().then((refused) => this.refusal.set(refused));
  }

  /** What becomes of the track, said under it. */
  protected said(track: PlanTrackDraft): string {
    if (!track.sung) return track.brief.trim() !== '' ? 'Instrumental, its sound written to what it\'s about.' : 'Instrumental.';
    if (track.lyrics.trim() !== '') return 'Sung exactly as written: nothing is rewritten, shortened or cut.';
    if (track.brief.trim() !== '') return 'Its lyrics are written for you, about this.';
    return 'Left blank: its lyrics are written for you, to fit the album.';
  }

  /**
   * A track's Lead box, blank: what it gets instead (Victoria: "Album lead by default, changeable per
   * track. If no lead is selected ... keep B-Sides behavior as-is"). A singer leads no instrumental.
   */
  protected leadPlaceholder(track: PlanTrackDraft): string {
    const album = this.studio.lead().trim();
    const fits = album !== '' && leadFits(album, !track.sung);
    return fits ? `Lead: ${album} (the album's)` : track.sung ? 'Lead (optional): e.g. warm female voice' : 'Lead (optional): e.g. cello';
  }

  private hasContent(track: PlanTrackDraft): boolean {
    return track.title.trim() !== '' || track.lyrics.trim() !== '' || track.brief.trim() !== '';
  }

  /** Any whole number from 1 to 45 (Victoria: "I want to be able to fully control the number"). */
  protected async setCount(input: HTMLInputElement): Promise<void> {
    const wanted = Number(input.value);
    const tracks = this.studio.planTracks();
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > PLAN_TRACKS_MAX) {
      this.countWrong.set(`"${input.value}" is not a number of songs: pick a whole number from 1 to ${PLAN_TRACKS_MAX}.`);
      input.value = String(tracks.length);
      return;
    }
    this.countWrong.set(null);
    if (wanted > tracks.length) {
      this.studio.planTracks.set([...tracks, ...Array.from({ length: wanted - tracks.length }, () => this.studio.blankTrack(this.albumSung()))]);
      return;
    }
    const dropped = tracks.slice(wanted).filter((track) => this.hasContent(track)).length;
    if (dropped > 0) {
      const yes = await this.confirm.ask({
        title: `Remove the last ${tracks.length - wanted} songs?`,
        message: `${dropped} of them ${dropped === 1 ? 'has' : 'have'} words or a name, which go with ${dropped === 1 ? 'it' : 'them'}.`,
        confirm: 'Remove them',
        danger: true,
      });
      if (!yes) {
        input.value = String(tracks.length);
        return;
      }
    }
    this.studio.planTracks.set(tracks.slice(0, wanted));
  }

  protected add(): void {
    this.studio.planTracks.update((tracks) => [...tracks, this.studio.blankTrack(this.albumSung())]);
  }

  protected move(from: number, to: number): void {
    const tracks = [...this.studio.planTracks()];
    moveItemInArray(tracks, from, to);
    this.studio.planTracks.set(tracks);
  }

  protected dropped(event: CdkDragDrop<unknown>): void {
    if (event.previousIndex !== event.currentIndex) this.move(event.previousIndex, event.currentIndex);
  }

  /** A copy right after it, as a starting point (Victoria). */
  protected duplicate(at: number): void {
    this.studio.planTracks.update((tracks) => [...tracks.slice(0, at + 1), { ...(tracks[at] as PlanTrackDraft) }, ...tracks.slice(at + 1)]);
  }

  protected async remove(at: number): Promise<void> {
    const track = this.studio.planTracks()[at] as PlanTrackDraft;
    if (this.hasContent(track)) {
      const yes = await this.confirm.ask({ title: `Delete song ${at + 1}${track.title.trim() ? ` "${track.title.trim()}"` : ''}?`, message: 'Its words go with it.', confirm: 'Delete', danger: true });
      if (!yes) return;
    }
    this.studio.planTracks.update((tracks) => tracks.filter((_, i) => i !== at));
  }

  protected async clear(): Promise<void> {
    if (this.studio.planTracks().some((track) => this.hasContent(track))) {
      const yes = await this.confirm.ask({ title: 'Clear the plan?', message: 'Every song in it goes, on this device. Saved templates stay.', confirm: 'Clear', danger: true });
      if (!yes) return;
    }
    this.studio.clearPlan(this.albumSung());
    this.countWrong.set(null);
  }

  protected async save(name: string): Promise<void> {
    this.saved.set(null);
    const refused = await this.studio.saveTemplate(name, this.albumSung());
    this.refusal.set(refused);
    if (refused === null) {
      this.saved.set(name.replace(/\s+/g, ' ').trim());
      this.picked.set(name.replace(/\s+/g, ' ').trim());
    }
  }

  protected async load(): Promise<void> {
    const name = this.picked();
    if (this.studio.planTracks().some((track) => this.hasContent(track))) {
      const yes = await this.confirm.ask({ title: `Load "${name}"?`, message: 'It replaces the plan here, and the album\'s description, tags and lead.', confirm: 'Load', danger: false });
      if (!yes) return;
    }
    const loaded = await this.studio.loadTemplate(name);
    if ('code' in loaded) {
      this.refusal.set(loaded);
      return;
    }
    this.refusal.set(null);
    this.albumSung.set(loaded.sung);
  }

  protected async deleteTemplate(): Promise<void> {
    const name = this.picked();
    const yes = await this.confirm.ask({ title: `Delete the template "${name}"?`, message: 'It goes from every device. The plan here stays.', confirm: 'Delete', danger: true });
    if (!yes) return;
    this.refusal.set(await this.studio.deleteTemplate(name));
    this.picked.set('');
  }
}
