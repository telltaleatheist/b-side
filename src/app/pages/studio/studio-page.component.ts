import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { MAX_BATCH } from '@shared/batch';

import { PresetBarComponent } from '../../components/preset-bar/preset-bar.component';
import { QueuePanelComponent } from '../../components/queue-panel/queue-panel.component';
import { TagInputComponent } from '../../components/tag-input/tag-input.component';
import { bytesText } from '../../core/format';
import { HubService } from '../../core/hub.service';
import { StudioService } from '../../core/studio.service';

/**
 * The studio: the song form on the left (presets, style tags, lyrics,
 * instrumental, guidance, seed, how many in a row), the queue on the right.
 * Everything the form offers — the tag suggestions, the conflicts, the cfg
 * limits, whether this server's YuE2 takes `instrumental` — is the active
 * server's own `yue2-3b` playground page.
 */
@Component({
  selector: 'app-studio-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, PresetBarComponent, TagInputComponent, QueuePanelComponent],
  template: `
    <div class="studio">
      <section class="form">
        @if (hub.loaded() && hub.activeServer() === null) {
          <div class="card empty">
            <h2 class="card-title">Connect a Crucible server</h2>
            <p class="detail">B-Side makes songs with YuE2 on a Crucible server. Paste the server's pairing line in Settings.</p>
            <div><a class="primary" routerLink="/settings">Open Settings</a></div>
          </div>
        } @else {
          @if (studio.pageRefusal(); as refused) {
            <div class="refusal">
              <code>{{ refused.code }}</code><span>{{ refused.message }}</span>
            </div>
            <div><button type="button" class="ghost small" (click)="studio.reload()">Try again</button></div>
          }
          @if (studio.page(); as page) {
            @if (page.standing === 'download') {
              <div class="notice">
                {{ page.reason }}{{ downloadSize() }}. You can press Generate now.
              </div>
            }
            @if (!page.available) {
              <div class="refusal"><code>not_ready</code><span>{{ page.reason }}</span></div>
            }
          } @else if (studio.loadingPage()) {
            <p class="hint">Reading the song page from {{ hub.activeServer()?.name }}…</p>
          }

          <app-preset-bar />
          <form class="field describe" (submit)="$event.preventDefault(); studio.describe()">
            <label class="label" for="describe">Describe the music</label>
            <div class="describe-row">
              <input id="describe" type="text" maxlength="600" autocomplete="off"
                     placeholder="e.g. in the style of the DOS game One Must Fall 2097 — or — smooth lo-fi with jazz sax"
                     [value]="studio.description()" (input)="studio.description.set($any($event.target).value)" />
              <button type="submit" class="ghost" [disabled]="studio.describing() || studio.description().trim() === ''">
                {{ studio.describing() ? 'Writing tags…' : 'Fill in the tags' }}
              </button>
            </div>
            <p class="hint">A small model ({{ studio.tagModel }}) on the server writes the style tags (and turns on Instrumental when you describe music without singing). It replaces the tags below. The server holds one model at a time, so this swaps the song model out; the next song loads it again.</p>
            @if (studio.described(); as said) {
              <p class="hint">Written in {{ said.seconds.toFixed(1) }} s.</p>
              @for (clash of said.clashes; track clash) { <div class="notice">{{ clash }}</div> }
            }
            @if (studio.describeRefusal(); as refused) {
              <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
            }
          </form>
          <app-tag-input />

          <div class="field">
            <label class="label" for="lyrics">Lyrics</label>
            <textarea id="lyrics" rows="12" spellcheck="true"
                      [disabled]="studio.instrumental()"
                      [placeholder]="lyricsPlaceholder()"
                      [value]="studio.lyrics()"
                      (input)="studio.lyrics.set($any($event.target).value)"></textarea>
            @if (studio.page()?.lyricsHint; as hint) { <p class="hint">{{ hint }}</p> }
          </div>

          <div class="row">
            @if (studio.page()?.instrumental !== false) {
              <label class="switch" title="YuE2 writes the melody, then plays it on an instrument instead of singing it">
                <input type="checkbox" [checked]="studio.instrumental()" (change)="studio.instrumental.set($any($event.target).checked)" />
                Instrumental (no vocals)
              </label>
            }
          </div>

          <div class="row numbers">
            <label class="field narrow">
              <span class="label">Guidance (cfg)</span>
              <input type="number" inputmode="decimal"
                     [min]="studio.page()?.cfg?.min ?? 0" [max]="studio.page()?.cfg?.max ?? null" [step]="studio.page()?.cfg?.step ?? 0.1"
                     [value]="studio.cfg()" (input)="studio.cfg.set($any($event.target).value)" />
              @if (studio.page()?.cfg?.max; as max) { <span class="hint">up to {{ max }}; above 1 follows the tags and lyrics harder</span> }
            </label>
            <label class="field narrow">
              <span class="label">Seed</span>
              <input type="number" inputmode="numeric" min="0" step="1" placeholder="random"
                     [value]="studio.seed()" (input)="studio.seed.set($any($event.target).value)" />
              <span class="hint">{{ studio.page()?.seed?.hint ?? 'leave it blank for a new one each time' }}</span>
            </label>
          </div>

          <div class="row go">
            <button type="button" class="primary generate" [disabled]="studio.sending() || hub.activeServer() === null" (click)="studio.generate()">
              Generate
            </button>
            <label class="count">
              <input type="number" min="1" [max]="maxBatch" step="1" inputmode="numeric"
                     [value]="studio.count()" (input)="studio.count.set(+$any($event.target).value)" />
              <span>in a row</span>
            </label>
            @if (studio.count() > 1 && studio.seed().trim() !== '') {
              <span class="hint">seeds {{ studio.seed() }}, {{ +studio.seed() + 1 }}, …</span>
            }
          </div>
          @if (studio.generateRefusal(); as refused) {
            <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
          }
          <p class="hint">
            Each song is saved to your library as soon as it finishes. A refusal from the server shows on its row in the queue.
          </p>
        }
      </section>
      <app-queue-panel />
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .studio { display: grid; grid-template-columns: minmax(0, 1fr) 380px; height: 100%; }
    .form {
      overflow-y: auto; min-height: 0;
      padding: 16px 22px 28px;
      display: flex; flex-direction: column; gap: 14px;
    }
    .form > * { max-width: 920px; width: 100%; }
    .empty { margin-top: 20px; }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .describe-row { display: flex; gap: 8px; }
    .describe-row input { flex: 1; min-width: 0; }
    textarea { resize: vertical; min-height: 140px; font-family: var(--font-body); line-height: 1.5; }
    textarea:disabled { opacity: 0.55; }
    .row { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
    .numbers .narrow { width: 220px; }
    .go { align-items: center; }
    .generate { height: 34px; padding: 0 22px; font-size: 13px; }
    .count { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); }
    .count input { width: 64px; }
    @media (max-width: 1100px) { .studio { grid-template-columns: minmax(0, 1fr) 320px; } }
    @media (max-width: 760px) {
      :host { overflow-y: auto; }
      .studio { display: flex; flex-direction: column; height: auto; }
      .form { overflow: visible; padding: 14px 16px 18px; }
      app-queue-panel { height: auto; border-left: 0; border-top: 1px solid var(--border-subtle); }
      .describe-row { flex-direction: column; }
    }
  `],
})
export class StudioPageComponent {
  protected readonly studio = inject(StudioService);
  protected readonly hub = inject(HubService);
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
