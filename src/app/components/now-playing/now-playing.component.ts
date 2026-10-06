import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';

import { clockText } from '../../core/format';
import { LibraryService } from '../../core/library.service';
import { PlayerService, type PlayItem } from '../../core/player.service';
import { UiService } from '../../core/ui.service';
import { CoverComponent } from '../cover/cover.component';
import { IconComponent } from '../icon/icon.component';
import { SaveMenuComponent } from '../save-menu/save-menu.component';

/**
 * What is playing and what comes next. Two shapes of one thing:
 *   - `sheet`: the phone's full screen, opened from the mini player, closed by
 *     the chevron (or Escape), with the scrubber and the controls;
 *   - `panel`: the desktop's right-hand column, always there. No controls (the
 *     player bar below has them, Owen 2026-10-06): the song, then Up next. A
 *     click on the song shows its lyrics, with Back to the list.
 */
@Component({
  selector: 'app-now-playing',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CoverComponent, IconComponent, SaveMenuComponent],
  host: { '[class.sheet]': "mode() === 'sheet'", '[class.panel]': "mode() === 'panel'", '(keydown.escape)': 'close()' },
  template: `
    @if (mode() === 'sheet') {
      <div class="top">
        <button type="button" class="icon-btn" aria-label="Close" (click)="close()"><app-icon name="down" /></button>
        <div class="from">
          <span class="kicker">Playing from</span>
          <span class="from-name">{{ player.sourceName() }}</span>
        </div>
        <span class="spacer-44"></span>
      </div>
    } @else {
      <span class="kicker">Now playing</span>
    }

    @if (player.current(); as item) {
      @if (panel() && showingLyrics()) {
        <button type="button" class="back" (click)="showingLyrics.set(false)"><app-icon name="back" [size]="18" />Up next</button>
        <div class="lyrics-head">
          <app-cover class="mini-art" [key]="coverKey(item)" [src]="item.art" />
          <div class="names">
            <span class="next-title strong">{{ item.title }}</span>
            <span class="sub">{{ item.tags ?? player.sourceName() }}</span>
          </div>
        </div>
        @if (item.lyrics) {
          <div class="lyrics">
            @for (line of lyricLines(item.lyrics); track $index) {
              @if (line.section) { <span class="kicker section">{{ line.text }}</span> } @else { <span class="line">{{ line.text }}</span> }
            }
          </div>
        } @else {
          <p class="hint">No lyrics: this one is instrumental.</p>
        }
      } @else {
      @if (panel()) {
        <button type="button" class="song-btn" title="Show the lyrics" (click)="showingLyrics.set(true)">
          <app-cover class="art" [key]="coverKey(item)" [src]="item.art" />
        </button>
      } @else {
        <app-cover class="art" [key]="coverKey(item)" [src]="item.art" />
      }
      <div class="titles">
        <div class="names" [class.clickable]="panel()" (click)="panel() && showingLyrics.set(true)">
          <span class="title">{{ item.title }}</span>
          <span class="sub">{{ item.tags ?? player.sourceName() }}</span>
          @if (panel()) { <span class="lyrics-link">{{ item.lyrics ? 'Lyrics' : 'Instrumental' }}</span> }
        </div>
        @if (take(); as take) {
          <button type="button" class="icon-btn outlined" aria-label="Save to a playlist" (click)="saving.set(!saving())"><app-icon name="plus" /></button>
        }
      </div>
      @if (saving() && take(); as take) {
        <app-save-menu [take]="take" (closed)="saving.set(false)" />
      }
      @if (player.problem(); as problem) { <div class="notice">{{ problem }}</div> }

      @if (!panel()) {
      <div class="scrub">
        <input type="range" min="0" step="0.1" aria-label="Position in the song"
               [max]="player.duration()" [value]="scrubbing() ?? player.time()"
               (input)="scrubbing.set(+$any($event.target).value)"
               (change)="seek(+$any($event.target).value)" />
        <div class="times mono"><span>{{ clock(scrubbing() ?? player.time()) }}</span><span>-{{ clock(remaining()) }}</span></div>
      </div>

      <div class="controls">
        <button type="button" class="icon-btn big" aria-label="Previous" [disabled]="!player.hasPrevious()" (click)="player.previous()"><app-icon name="prev" [size]="30" /></button>
        <button type="button" class="play" [attr.aria-label]="player.paused() ? 'Play' : 'Pause'" (click)="player.toggle()">
          <app-icon [name]="player.paused() ? 'play' : 'pause'" [size]="34" />
        </button>
        <button type="button" class="icon-btn big" aria-label="Next" [disabled]="!player.hasNext()" (click)="player.next()"><app-icon name="next" [size]="30" /></button>
      </div>
      }
      @if (player.waiting()) { <p class="hint center">Waiting for the next song to finish…</p> }
      }
    } @else {
      <div class="art empty"><app-icon name="listen" [size]="48" /></div>
      <p class="hint center">Nothing playing yet. Make a song, or play a playlist.</p>
    }

    @if (player.upNext().length > 0 && !(panel() && showingLyrics() && player.current())) {
      <div class="next">
        <span class="kicker amber">Up next</span>
        @for (item of shownNext(); track item.key) {
          <button type="button" class="next-row" (click)="player.play(item)">
            <app-cover class="mini-art" [key]="coverKey(item)" [src]="item.art" />
            <span class="next-title">{{ item.title }}</span>
            <span class="mono next-time">{{ clock(item.durationS) }}</span>
          </button>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 18px; color: var(--text-primary); }
    :host(.sheet) {
      position: fixed; inset: 0; z-index: 50; overflow-y: auto;
      padding: calc(env(safe-area-inset-top) + 10px) 24px calc(env(safe-area-inset-bottom) + 24px);
      background: radial-gradient(120% 70% at 50% 18%, #1c2b33 0%, #13161a 45%, #0b0a09 80%);
      animation: rise 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    :host(.panel) { padding: 24px 20px; min-height: 0; overflow-y: auto; }
    @keyframes rise { from { transform: translateY(40px); opacity: 0; } to { transform: none; opacity: 1; } }
    .top { display: flex; align-items: center; justify-content: space-between; }
    .from { display: flex; flex-direction: column; align-items: center; gap: 2px; }
    .from-name { font-size: 13px; font-weight: 600; }
    .spacer-44 { width: 44px; }
    .art { width: 100%; --cover-radius: 10px; box-shadow: 0 30px 60px rgba(0,0,0,.55); }
    :host(.sheet) .art { max-width: 420px; align-self: center; }
    .art.empty { aspect-ratio: 1; display: flex; align-items: center; justify-content: center; color: var(--text-muted); background: var(--bg-elevated); border-radius: 10px; box-shadow: none; }
    .titles { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
    .names { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .title { font-family: var(--font-display); font-weight: 800; font-size: 34px; line-height: 1; overflow-wrap: anywhere; }
    :host(.panel) .title { font-size: 28px; }
    .sub { font-size: 14px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .scrub { display: flex; flex-direction: column; gap: 4px; }
    .scrub input { width: 100%; padding: 0; border: none; background: transparent; box-shadow: none; accent-color: var(--text-primary); height: 20px; }
    .times { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-tertiary); }
    .controls { display: flex; align-items: center; justify-content: center; gap: 22px; }
    .icon-btn.big { width: 56px; height: 56px; }
    .play {
      width: 76px; height: 76px; border: none; border-radius: 50%; padding: 0;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--accent); color: var(--text-inverse); box-shadow: var(--accent-glow);
    }
    .play:hover { background: var(--accent-hover); }
    :host(.panel) .play { width: 60px; height: 60px; }
    .center { text-align: center; }
    .next { display: flex; flex-direction: column; gap: 4px; margin-top: auto; padding-top: 8px; }
    .kicker.amber { color: var(--audio); padding-bottom: 4px; }
    .next-row {
      display: flex; align-items: center; gap: 10px; padding: 6px; border: none; border-radius: var(--radius-md);
      background: transparent; text-align: left; color: var(--text-primary);
    }
    .next-row:hover { background: var(--bg-hover); }
    .mini-art { width: 36px; --cover-radius: 4px; }
    .next-title { flex: 1; min-width: 0; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .next-time { font-size: 11px; color: var(--text-tertiary); }
    :host(.panel) .next { margin-top: 0; }
    .song-btn { padding: 0; border: none; background: transparent; cursor: pointer; display: block; width: 100%; }
    .clickable { cursor: pointer; }
    .clickable:hover .title { text-decoration: underline; text-underline-offset: 4px; }
    .lyrics-link { font-size: 12px; color: var(--text-tertiary); }
    .back {
      align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px 6px 6px;
      border: none; border-radius: var(--radius-md); background: transparent; color: var(--text-secondary); font-size: 13px;
    }
    .back:hover { background: var(--bg-hover); color: var(--text-primary); }
    .lyrics-head { display: flex; align-items: center; gap: 10px; }
    .lyrics-head .mini-art { width: 48px; }
    .strong { font-weight: 700; }
    .lyrics { display: flex; flex-direction: column; gap: 4px; font-size: 15px; line-height: 1.45; }
    .lyrics .section { color: var(--audio); padding-top: 14px; text-transform: uppercase; }
    .lyrics .section:first-child { padding-top: 0; }
  `],
})
export class NowPlayingComponent {
  protected readonly player = inject(PlayerService);
  private readonly library = inject(LibraryService);
  private readonly ui = inject(UiService);

