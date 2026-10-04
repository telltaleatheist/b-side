import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { Playlist, RefusalView, Song } from '@shared/types';

import { CoverComponent } from '../../components/cover/cover.component';
import { IconComponent } from '../../components/icon/icon.component';
import { ConfirmService } from '../../core/confirm.service';
import { clockText } from '../../core/format';
import { desktop } from '../../core/hub.service';
import { LibraryService } from '../../core/library.service';
import { OfflineService } from '../../core/offline.service';
import { PlayerService } from '../../core/player.service';

/**
 * The library: every playlist as a cover (`/library`), and one playlist's page
 * (`/library/<id>`) with its songs in play order. A song lives while some
 * playlist holds it, so taking it out of its last playlist deletes it — and
 * the page says so before it does.
 */
@Component({
  selector: 'app-playlists-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, CoverComponent, IconComponent],
  template: `
    <div class="page">
      @if (selected(); as playlist) {
        <a class="back" routerLink="/library"><app-icon name="chevron" [size]="16" class="flip" />Library</a>
        <header class="head">
          <app-cover class="head-art" [key]="playlist.id" />
          <div class="head-text">
            <span class="kicker">Playlist</span>
            @if (renaming() === 'playlist') {
              <input type="text" class="rename big" maxlength="120" aria-label="Playlist name" [value]="playlist.name"
                     (keydown.enter)="renamePlaylist(playlist, $any($event.target).value)"
                     (keydown.escape)="renaming.set(null)"
                     (blur)="renamePlaylist(playlist, $any($event.target).value)" />
            } @else {
              <h1 class="head-title">{{ playlist.name }}</h1>
            }
            <span class="head-sub">{{ songs().length }} {{ songs().length === 1 ? 'song' : 'songs' }}{{ total() }}</span>
            <div class="head-actions">
              <button type="button" class="primary" [disabled]="songs().length === 0" (click)="player.playPlaylist(playlist.id)"><app-icon name="play" [size]="18" />Play</button>
              <button type="button" class="icon-btn outlined" aria-label="Rename" title="Rename" (click)="renaming.set('playlist')"><app-icon name="bookmark" [size]="18" /></button>
              <button type="button" class="icon-btn outlined" aria-label="Delete playlist" title="Delete playlist" (click)="deletePlaylist(playlist)"><app-icon name="trash" [size]="18" /></button>
            </div>
          </div>
        </header>
        @if (offline.offered()) {
          <label class="keep switch">
            <input type="checkbox" [checked]="offline.kept().has(playlist.id)" (change)="offline.keep(playlist.id, $any($event.target).checked)" />
            <span>Keep on this phone</span>
            @if (offline.kept().has(playlist.id)) {
              <span class="hint">{{ offline.countOn(playlist.songs) }} of {{ playlist.songs.length }} here{{ offline.busy() ? ' — saving…' : '' }}</span>
            }
          </label>
          @if (offline.problem(); as trouble) { <div class="notice">{{ trouble }}</div> }
        }
        <div class="list">
          @for (song of songs(); track song.id; let at = $index) {
            <div class="item" [class.current]="isCurrent(song)" (click)="play(playlist, song, $event)">
              <span class="num mono">{{ isCurrent(song) ? '▸' : (at + 1 < 10 ? '0' : '') + (at + 1) }}</span>
              <div class="main">
                @if (renaming() === song.id) {
                  <input type="text" class="rename" maxlength="200" aria-label="Song title" [value]="song.title"
                         (keydown.enter)="renameSong(song, $any($event.target).value)"
                         (keydown.escape)="renaming.set(null)"
                         (blur)="renameSong(song, $any($event.target).value)" />
                } @else {
                  <div class="title">{{ song.title }}</div>
                }
                <div class="sub">{{ song.params.tags ?? '' }}@if (alsoIn(song, playlist); as others) { · also in {{ others }} }</div>
              </div>
              <span class="mono time">{{ clock(song.durationS) }}</span>
              <div class="actions">
                <button type="button" class="icon-btn" aria-label="Move up" title="Move up" [disabled]="at === 0" (click)="move(playlist, at, -1)"><app-icon name="down" [size]="18" class="flip-v" /></button>
                <button type="button" class="icon-btn" aria-label="Move down" title="Move down" [disabled]="at === songs().length - 1" (click)="move(playlist, at, 1)"><app-icon name="down" [size]="18" /></button>
                <button type="button" class="icon-btn" aria-label="Rename" title="Rename" (click)="renaming.set(song.id)"><app-icon name="bookmark" [size]="16" /></button>
                @if (isDesktop) {
                  <button type="button" class="icon-btn" aria-label="Save a copy" title="Save a copy…" (click)="saveCopy(song)"><app-icon name="save" [size]="18" /></button>
                  <button type="button" class="icon-btn" aria-label="Show in folder" title="Show in folder" (click)="reveal(song)"><app-icon name="library" [size]="18" /></button>
                }
                <button type="button" class="icon-btn" aria-label="Take it out of this playlist" title="Take it out of this playlist" (click)="removeSong(playlist, song)"><app-icon name="close" [size]="18" /></button>
              </div>
            </div>
          } @empty {
            <p class="hint">Nothing in it yet. Save a song from the playing list into it.</p>
          }
        </div>
      } @else {
        <div class="title-row">
          <h1 class="page-title">Library</h1>
        </div>
        <div class="grid">
          @for (playlist of library.playlists(); track playlist.id) {
            <a class="tile" [routerLink]="['/library', playlist.id]">
              <app-cover class="tile-art" [key]="playlist.id" />
              <span class="tile-name">{{ playlist.name }}</span>
              <span class="tile-sub">{{ playlist.songs.length }} {{ playlist.songs.length === 1 ? 'song' : 'songs' }}</span>
            </a>
          } @empty {
            <p class="hint">No playlists yet. Save a song from the playing list, or make one here.</p>
          }
        </div>
        <form class="new" (submit)="$event.preventDefault(); create()">
          <input type="text" maxlength="120" placeholder="New playlist" aria-label="New playlist name" [value]="newName()" (input)="newName.set($any($event.target).value)" />
          <button type="submit" class="ghost" [disabled]="newName().trim() === ''">Make</button>
        </form>
      }
      @if (refusal(); as refused) {
        <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
      }
    </div>
  `,
  styles: [`
    .page { max-width: 1100px; margin: 0 auto; padding: 18px 20px 28px; display: flex; flex-direction: column; gap: 20px; }
    .back { display: inline-flex; align-items: center; gap: 4px; color: var(--text-secondary); text-decoration: none; font-size: 13px; }
    .flip { transform: scaleX(-1); }
    .flip-v { transform: scaleY(-1); }
    .head { display: flex; gap: 20px; align-items: flex-end; flex-wrap: wrap; }
    .head-art { width: 168px; --cover-radius: 8px; box-shadow: 0 18px 40px rgba(0,0,0,.5); }
    .head-text { display: flex; flex-direction: column; gap: 8px; min-width: 0; flex: 1 1 240px; }
    .head-title { font-family: var(--font-display); font-weight: 900; font-size: 44px; line-height: .92; margin: 0; overflow-wrap: anywhere; }
    .head-sub { font-size: 13px; color: var(--text-tertiary); }
    .head-actions { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
    .rename { padding: 6px 10px; font-size: 15px; }
    .rename.big { font-family: var(--font-display); font-size: 32px; font-weight: 800; }
    .keep { align-self: flex-start; }
    .list { display: flex; flex-direction: column; }
    .item { display: flex; align-items: center; gap: 14px; padding: 8px 10px; border-radius: var(--radius-md); cursor: pointer; }
    .item:hover { background: var(--bg-hover); }
    .item.current { background: var(--accent-faint); }
    .item.current .title, .item.current .num { color: var(--accent); }
    .num { width: 22px; font-size: 12px; color: var(--text-muted); }
    .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .title { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
    .sub { font-size: 12px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .time { font-size: 12px; color: var(--text-tertiary); }
    .actions { display: flex; }
    .actions .icon-btn { width: 36px; height: 36px; color: var(--text-tertiary); }
    .actions .icon-btn:hover:not(:disabled) { color: var(--accent); }
    .title-row { display: flex; align-items: baseline; justify-content: space-between; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 20px 16px; }
    .tile { display: flex; flex-direction: column; gap: 6px; text-decoration: none; color: inherit; min-width: 0; }
    .tile-art { width: 100%; }
    .tile-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tile-sub { font-size: 12px; color: var(--text-tertiary); }
    .new { display: flex; gap: 8px; max-width: 420px; }
    .new input { flex: 1; min-width: 0; }
    @media (max-width: 700px) {
      .actions .icon-btn:not(:last-child) { display: none; }
      .head-art { width: 140px; }
      .head-title { font-size: 36px; }
    }
    @media (min-width: 960px) { .page { padding: 32px 40px; } .head-art { width: 232px; } .head-title { font-size: 64px; } }
  `],
})
export class PlaylistsPageComponent {
  protected readonly library = inject(LibraryService);
  protected readonly player = inject(PlayerService);
  protected readonly offline = inject(OfflineService);
  private readonly confirm = inject(ConfirmService);
  protected readonly isDesktop = desktop !== null;

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  /** The playlist the address names (`/library/<id>`), or none: the grid. */
  private readonly chosen = toSignal(this.route.paramMap.pipe(map((params) => params.get('id'))), { initialValue: null });
  protected readonly newName = signal('');
  protected readonly renaming = signal<string | null>(null);
  protected readonly refusal = signal<RefusalView | null>(null);

