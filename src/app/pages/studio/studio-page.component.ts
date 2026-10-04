import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { MAX_BATCH } from '@shared/batch';
import { ENDED_PHASES } from '@shared/types';

import { CrucibleSetupComponent } from '../../components/crucible-setup/crucible-setup.component';
import { PresetBarComponent } from '../../components/preset-bar/preset-bar.component';
import { IconComponent } from '../../components/icon/icon.component';
import { TagInputComponent } from '../../components/tag-input/tag-input.component';
import { bytesText } from '../../core/format';
import { desktop, HubService } from '../../core/hub.service';
import { JobsService } from '../../core/jobs.service';
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
  imports: [RouterLink, CrucibleSetupComponent, PresetBarComponent, TagInputComponent, IconComponent],
  template: `
    <div class="page">
      <h1 class="page-title">Make</h1>
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
              {{ studio.describing() ? 'Writing tags…' : 'Fill in the tags' }}
            </button>
            <span class="hint">{{ studio.tagModel }} on the server picks the tags; it swaps the song model out for a minute.</span>
          </div>
          @if (studio.described(); as said) {
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
    </div>
  `,
  styles: [`
    .page { max-width: 720px; margin: 0 auto; padding: 18px 20px 32px; display: flex; flex-direction: column; gap: 22px; }
    .field { display: flex; flex-direction: column; gap: 8px; }
    textarea { resize: vertical; font-family: var(--font-body); line-height: 1.45; }
    .describe { font-size: 18px; padding: 14px; border-radius: var(--radius-lg); min-height: 78px; }
    .describe-foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
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
