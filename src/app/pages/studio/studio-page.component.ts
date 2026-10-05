import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { MAX_BATCH } from '@shared/batch';
import { ALBUM_MINUTES, ENDED_PHASES, albumBytes, type HubPreferences, type Playlist, type RefusalView } from '@shared/types';

import { CrucibleSetupComponent } from '../../components/crucible-setup/crucible-setup.component';
import { PresetBarComponent } from '../../components/preset-bar/preset-bar.component';
import { CoverComponent } from '../../components/cover/cover.component';
import { IconComponent } from '../../components/icon/icon.component';
import { CloudService } from '../../core/cloud.service';
import { ConfirmService } from '../../core/confirm.service';
import { TagInputComponent } from '../../components/tag-input/tag-input.component';
import { bytesText } from '../../core/format';
import { desktop, HubService } from '../../core/hub.service';
import { JobsService } from '../../core/jobs.service';
import { PlayerService } from '../../core/player.service';
import { LibraryService } from '../../core/library.service';
import { StudioService } from '../../core/studio.service';

/**
 * Make: the song form, Night Deck. Describe it (a small model fills the tags),
 * or start from a preset; the tags fold away once picked; lyrics, or
 * instrumental; guidance and seed under Advanced; how many, and Make. What is
 * being made shows on Listen's playing list.
 *
 * Everything the form offers — the tag suggestions, the conflicts, the cfg
 * limits, whether this server's YuE2 takes `instrumental` — is the active
 * server's own `yue2-3b` playground page. With no server yet, the form is
 * replaced by the way to get one (app-crucible-setup).
 */