  protected readonly selected = computed<Playlist | null>(() => {
    const id = this.chosen();
    return id === null ? null : (this.library.playlist(id) ?? null);
  });

  protected readonly songs = computed(() => {
    const playlist = this.selected();
    return playlist === null ? [] : this.library.songsOf(playlist);
  });

  protected readonly total = computed(() => {
    const seconds = this.songs().reduce((sum, song) => sum + (song.durationS ?? 0), 0);
    return seconds > 0 ? `, ${clockText(seconds)}` : '';
  });

  protected clock(seconds: number | null): string {
    return seconds === null ? '–:––' : clockText(seconds);
  }

  protected isCurrent(song: Song): boolean {
    return this.player.current()?.key === `song:${song.id}`;
  }

  protected alsoIn(song: Song, here: Playlist): string | null {
    const others = this.library.holding(song.id).filter((playlist) => playlist.id !== here.id).map((playlist) => playlist.name);
    return others.length === 0 ? null : others.join(', ');
  }

  protected play(playlist: Playlist, song: Song, event: MouseEvent): void {
    if ((event.target as HTMLElement).closest('button, input')) return;
    this.player.playPlaylist(playlist.id, song);
  }

  protected async create(): Promise<void> {
    const made = await this.library.createPlaylist(this.newName());
    if ('code' in made) {
      this.refusal.set(made);
      return;
    }
    this.refusal.set(null);
    this.newName.set('');
    void this.router.navigate(['/library', made.id]);
  }

