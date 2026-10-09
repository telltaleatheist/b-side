import { CdkDrag, CdkDragHandle, CdkDragPlaceholder, CdkDropList, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, computed, effect, ElementRef, inject, input, signal, untracked, viewChild } from '@angular/core';

import { clockText } from '../../core/format';
import { LibraryService } from '../../core/library.service';
import { PlayerService, type PlayItem, type QueueEntry } from '../../core/player.service';
import { UiService } from '../../core/ui.service';
import { CoverComponent } from '../cover/cover.component';
import { SwipeDirective, type Swipe } from '../../core/swipe.directive';
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
  imports: [CoverComponent, IconComponent, SaveMenuComponent, SwipeDirective, CdkDropList, CdkDrag, CdkDragHandle, CdkDragPlaceholder],
  host: {
    '[class.sheet]': "mode() === 'sheet'",
    '[class.panel]': "mode() === 'panel'",
    '[class.pulling]': 'pull() > 0',
    '[style.transform]': "pull() > 0 ? 'translateY(' + pull() + 'px)' : null",
    '(keydown.escape)': 'close()',
  },
  template: `
    <div class="frame" [appSwipe]="panel() ? 'x' : 'y'" (swipeMove)="pulling($event)" (swipeEnd)="pulled($event)" (swipeCancel)="pull.set(0)">
    @if (mode() === 'sheet') {
      <div class="grabber" aria-hidden="true"></div>
      <div class="top">
        <button type="button" class="icon-btn" aria-label="Close" (click)="close()"><app-icon name="down" /></button>
        <div class="from">
          <span class="kicker">Playing from</span>
          <span class="from-name">{{ player.sourceName() }}</span>
        </div>
        <button type="button" class="icon-btn lyrics-toggle" [class.on]="showingLyrics()" [attr.aria-pressed]="showingLyrics()"
                [disabled]="player.current() === null" (click)="showingLyrics.set(!showingLyrics())" aria-label="Lyrics"><span class="lyrics-mark">Aa</span></button>
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
      } @else if (showingLyrics()) {
        <div class="lyrics-card" #lyricsCard (touchstart)="touchedLyrics()" (wheel)="touchedLyrics()">
          @if (item.lyrics) {
            @for (line of lyricLines(item.lyrics); track $index; let at = $index) {
              @if (line.section) {
                <span class="card-section">{{ line.text }}</span>
              } @else {
                <span class="card-line" [attr.data-line]="at" [class.now]="at === activeLine()" [class.sung]="activeLine() !== null && at < activeLine()!">{{ line.text }}</span>
              }
            }
          } @else {
            <p class="card-empty">No lyrics: this one is instrumental.</p>
          }
        </div>
      } @else {
        <div class="art-swipe" appSwipe="x" (swipeMove)="artShift.set($event.dx)" (swipeEnd)="swiped($event)" (swipeCancel)="artShift.set(0)"
             [class.moving]="artShift() !== 0" [style.transform]="artShift() ? 'translateX(' + artShift() + 'px) rotate(' + artShift() / 40 + 'deg)' : null">
          <app-cover class="art" [key]="coverKey(item)" [src]="item.art" />
        </div>
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
        <button type="button" class="icon-btn toggle" aria-label="Shuffle" [class.on]="player.shuffle()" [attr.aria-pressed]="player.shuffle()" (click)="player.toggleShuffle()"><app-icon name="shuffle" [size]="22" /></button>
        <button type="button" class="icon-btn big" aria-label="Previous" [disabled]="!player.hasPrevious()" (click)="player.previous()"><app-icon name="prev" [size]="30" /></button>
        <button type="button" class="play" [attr.aria-label]="player.paused() ? 'Play' : 'Pause'" (click)="player.toggle()">
          <app-icon [name]="player.paused() ? 'play' : 'pause'" [size]="34" />
        </button>
        <button type="button" class="icon-btn big" aria-label="Next" [disabled]="!player.hasNext()" (click)="player.next()"><app-icon name="next" [size]="30" /></button>
        <button type="button" class="icon-btn toggle" [class.on]="player.repeat() !== 'off'" [attr.aria-label]="'Repeat: ' + player.repeat()" (click)="player.cycleRepeat()"><app-icon [name]="player.repeat() === 'one' ? 'repeat-one' : 'repeat'" [size]="22" /></button>
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
        <div class="next-head">
          <span class="kicker amber">Up next</span>
          <span class="mono count">{{ player.upNext().length }}</span>
          <button type="button" class="clear" (click)="player.clearUpNext()">Clear</button>
        </div>
        <div class="next-list" cdkDropList [cdkDropListData]="shownNext()" (cdkDropListDropped)="dropped($event)">
          @for (entry of shownNext(); track entry.qid) {
            <div class="next-row" cdkDrag cdkDragLockAxis="y" [cdkDragData]="entry">
              <span class="grip" cdkDragHandle aria-label="Drag to move" title="Drag to move"><app-icon name="grip" [size]="16" /></span>
              <button type="button" class="next-play" [title]="'Play ' + entry.item.title" (click)="player.playEntry(entry)">
                <app-cover class="mini-art" [key]="coverKey(entry.item)" [src]="entry.item.art" />
                <span class="next-names">
                  <span class="next-title">{{ entry.item.title }}</span>
                  @if (!entry.fromSource) { <span class="next-from">from {{ entry.from }}</span> }
                </span>
                <span class="mono next-time">{{ clock(entry.item.durationS) }}</span>
              </button>
              <button type="button" class="icon-btn remove" [attr.aria-label]="'Remove ' + entry.item.title + ' from the queue'" title="Remove from the queue"
                      (click)="player.remove(entry.qid)"><app-icon name="close" [size]="14" /></button>
              <div class="drop-slot" *cdkDragPlaceholder></div>
            </div>
          }
        </div>
        @if (player.upNext().length > shownNext().length) {
          <span class="hint more">and {{ player.upNext().length - shownNext().length }} more</span>
        }
      </div>
    }
    </div>
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
    .frame { display: flex; flex-direction: column; gap: 18px; min-height: 100%; }
    :host(.sheet) { overscroll-behavior: none; transition: transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1); }
    :host(.sheet.pulling) { transition: none; }
    .grabber { align-self: center; width: 38px; height: 5px; margin-bottom: -10px; border-radius: 3px; background: rgba(255,255,255,.25); }
    .lyrics-toggle { color: var(--text-tertiary); }
    .lyrics-toggle.on { color: var(--accent); }
    .lyrics-mark { font-family: var(--font-display); font-weight: 800; font-size: 17px; letter-spacing: -0.5px; }
    .art-swipe { width: 100%; max-width: 420px; align-self: center; transition: transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1); touch-action: pan-y; }
    .art-swipe.moving { transition: none; }
    .art-swipe .art { max-width: none; }
    .lyrics-card {
      height: min(62vh, 560px); overflow-y: auto; padding: 22px 20px 40vh; border-radius: 14px;
      background: linear-gradient(160deg, #6b3a1f 0%, #3a2117 55%, #1d1410 100%);
      display: flex; flex-direction: column; gap: 10px; scroll-behavior: smooth;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 28px, #000 calc(100% - 60px), transparent 100%);
    }
    .card-section { font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: rgba(255,255,255,.4); padding-top: 14px; }
    .card-section:first-child { padding-top: 0; }
    .card-line { font-family: var(--font-display); font-weight: 800; font-size: 25px; line-height: 1.22; color: rgba(255,255,255,.45); transition: color 400ms ease; }
    .card-line.sung { color: rgba(255,255,255,.72); }
    .card-line.now { color: #fff; }
    .card-empty { font-size: 18px; color: rgba(255,255,255,.7); }
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
    .next-head { display: flex; align-items: baseline; gap: 8px; padding-bottom: 4px; }
    .next-head .kicker.amber { padding-bottom: 0; }
    .count { font-size: 11px; color: var(--text-tertiary); }
    .clear { margin-left: auto; padding: 2px 6px; border: none; background: transparent; color: var(--text-tertiary); font-size: 12px; }
    .clear:hover { color: var(--text-primary); }
    .next-list { display: flex; flex-direction: column; gap: 2px; }
    .next-row {
      display: flex; align-items: center; gap: 4px; padding: 2px 4px 2px 0; border-radius: var(--radius-md);
      color: var(--text-primary); background: transparent;
    }
    .next-row:hover { background: var(--bg-hover); }
    .grip { display: inline-flex; padding: 6px 2px 6px 4px; color: var(--text-muted); cursor: grab; touch-action: none; }
    .next-row:hover .grip { color: var(--text-tertiary); }
    .next-play {
      flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 4px; border: none;
      background: transparent; text-align: left; color: inherit;
    }
    .next-names { flex: 1; min-width: 0; display: flex; flex-direction: column; }
    .next-from { font-size: 11px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .remove { width: 28px; height: 28px; opacity: 0; color: var(--text-tertiary); }
    .next-row:hover .remove, .remove:focus-visible { opacity: 1; }
    :host(.sheet) .remove { opacity: 1; }
    .more { padding: 4px 8px; }
    .drop-slot { height: 48px; border-radius: var(--radius-md); background: var(--bg-elevated); border: 1px dashed var(--border-subtle); }
    .cdk-drag-preview { display: flex; align-items: center; gap: 4px; border-radius: var(--radius-md); background: var(--bg-elevated); box-shadow: 0 12px 30px rgba(0,0,0,.5); color: var(--text-primary); }
    .cdk-drag-animating, .next-list.cdk-drop-list-dragging .next-row:not(.cdk-drag-placeholder) { transition: transform 180ms cubic-bezier(0, 0, 0.2, 1); }
    .toggle { color: var(--text-tertiary); }
    .toggle.on { color: var(--accent); }
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
  /** How far the sheet is pulled down (px), while a finger drags it. */
  protected readonly pull = signal(0);
  /** How far the cover is dragged sideways (px): left for the next song, right for the one before. */
  protected readonly artShift = signal(0);
  private readonly lyricsCard = viewChild<ElementRef<HTMLElement>>('lyricsCard');
  /** When a finger last moved the lyrics: following the song waits a moment after it. */
  private lyricsTouchedAt = 0;

  /**
   * The line being sung, as near as it can be told: YuE's songs carry no
   * timings, so the sung lines are spread over the song (past a short intro,
   * before a short outro), each by its length. Null when nothing is sung.
   */
  protected readonly activeLine = computed(() => {
    const lyrics = this.player.current()?.lyrics;
    const duration = this.player.duration();
    if (!lyrics || duration <= 0) return null;
    const lines = this.lyricLines(lyrics);
    const sung = lines.map((line, at) => ({ at, weight: line.section ? 0 : Math.max(8, line.text.length) })).filter((line) => line.weight > 0);
    if (sung.length === 0) return null;
    const start = Math.min(12, duration * 0.08);
    const end = duration - Math.min(10, duration * 0.06);
    const share = Math.min(1, Math.max(0, (this.player.time() - start) / Math.max(1, end - start)));
    const total = sung.reduce((sum, line) => sum + line.weight, 0);
    let reached = share * total;
    for (const line of sung) {
      reached -= line.weight;
      if (reached < 0) return line.at;
    }
    return (sung[sung.length - 1] as { at: number }).at;
  });

  constructor() {
    // The lyrics follow the song: the line being sung kept in the middle, unless a finger is reading.
    effect(() => {
      const line = this.activeLine();
      const card = this.lyricsCard()?.nativeElement;
      if (line === null || card === undefined) return;
      untracked(() => {
        if (Date.now() - this.lyricsTouchedAt < 4000) return;
        const element = card.querySelector<HTMLElement>(`[data-line="${line}"]`);
        if (element !== null) card.scrollTo({ top: element.offsetTop - card.clientHeight * 0.38, behavior: 'smooth' });
      });
    });
  }

  protected touchedLyrics(): void {
    this.lyricsTouchedAt = Date.now();
  }

  /** The sheet follows a finger pulling it down. */
  protected pulling(swipe: Swipe): void {
    if (this.mode() === 'sheet' && swipe.axis === 'y') this.pull.set(Math.max(0, swipe.dy));
  }

  /** Let go far or fast enough, the sheet closes (minimised to the mini player); else it springs back. */
  protected pulled(swipe: Swipe): void {
    if (this.mode() === 'sheet' && swipe.axis === 'y' && (swipe.dy > 140 || (swipe.vy ?? 0) > 0.6)) {
      this.pull.set(innerHeight);
      setTimeout(() => {
        this.pull.set(0);
        this.close();
      }, 200);
      return;
    }
    this.pull.set(0);
  }

  /** The cover flicked left plays the next song, right the one before. */
  protected swiped(swipe: Swipe): void {
    this.artShift.set(0);
    const far = Math.abs(swipe.dx) > 90 || Math.abs(swipe.vx ?? 0) > 0.5;
    if (!far) return;
    if (swipe.dx < 0 && this.player.hasNext()) this.player.next();
    else if (swipe.dx > 0) this.player.previous();
  }

  /** The take being played, when the current song is one (only a take can be saved from here). */
  protected readonly take = computed(() => {
    const item = this.player.current();
    return item?.kind === 'take' ? (this.library.takes().find((take) => take.id === item.id) ?? null) : null;
  });
  protected readonly remaining = computed(() => Math.max(0, this.player.duration() - this.player.time()));
  protected readonly shownNext = computed<QueueEntry[]>(() => this.player.upNext().slice(0, this.mode() === 'sheet' ? 20 : 100));

  protected dropped(event: CdkDragDrop<QueueEntry[]>): void {
    if (event.previousIndex !== event.currentIndex) this.player.moveUpNext(event.previousIndex, event.currentIndex);
  }

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