@Component({
  selector: 'app-studio-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, CrucibleSetupComponent, PresetBarComponent, TagInputComponent, IconComponent, CoverComponent],
  template: `
    <div class="page">
      <h1 class="page-title">Make</h1>
      <div class="modes" role="tablist" aria-label="What to make">
        <button type="button" role="tab" [attr.aria-selected]="mode() === 'songs'" [class.on]="mode() === 'songs'" (click)="mode.set('songs')">Songs</button>
        <button type="button" role="tab" [attr.aria-selected]="mode() === 'album'" [class.on]="mode() === 'album'" (click)="mode.set('album')">Album</button>
      </div>
      @if (hub.loaded() && hub.activeServer() === null) {
        <div class="card">
          <h2 class="card-title">Get a Crucible server</h2>
          <p class="detail">B-Side makes songs with YuE2 on a Crucible server{{ isDesktop ? ': install Crucible on this computer, or use one that already runs somewhere.' : ' that already runs somewhere.' }}</p>
          <app-crucible-setup [addByLine]="true" />
        </div>
      } @else {
        @if (studio.pageRefusal(); as refused) {
          <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
          <div><button type="button" class="ghost small" (click)="studio.reload()">Try again</button></div>
        }
        @if (studio.page(); as page) {
          @if (page.standing === 'download') {
            <div class="notice">{{ page.reason }}{{ downloadSize() }}. You can press Make now.</div>
          }
          @if (!page.available) {
            <div class="refusal"><code>not_ready</code><span>{{ page.reason }}</span></div>
          }
        } @else if (studio.loadingPage()) {
          <p class="hint">Reading the song page from {{ hub.activeServer()?.name }}…</p>
        }

        <form class="field" (submit)="$event.preventDefault(); studio.describe()">
          <label class="label" for="describe">Describe it</label>
          <textarea id="describe" rows="2" maxlength="600" class="describe"
                    placeholder="rainy 90s trip-hop, vinyl crackle, a little late-night jazz"
                    [value]="studio.description()" (input)="studio.description.set($any($event.target).value)"></textarea>
          <div class="describe-foot">
            <button type="submit" class="ghost small" [disabled]="studio.describing() || studio.description().trim() === ''">
              {{ studio.describing() ? 'Working…' : 'Fill in the tags' }}
            </button>
            <span class="hint">{{ studio.tagModel }} on the server picks the tags{{ studio.instrumental() ? '' : ' and writes the lyrics' }}; it swaps the song model out for a minute.</span>
          </div>
          @if (studio.describing()) {
            <div class="progress-line">
              <span>{{ studio.instrumental() ? 'Generating tags…' : 'Generating tags and lyrics…' }}</span>
              <span class="mono">{{ studio.describeElapsed() }}s</span>
            </div>
            <div class="bar indeterminate"><span></span></div>
          }
          @if (studio.described(); as said) {
            @if (studio.lyricsKept()) { <p class="hint">It wrote lyrics too, but your own are in the Lyrics box, so they stayed.</p> }
            @for (clash of said.clashes; track clash) { <div class="notice">{{ clash }}</div> }
          }
          @if (studio.describeRefusal(); as refused) {
            <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
          }
        </form>

        <app-preset-bar />

        <details class="fold" [open]="studio.tags().length === 0">
          <summary>
            <span class="fold-name">Tags</span>
            <span class="fold-sum">{{ studio.tags().length ? studio.tags().join(' · ') : 'none picked yet' }}</span>
            <app-icon name="down" [size]="18" class="chev" />
          </summary>
          <div class="fold-body"><app-tag-input /></div>
        </details>

        @if (mode() === 'album') {
          <div class="options">
            <div class="opt">
              <span class="opt-name">Length</span>
              <div class="opt-chips">
                @for (minutes of albumMinutes; track minutes) {
                  <button type="button" class="chip" [class.on]="albumLength() === minutes" (click)="albumLength.set(minutes)">{{ minutes }} min</button>
                }
              </div>
            </div>
            <div class="opt">
              <span class="opt-name">Vocals</span>
              <div class="opt-chips">
                <button type="button" class="chip" [class.on]="!albumSung()" (click)="albumSung.set(false)">Instrumental</button>
                <button type="button" class="chip" [class.on]="albumSung()" (click)="albumSung.set(true)">Sung</button>
              </div>
            </div>
            <p class="opt-note hint">The biggest chat model on {{ hub.activeServer()?.name }} writes the name, the artist and every track{{ albumSung() ? '; ' + studio.tagModel + ' writes the lyrics, a song per two minutes so ' + albumLength() + ' minutes is always filled' : '' }}; its image model paints the cover. All of that is done first, so the album comes out right; then the music is made, track by track, and fills in while you listen.</p>
          </div>
          @if (spaceFull()) {
            <div class="room-card">
              <span class="kicker amber">Album space is full</span>
              <span class="room-title">Make room for the next album</span>
              <p class="detail">Albums on this phone take {{ gb(spaceUsed()) }} of {{ spaceLimitGb() }} GB. {{ cloud.linked() ? 'Save some to your cloud on ' + cloud.host() + ' (they stay playable, streamed)' : 'Link a B-Side computer as your cloud in Settings to keep more, or delete one' }}, then make the next. Settings changes the limit.</p>
              @if (cloud.saving(); as saving) { <p class="hint">Saving to the cloud: {{ saving.done }} of {{ saving.of }}…</p> }
              <div class="bar room-bar"><span [style.width.%]="Math.min(100, spaceUsed() / (spaceLimitGb() * 1e9) * 100)"></span></div>
              @for (row of albumsBySize(); track row.playlist.id) {
                <div class="room-row">
                  <app-cover class="room-art" [key]="row.playlist.id" [src]="hub.coverUrl(row.playlist)" />
                  <span class="room-names"><span class="room-name">{{ row.playlist.name }}</span><span class="hint">{{ row.playlist.album?.artist }}</span></span>
                  <span class="mono hint">{{ gb(row.bytes) }}</span>
                  @if (cloud.linked()) {
                    <button type="button" class="icon-btn cloud-btn" [attr.aria-label]="'Save ' + row.playlist.name + ' to the cloud'" [disabled]="cloud.saving() !== null" (click)="saveToCloud(row.playlist)"><app-icon name="cloud" [size]="18" /></button>
                  }
                  <button type="button" class="icon-btn" [attr.aria-label]="'Delete ' + row.playlist.name" (click)="deleteAlbum(row.playlist)"><app-icon name="trash" [size]="18" /></button>
                </div>
              }
            </div>
          } @else {
            <button type="button" class="make" [disabled]="albumSending() || hub.activeServer() === null" (click)="makeAlbum()">
              {{ albumSending() ? 'Starting…' : 'Make the album' }}
            </button>
          }
          @if (albumRefusal(); as refused) {
            <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
          }
        } @else {
        @if (studio.page()?.instrumental !== false) {
          <label class="switch" title="YuE2 writes the melody, then plays it on an instrument instead of singing it">
            <input type="checkbox" [checked]="studio.instrumental()" (change)="studio.instrumental.set($any($event.target).checked)" />
            Instrumental (no vocals)
          </label>
        }
        @if (!studio.instrumental()) {
          <div class="field">
            <label class="label" for="lyrics">Lyrics</label>
            <textarea id="lyrics" rows="10" spellcheck="true"
                      [placeholder]="lyricsPlaceholder()"
                      [value]="studio.lyrics()"
                      (input)="studio.lyrics.set($any($event.target).value)"></textarea>
            @if (studio.page()?.lyricsHint; as hint) { <p class="hint">{{ hint }}</p> }
          </div>
        }

        <details class="fold">
          <summary>
            <span class="fold-name">Advanced</span>
            <span class="fold-sum">guidance {{ studio.cfg() || 'default' }} · seed {{ studio.seed() || 'random' }}</span>
            <app-icon name="down" [size]="18" class="chev" />
          </summary>
          <div class="fold-body numbers">
            <label class="field">
              <span class="label">Guidance (cfg)</span>
              <input type="number" inputmode="decimal"
                     [min]="studio.page()?.cfg?.min ?? 0" [max]="studio.page()?.cfg?.max ?? null" [step]="studio.page()?.cfg?.step ?? 0.1"
                     [value]="studio.cfg()" (input)="studio.cfg.set($any($event.target).value)" />
              @if (studio.page()?.cfg?.max; as max) { <span class="hint">up to {{ max }}; above 1 follows the tags and lyrics harder</span> }
            </label>
            <label class="field">
              <span class="label">Seed</span>
              <input type="number" inputmode="numeric" min="0" step="1" placeholder="random"
                     [value]="studio.seed()" (input)="studio.seed.set($any($event.target).value)" />
              <span class="hint">{{ studio.page()?.seed?.hint ?? 'leave it blank for a new one each time' }}</span>
            </label>
          </div>
        </details>

        <div class="go">
          <div class="count" role="group" aria-label="How many in a row">
            <button type="button" class="icon-btn" aria-label="One fewer" [disabled]="studio.count() <= 1" (click)="studio.count.set(studio.count() - 1)">–</button>
            <span class="mono">{{ studio.count() }}×</span>
            <button type="button" class="icon-btn" aria-label="One more" [disabled]="studio.count() >= maxBatch" (click)="studio.count.set(studio.count() + 1)">+</button>
          </div>
          <button type="button" class="make" [disabled]="studio.sending() || hub.activeServer() === null" (click)="studio.generate()">
            {{ studio.count() > 1 ? 'Make ' + studio.count() + ' songs' : 'Make the song' }}
          </button>
        </div>
        @if (studio.tags().length === 0 && studio.description().trim() !== '') {
          <p class="hint center">No tags picked: the description goes straight to the song model as its style, for speed.</p>
        }
        @if (studio.count() > 1 && studio.seed().trim() !== '') {
          <p class="hint center">Seeds {{ studio.seed() }}, {{ +studio.seed() + 1 }}, …</p>
        }
        @if (studio.generateRefusal(); as refused) {
          <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
        }
        @if (jobs.generating()) {
          <a class="making" routerLink="/"><span class="kicker">Making now</span><span>{{ makingCount() }} on the playing list</span><app-icon name="chevron" [size]="16" /></a>
        }
        }
      }
    </div>
  `,
  styles: [`
    .modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; padding: 4px; background: var(--bg-elevated); border-radius: var(--radius-lg); }
    .modes button { height: 40px; border: none; border-radius: 10px; background: transparent; color: var(--text-secondary); font-size: 14px; font-weight: 600; }
    .modes button.on { background: var(--text-primary); color: var(--bg-base); }
    .options { display: flex; flex-direction: column; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); }
    .opt { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--border-subtle); flex-wrap: wrap; }
    .opt-name { font-size: 15px; }
    .opt-chips { display: flex; gap: 6px; flex-wrap: wrap; }
    .opt-note { padding: 12px 14px; }
    .room-card { display: flex; flex-direction: column; gap: 12px; padding: 18px; border: 1px solid #5a4126; border-radius: 16px; background: #1d1711; }
    .room-title { font-family: var(--font-display); font-size: 28px; font-weight: 800; line-height: 1; }
    .room-bar > span { background: var(--audio); }
    .room-row { display: flex; align-items: center; gap: 12px; padding: 6px 0; border-top: 1px solid var(--border-subtle); }
    .room-art { width: 48px; }
    .room-names { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .room-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .room-row .icon-btn { color: var(--audio); }
    .room-row .icon-btn.cloud-btn { color: var(--accent); }
    .kicker.amber { color: var(--audio); }
    .page { max-width: 720px; margin: 0 auto; padding: 18px 20px 32px; display: flex; flex-direction: column; gap: 22px; }
    .field { display: flex; flex-direction: column; gap: 8px; }
    textarea { resize: vertical; font-family: var(--font-body); line-height: 1.45; }
    .describe { font-size: 18px; padding: 14px; border-radius: var(--radius-lg); min-height: 78px; }
    .describe-foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .progress-line { display: flex; justify-content: space-between; gap: 12px; margin: 10px 0 6px; font-size: 13px; }
    #lyrics { min-height: 160px; border-radius: var(--radius-lg); padding: 12px 14px; }
    .fold { border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: #171412; }
    .fold summary { display: flex; align-items: center; gap: 10px; padding: 14px; cursor: pointer; list-style: none; }
    .fold summary::-webkit-details-marker { display: none; }
    .fold-name { font-size: 15px; font-weight: 600; }
    .fold-sum { flex: 1; min-width: 0; font-size: 13px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .chev { color: var(--text-tertiary); transition: transform 150ms ease; }
    .fold[open] .chev { transform: rotate(180deg); }
    .fold-body { padding: 0 14px 14px; }
    .numbers { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
    .go { display: flex; align-items: center; gap: 12px; }
    .count { display: flex; align-items: center; gap: 2px; border: 1px solid var(--border-default); border-radius: 999px; padding: 2px; }
    .count .icon-btn { width: 40px; height: 40px; font-size: 20px; }
    .count .mono { min-width: 30px; text-align: center; font-size: 14px; }
    .make {
      flex: 1; height: 58px; border: none; border-radius: var(--radius-lg);
      background: var(--accent); color: var(--text-inverse); box-shadow: 0 0 34px rgba(34, 211, 238, 0.35);
      font-family: var(--font-display); font-size: 24px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
    }
    .make:hover:not(:disabled) { background: var(--accent-hover); }
    .make:disabled { opacity: 0.5; box-shadow: none; }
    .center { text-align: center; }
    .making {
      display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: var(--radius-lg);
      border: 1px solid #5a4126; background: #1d1711; color: var(--text-primary); text-decoration: none; font-size: 14px;
    }
    .making .kicker { color: var(--audio); }
    .making span:nth-child(2) { flex: 1; }
    @media (min-width: 960px) { .page { padding: 32px 40px; } }
  `],
})
export class StudioPageComponent {
  protected readonly studio = inject(StudioService);
  protected readonly hub = inject(HubService);
  protected readonly isDesktop = desktop !== null;
  protected readonly library = inject(LibraryService);
  protected readonly jobs = inject(JobsService);
  private readonly router = inject(Router);
  private readonly player = inject(PlayerService);
  protected readonly mode = signal<'songs' | 'album'>('songs');
  protected readonly albumMinutes = ALBUM_MINUTES;
  protected readonly albumLength = signal(60);
  protected readonly albumSung = signal(false);
  protected readonly albumSending = signal(false);
  protected readonly albumRefusal = signal<RefusalView | null>(null);