  protected async renamePlaylist(playlist: Playlist, name: string): Promise<void> {
    if (this.renaming() !== 'playlist') return;
    this.renaming.set(null);
    if (name.trim() === '' || name.trim() === playlist.name) return;
    this.refusal.set(await this.library.renamePlaylist(playlist.id, name));
  }

  protected async renameSong(song: Song, title: string): Promise<void> {
    if (this.renaming() !== song.id) return;
    this.renaming.set(null);
    if (title.trim() === '' || title.trim() === song.title) return;
    this.refusal.set(await this.library.renameSong(song.id, title));
  }

  protected async move(playlist: Playlist, at: number, by: -1 | 1): Promise<void> {
    const order = [...playlist.songs];
    const [moved] = order.splice(at, 1);
    if (moved === undefined) return;
    order.splice(at + by, 0, moved);
    this.refusal.set(await this.library.reorder(playlist.id, order));
  }

  protected async removeSong(playlist: Playlist, song: Song): Promise<void> {
    const last = this.library.holding(song.id).length <= 1;
    if (last) {
      const yes = await this.confirm.ask({
        title: `Delete "${song.title}"?`,
        message: `${playlist.name} is the only playlist it is in, so taking it out deletes the song from the library. This cannot be undone.`,
        confirm: 'Delete song',
        danger: true,
      });
      if (!yes) return;
    }
    this.refusal.set(await this.library.removeSong(playlist.id, song.id));
  }

  protected async deletePlaylist(playlist: Playlist): Promise<void> {
    const only = this.library.songsOf(playlist).filter((song) => this.library.holding(song.id).length <= 1).length;
    const yes = await this.confirm.ask({
      title: `Delete the playlist "${playlist.name}"?`,
      message: only === 0
        ? 'Its songs are all in other playlists too, so no song is deleted.'
        : `${only} of its songs ${only === 1 ? 'is' : 'are'} in no other playlist and will be deleted from the library. This cannot be undone.`,
      confirm: 'Delete playlist',
      danger: true,
    });
    if (!yes) return;
    this.refusal.set(await this.library.deletePlaylist(playlist.id));
    void this.router.navigate(['/library']);
  }

  protected async saveCopy(song: Song): Promise<void> {
    this.refusal.set(await this.library.saveCopy(song));
  }

  protected async reveal(song: Song): Promise<void> {
    this.refusal.set(await this.library.reveal(song));
  }
}