  readonly mode = input<'sheet' | 'panel'>('panel');

  protected readonly scrubbing = signal<number | null>(null);
  protected readonly saving = signal(false);
  /** The panel shows the playing song's lyrics instead of Up next. */
  protected readonly showingLyrics = signal(false);
  protected readonly panel = computed(() => this.mode() === 'panel');

  /** The take being played, when the current song is one (only a take can be saved from here). */
  protected readonly take = computed(() => {
    const item = this.player.current();
    return item?.kind === 'take' ? (this.library.takes().find((take) => take.id === item.id) ?? null) : null;
  });
  protected readonly remaining = computed(() => Math.max(0, this.player.duration() - this.player.time()));
  protected readonly shownNext = computed(() => this.player.upNext().slice(0, this.mode() === 'sheet' ? 3 : 50));

  /** The lyrics as lines, each section tag (`[verse]`) a line of its own, marked. */
  protected lyricLines(lyrics: string): { readonly text: string; readonly section: boolean }[] {
    return lyrics
      .replace(/\s*(\[[^\]]+\])\s*/g, '\n$1\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => {
        const tag = /^\[([^\]]+)\]$/.exec(line);
        return tag ? { text: tag[1] as string, section: true } : { text: line, section: false };
      });
  }

  protected coverKey(item: PlayItem): string {
    return `${item.id}${item.tags ?? ''}`;
  }

  protected clock(seconds: number | null): string {
    return clockText(seconds ?? 0);
  }

  protected seek(seconds: number): void {
    this.player.seek(seconds);
    this.scrubbing.set(null);
  }

  protected close(): void {
    this.ui.nowPlayingOpen.set(false);
  }
}