  private readonly confirm = inject(ConfirmService);
  protected readonly Math = Math;
  private readonly preferences = signal<HubPreferences | null>(null);
  protected readonly spaceLimitGb = computed(() => this.preferences()?.albumSpaceGb ?? 2);
  /** Albums kept only on this phone, biggest first (the phone's own hub; nothing on a computer). */
  protected readonly albumsBySize = computed(() => {
    if (!this.hub.onPhone()) return [];
    const songs = this.library.songs();
    return this.library.playlists()
      .filter((playlist) => playlist.album !== undefined && playlist.album.cloud == null)
      .map((playlist) => ({ playlist, bytes: albumBytes(playlist, songs) }))
      .sort((a, b) => b.bytes - a.bytes);
  });
  protected readonly spaceUsed = computed(() => this.albumsBySize().reduce((sum, row) => sum + row.bytes, 0));
  protected readonly spaceFull = computed(() => this.hub.onPhone() && this.spaceUsed() >= this.spaceLimitGb() * 1e9 * 0.95);

  constructor() {
    void this.hub.call<HubPreferences>('GET', '/api/preferences').then((outcome) => {
      if (outcome.ok) this.preferences.set(outcome.value);
    });
  }

  protected gb(bytes: number): string {
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
  }

  protected readonly cloud = inject(CloudService);

