import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { MAX_BATCH } from '@shared/batch';
import { ALBUM_MINUTES, albumBytes, DESCRIPTION_MAX, ENDED_PHASES, LENGTH_AIMS, SINGLES_NAME, type HubPreferences, type Playlist, type RefusalView } from '@shared/types';
import { styleLine, undeclaredLanguage } from '@shared/tags';

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
import { RefusalComponent } from '../../components/refusal/refusal.component';

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
  imports: [RefusalComponent, DecimalPipe, RouterLink, CrucibleSetupComponent, PresetBarComponent, TagInputComponent, IconComponent, CoverComponent],
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
          <p class="detail">B-Sides makes songs with YuE2 on a Crucible server{{ isDesktop ? ': install Crucible on this computer, or use one that already runs somewhere.' : ' that already runs somewhere.' }}</p>
          <app-crucible-setup [addByLine]="true" />
        </div>
      } @else {
        @if (studio.pageRefusal(); as refused) {
          <app-refusal [refusal]="refused" />
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

        <form class="field" (submit)="$event.preventDefault(); fillTags()">
          <label class="label" for="describe">Describe it</label>
          <textarea id="describe" rows="2" class="describe" [class.over]="studio.description().length > descriptionMax"
                    placeholder="rainy 90s trip-hop, vinyl crackle, a little late-night jazz"
                    [value]="studio.description()" (input)="studio.description.set($any($event.target).value)"></textarea>
          @if (studio.description().length > descriptionMax * 0.8) {
            <!-- Counted, and too long said, never cut (Victoria, 2026-10-11). -->
            <p class="hint" [class.warn]="studio.description().length > descriptionMax">{{ studio.description().length }} / {{ descriptionMax }}{{ studio.description().length > descriptionMax ? ': too long. Shorten it before you make it; nothing is cut.' : '' }}</p>
          }
          <div class="describe-foot">
            <button type="submit" class="ghost small" [disabled]="studio.describing() || studio.description().trim() === ''">
              {{ studio.describing() ? 'Working…' : 'Fill in the tags' }}
            </button>
            <span class="hint">@if (studio.page()?.writer; as writer) {{{ writer }} (Claude Code on this computer) picks the tags{{ instrumentalHere() ? ', no singer: it is instrumental' : (mode() === 'album' ? '' : ' and writes the lyrics') }}; the server only makes the music.} @else if (studio.tagModel(); as model) {{{ model }} on the server picks the tags{{ instrumentalHere() ? ', no singer: it is instrumental' : (mode() === 'album' || studio.page()?.lyricist ? '' : ' and writes the lyrics') }}; it swaps the song model out for a minute.@if (studio.page()?.lyricist; as lyricist) {@if (!instrumentalHere()) { {{ lyricist }} (Claude Code on this computer) writes the lyrics.}}} @else {{{ studio.page()?.tagModelReason ?? 'Reading which tag model this server has…' }}}</span>
          </div>
          @if (studio.describing()) {
            <div class="progress-line">
              <span>{{ instrumentalHere() || mode() === 'album' ? 'Generating tags…' : 'Generating tags and lyrics…' }}</span>
              <span class="mono">{{ studio.describeElapsed() }}s</span>
            </div>
            <div class="bar indeterminate"><span></span></div>
          }
          @if (studio.described(); as said) {
            <p class="hint filled">Filled in {{ said.tags.length }} tags{{ said.lyrics && mode() !== 'album' ? ' and the lyrics' : '' }} in {{ said.seconds | number: '1.0-0' }}s{{ mode() === 'album' ? '; the album uses them as its sound' : '' }}. They are below; change any you like.</p>
            @if (mode() !== 'album' && studio.songTitle(); as named) { <p class="hint">It's called <strong>{{ named }}</strong>.</p> }
            @if (studio.lyricsKept()) { <p class="hint">It wrote lyrics too, but your own are in the Lyrics box, so they stayed.</p> }
            @for (clash of said.clashes; track clash) { <div class="notice">{{ clash }}</div> }
          }
          @if (studio.describeRefusal(); as refused) {
            <app-refusal [refusal]="refused" />
          }
        </form>

        <app-preset-bar />

        <!-- Open while empty, and right after the tag model fills it, so the fill is seen (it folded shut before). -->
        <details class="fold" [open]="studio.tags().length === 0 || studio.described() !== null">
          <summary>
            <span class="fold-name">Tags</span>
            <span class="fold-sum">{{ studio.tags().length ? studio.tags().join(' · ') : 'none picked yet' }}</span>
            <app-icon name="down" [size]="18" class="chev" />
          </summary>
          <div class="fold-body">
            <app-tag-input />
            @if (offLanguage(); as language) {
              <p class="hint">YuE2 sings English and Chinese only; "{{ language }}" is sent as you typed it, but it is not a language YuE2 supports.</p>
            }
            @if (sentAs(); as sent) {
              <!-- Said, never done silently (crucible-pc-1, 2026-10-10): what YuE2's form changes in the person's tags. -->
              <p class="hint">Sent in YuE2's own form{{ mode() === 'album' ? ', for every track' : '' }}: {{ sent }}</p>
            }
          </div>
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
            @if (hub.servers().length > 1) {
              <div class="opt">
                <span class="opt-name">Made on</span>
                <div class="opt-chips">
                  @for (server of hub.servers(); track server.name) {
                    <button type="button" class="chip" [class.on]="albumServer() === server.name" (click)="pickedServer.set(server.name)">{{ server.name }}</button>
                  }
                </div>
              </div>
            }
            <div class="opt">
              <span class="opt-name">Tags</span>
              <div class="opt-chips">
                <button type="button" class="chip" [class.on]="!albumExact()" (click)="albumExact.set(false)" title="Each track varies on the tags: its own voice, instruments, a touch of another style">General vibe</button>
                <button type="button" class="chip" [class.on]="albumExact()" (click)="albumExact.set(true)" title="Every track keeps exactly the album's tags; none adds a voice, instrument or genre">Stick to my tags</button>
              </div>
            </div>
            @if (studio.page()?.length) {
              <div class="opt">
              <span class="opt-name">Song length</span>
              <div class="opt-chips">
                <button type="button" class="chip" [class.on]="studio.lengthAim() === ''" (click)="studio.lengthAim.set('')">Any</button>
                @for (aim of lengthAims; track aim.key) {
                  <button type="button" class="chip" [class.on]="studio.lengthAim() === aim.key" (click)="studio.lengthAim.set(aim.key)">{{ aim.label }}</button>
                }
              </div>
            </div>
              @if (studio.lengthAim() !== '') {
                <p class="opt-note hint">An aim, not a promise: instrumentals are sized toward it and most land in it; a sung track runs as long as its lyrics. Longer songs fill the album's length with fewer tracks.</p>
              }
            }
            <div class="opt">
              <span class="opt-name">Vocals</span>
              <div class="opt-chips">
                <button type="button" class="chip" [class.on]="!albumSung()" (click)="albumSung.set(false)">Instrumental</button>
                <button type="button" class="chip" [class.on]="albumSung()" (click)="albumSung.set(true)">Sung</button>
              </div>
            </div>
            @if (albumSung()) {
              <div class="field">
                <label class="label" for="album-lyrics">What the lyrics are about</label>
                <textarea id="album-lyrics" rows="2" maxlength="400" spellcheck="true"
                          placeholder="their mood, style or story: late-night regrets, wry and tender, told by a bartender"
                          [value]="studio.lyricsBrief()" (input)="studio.lyricsBrief.set($any($event.target).value)"></textarea>
                <p class="hint">Every track's lyrics are written to this, and the titles fit it. Blank: the album's description leads.</p>
              </div>
            }
            <p class="opt-note hint">{{ studio.tagModel() ?? "This server's model" }} writes it all: the name, the artist and every track{{ albumSung() ? ', then the lyrics, a song per two minutes so ' + albumLength() + ' minutes is always filled' : '' }}; the server's image model, when it has one, paints the cover (without one, the album gets the standard cover). All of that is done first, so the album comes out right; then the music is made, track by track, and fills in while you listen.</p>
          </div>
          @if (spaceFull()) {
            <div class="room-card">
              <span class="kicker amber">Album space is full</span>
              <span class="room-title">Make room for the next album</span>
              <p class="detail">Albums on this phone take {{ gb(spaceUsed()) }} of {{ spaceLimitGb() }} GB. {{ cloud.linked() ? 'Save some to your cloud on ' + cloud.host() + ' (they stay playable, streamed)' : 'Link a B-Sides computer as your cloud in Settings to keep more, or delete one' }}, then make the next. Settings changes the limit.</p>
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
            <app-refusal [refusal]="refused" />
          }
        } @else {
        @if (studio.page()?.instrumental !== false) {
          <label class="switch" title="YuE2 writes the melody, then plays it on an instrument instead of singing it">
            <input type="checkbox" [checked]="studio.instrumental()" (change)="studio.instrumental.set($any($event.target).checked)" />
            Instrumental (no vocals)
          </label>
        }
        @if (studio.page()?.length) {
          <div class="options">
            <div class="opt">
              <span class="opt-name">Song length</span>
              <div class="opt-chips">
                <button type="button" class="chip" [class.on]="studio.lengthAim() === ''" (click)="studio.lengthAim.set('')">Any</button>
                @for (aim of lengthAims; track aim.key) {
                  <button type="button" class="chip" [class.on]="studio.lengthAim() === aim.key" (click)="studio.lengthAim.set(aim.key)">{{ aim.label }}</button>
                }
              </div>
            </div>
          </div>
          @if (studio.lengthAim() !== '') {
            <p class="hint">{{ studio.instrumental() ? 'An aim, not a promise: the server sizes the song toward it, and most land in it.' : 'A sung song runs as long as its lyrics; the aim is noted with it, and the lyrics are never cut to fit.' }}</p>
          }
        }
        @if (!studio.instrumental()) {
          <div class="field">
            <label class="label" for="lyrics-brief">What the lyrics are about</label>
            <textarea id="lyrics-brief" rows="2" maxlength="400" spellcheck="true"
                      placeholder="a banana going brown on the windowsill; bittersweet, a little funny"
                      [value]="studio.lyricsBrief()" (input)="studio.lyricsBrief.set($any($event.target).value)"></textarea>
            <p class="hint">Fill in the tags writes the lyrics to this. With the Lyrics box empty, Make writes them first.</p>
          </div>
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
          <app-refusal [refusal]="refused" />
        }
        @if (jobs.generating()) {
          <a class="making" [routerLink]="makingIn() ? ['/library', makingIn()] : '/'"><span class="kicker">Making now</span><span>{{ makingCount() }} in {{ makingIn() ? singlesName : 'the playing list' }}</span><app-icon name="chevron" [size]="16" /></a>
        }
        }
      }
    </div>
  `,
  styles: [`
    .modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; padding: 4px; background: var(--bg-elevated); border-radius: var(--radius-lg); }
    .hint.warn, .describe.over { color: var(--warn); }
    .describe.over { border-color: var(--warn); }
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
  protected readonly lengthAims = LENGTH_AIMS;
  protected readonly descriptionMax = DESCRIPTION_MAX;
  /** A sung song's language when it is not English or Chinese, the two YuE2 sings (Owen, 2026-10-11): said, not changed. */
  protected readonly offLanguage = computed(() => (this.instrumentalHere() ? null : undeclaredLanguage(this.studio.tagLine())));
  /** The tags as they are sent (YuE2's official form), when that differs from what is picked. */
  protected readonly sentAs = computed(() => {
    const picked = this.studio.tagLine();
    if (picked === '') return null;
    const sent = styleLine(picked, this.instrumentalHere());
    return sent === picked ? null : sent;
  });
  protected readonly albumLength = signal(60);
  protected readonly albumSung = signal(false);
  protected readonly albumExact = signal(false);
  /** The server the album is made on; the active one until another is picked. */
  protected readonly pickedServer = signal<string | null>(null);
  protected readonly albumServer = computed(() => {
    const picked = this.pickedServer();
    const servers = this.hub.servers();
    return picked !== null && servers.some((server) => server.name === picked) ? picked : (this.hub.activeServer()?.name ?? null);
  });
  /** Instrumental where the person is: the album's Vocals choice, or the song's switch. */
  protected readonly instrumentalHere = computed(() => (this.mode() === 'album' ? !this.albumSung() : this.studio.instrumental()));

  /** Fill in the tags for what is being made: an instrumental gets no lyrics and no singer. */
  protected fillTags(): void {
    void this.studio.describe(this.instrumentalHere(), this.mode() === 'album');
  }
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
    // Opened to make an album again: its settings, ready to change (the form fields are the studio's).
    const remake = this.studio.remake();
    if (remake !== null) {
      this.studio.remake.set(null);
      this.mode.set('album');
      this.albumLength.set(ALBUM_MINUTES.includes(remake.ask.minutes) ? remake.ask.minutes : 60);
      this.albumSung.set(remake.ask.sung);
      this.albumExact.set(remake.ask.exactTags === true);
      this.pickedServer.set(remake.server);
    }
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
      lyrics: this.albumSung() ? this.studio.lyricsBrief().trim() : '',
      cfg: this.studio.cfg().trim() === '' ? null : Number(this.studio.cfg()),
      exactTags: this.albumExact(),
      ...(this.studio.lengthAim() !== '' && this.studio.page()?.length ? { trackLength: this.studio.lengthAim() } : {}),
      server: this.albumServer() ?? '',
    });
    this.albumSending.set(false);
    this.albumRefusal.set(outcome.ok ? null : outcome.refusal);
    if (outcome.ok) {
      this.player.playWhenReady(outcome.value.id);
      void this.router.navigate(['/library', outcome.value.id]);
    }
  }

  protected readonly makingCount = computed(() => this.jobs.jobs().filter((job) => !ENDED_PHASES.includes(job.phase)).length);
  /** The playlist the songs being made land in (New Songs), when they have one. */
  protected readonly makingIn = computed(() => this.jobs.jobs().find((job) => !ENDED_PHASES.includes(job.phase) && job.playlist != null)?.playlist ?? null);
  protected readonly singlesName = SINGLES_NAME;
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