  protected async saveToCloud(playlist: Playlist): Promise<void> {
    this.albumRefusal.set(await this.cloud.saveAlbum(playlist, this.library.songsOf(playlist)));
  }

  protected async deleteAlbum(playlist: Playlist): Promise<void> {
    const yes = await this.confirm.ask({
      title: `Delete the album "${playlist.name}"?`,
      message: 'Its songs are deleted from this phone. This cannot be undone.',
      confirm: 'Delete album',
      danger: true,
    });
    if (!yes) return;
    this.albumRefusal.set(await this.library.deletePlaylist(playlist.id));
  }

  /** Start an album and open its page, where it fills in. */
  protected async makeAlbum(): Promise<void> {
    this.albumSending.set(true);
    const outcome = await this.hub.call<{ id: string }>('POST', '/api/albums', {
      description: this.studio.description(),
      tags: this.studio.tags(),
      minutes: this.albumLength(),
      sung: this.albumSung(),
      cfg: this.studio.cfg().trim() === '' ? null : Number(this.studio.cfg()),
    });
    this.albumSending.set(false);
    this.albumRefusal.set(outcome.ok ? null : outcome.refusal);
    if (outcome.ok) {
      this.player.playWhenReady(outcome.value.id);
      void this.router.navigate(['/library', outcome.value.id]);
    }
  }

  protected readonly makingCount = computed(() => this.jobs.jobs().filter((job) => !ENDED_PHASES.includes(job.phase)).length);
  protected readonly maxBatch = MAX_BATCH;

  protected readonly lyricsPlaceholder = computed(() =>
    this.studio.instrumental()
      ? 'Instrumental: nothing is sung. Turn Instrumental off to sing lyrics.'
      : (this.studio.page()?.lyricsPlaceholder ?? '[Verse]\n...\n\n[Chorus]\n...'),
  );

  protected readonly downloadSize = computed(() => {
    const size = bytesText(this.studio.page()?.downloadBytes ?? null);
    return size === null ? '' : ` (${size})`;
  });
}
