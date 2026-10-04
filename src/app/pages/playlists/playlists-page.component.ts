import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { AlbumMeta, AlbumStage, Playlist, RefusalView, Song } from '@shared/types';

import { CoverComponent } from '../../components/cover/cover.component';
import { IconComponent } from '../../components/icon/icon.component';
import { CloudService } from '../../core/cloud.service';
import { ConfirmService } from '../../core/confirm.service';
import { clockText } from '../../core/format';
import { desktop, HubService } from '../../core/hub.service';
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
          <app-cover class="head-art" [key]="playlist.id" [src]="isCloud() ? cloud.coverUrl(playlist) : hub.coverUrl(playlist)" />
          <div class="head-text">
            @if (isCloud()) {
              <span class="kicker">{{ playlist.album ? 'Album' : 'Playlist' }} · in the cloud on {{ cloud.host() }}</span>
            } @else if (playlist.album; as album) {
              <span class="kicker" [class.amber]="busy(album.stage)">Album · {{ stageWords(album.stage) }}</span>
            } @else {
              <span class="kicker">Playlist</span>
            }
            @if (renaming() === 'playlist') {
              <input type="text" class="rename big" maxlength="120" aria-label="Playlist name" [value]="playlist.name"
                     (keydown.enter)="renamePlaylist(playlist, $any($event.target).value)"
                     (keydown.escape)="renaming.set(null)"
                     (blur)="renamePlaylist(playlist, $any($event.target).value)" />
            } @else {
              <h1 class="head-title">{{ playlist.name }}</h1>
            }
            @if (playlist.album; as album) {
              @if (album.artist) { <span class="head-artist">{{ album.artist }}</span> }
              @if (album.blurb) { <span class="head-blurb">{{ album.blurb }}</span> }
              <span class="head-sub">{{ album.ask.sung ? 'Sung' : 'Instrumental' }} · {{ songs().length }} {{ songs().length === 1 ? 'track' : 'tracks' }}{{ total() }} of {{ album.ask.minutes }} min@if (album.writer) { · written by {{ album.writer }}}</span>
              @if (busy(album.stage)) {
                <div class="bar album-bar"><span [style.width.%]="albumShare(album) * 100"></span></div>
              }
              @if (album.refusal; as refused) {
                <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
              }
            } @else {
              <span class="head-sub">{{ songs().length }} {{ songs().length === 1 ? 'song' : 'songs' }}{{ total() }}</span>
            }
            <div class="head-actions">
              <button type="button" class="primary" [disabled]="songs().length === 0" (click)="isCloud() ? player.playCloud(playlist.id) : player.playPlaylist(playlist.id)"><app-icon name="play" [size]="18" />Play</button>
              @if (!isCloud() && cloud.linked() && playlist.album && !busy(playlist.album.stage)) {
                <button type="button" class="ghost" [disabled]="cloud.saving() !== null" (click)="saveToCloud(playlist)">
                  <app-icon name="cloud" [size]="18" />{{ cloud.saving()?.playlist === playlist.id ? 'Saving ' + cloud.saving()!.done + ' of ' + cloud.saving()!.of + '…' : 'Save to cloud' }}
                </button>
              }
              @if (!isCloud() && playlist.album && busy(playlist.album.stage)) {
                <button type="button" class="ghost" (click)="stopAlbum(playlist)">Stop making</button>
              }
              @if (!isCloud()) {
                <button type="button" class="icon-btn outlined" aria-label="Rename" title="Rename" (click)="renaming.set('playlist')"><app-icon name="bookmark" [size]="18" /></button>
              }
              <button type="button" class="icon-btn outlined" [attr.aria-label]="isCloud() ? 'Delete from the cloud' : 'Delete'" [title]="isCloud() ? 'Delete from the cloud' : 'Delete'" (click)="deletePlaylist(playlist)"><app-icon name="trash" [size]="18" /></button>
            </div>
          </div>
        </header>
        @if (offline.offered() && (isCloud() || !hub.onPhone())) {
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
              @if (!isCloud()) {
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
              }
            </div>
          } @empty {
            @if (!playlist.album) { <p class="hint">Nothing in it yet. Save a song from the playing list into it.</p> }
          }
          @for (row of upcoming(); track row.index) {
            <div class="item upcoming" [class.making]="row.making">
              <span class="num mono">{{ (row.index + 1 < 10 ? '0' : '') + (row.index + 1) }}</span>
              <div class="main">
                <div class="title">{{ row.title }}</div>
                <div class="sub">{{ row.tags }}</div>
              </div>
              <span class="mono time">{{ row.making ? 'making' : 'waiting' }}</span>
            </div>
          }
          @if (playlist.album?.stage === 'planning') {
            <p class="hint">{{ playlist.album?.ask?.sung && playlist.album?.plan ? 'Writing the lyrics…' : 'Writing the album: its name, the artist, the tracks…' }}</p>
          } @else if (playlist.album?.stage === 'cover') {
            <p class="hint">Painting the cover…</p>
          }
        </div>
      } @else {
        <div class="title-row">
          <h1 class="page-title">Library</h1>
        </div>
        @if (cloud.linked()) { <h2 class="section-title">On this phone</h2> }
        <div class="grid">
          @for (playlist of library.playlists(); track playlist.id) {
            <a class="tile" [routerLink]="['/library', playlist.id]">
              <app-cover class="tile-art" [key]="playlist.id" [src]="hub.coverUrl(playlist)" />
              <span class="tile-name">{{ playlist.name }}</span>
              @if (playlist.album; as album) {
                <span class="tile-sub" [class.amber]="busy(album.stage)">{{ album.artist || 'Album' }}{{ busy(album.stage) ? ' · ' + stageWords(album.stage) : '' }}</span>
              } @else {
                <span class="tile-sub">{{ playlist.songs.length }} {{ playlist.songs.length === 1 ? 'song' : 'songs' }}</span>
              }
            </a>
          } @empty {
            <p class="hint">{{ cloud.linked() ? 'Nothing kept only on this phone.' : 'No playlists yet. Save a song from the playing list, or make one here.' }}</p>
          }
        </div>
        @if (cloud.linked()) {
          <div class="cloud-head">
            <h2 class="section-title">In the cloud</h2>
            <span class="mono hint">{{ cloud.host() }}{{ cloud.state() === 'unreachable' ? ' · not answering' : '' }}</span>
          </div>
          <div class="grid">
            @for (playlist of cloud.library()?.playlists ?? []; track playlist.id) {
              <a class="tile" [routerLink]="['/cloud', playlist.id]">
                <app-cover class="tile-art" [key]="playlist.id" [src]="cloud.coverUrl(playlist)" />
                <span class="tile-name">{{ playlist.name }}</span>
                <span class="tile-sub mark" [class.down]="offline.kept().has(playlist.id)">
                  <app-icon [name]="offline.kept().has(playlist.id) ? 'download' : 'cloud'" [size]="13" />{{ offline.kept().has(playlist.id) ? 'downloaded' : 'streams' }}
                </span>
              </a>
            } @empty {
              <p class="hint">{{ cloud.state() === 'ok' ? 'Nothing in the cloud yet. Save an album to it from its page.' : (cloud.trouble() ?? 'Reading the cloud…') }}</p>
            }
          </div>
        }
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
    .head-artist { font-size: 16px; color: var(--text-primary); }
    .head-blurb { font-size: 14px; color: var(--text-secondary); font-style: italic; }
    .amber { color: var(--audio) !important; }
    .album-bar > span { background: linear-gradient(90deg, var(--accent), var(--audio)); }
    .item.upcoming { cursor: default; opacity: 0.4; }
    .item.upcoming:hover { background: transparent; }
    .item.upcoming.making { opacity: 1; }
    .item.upcoming.making .num, .item.upcoming.making .time { color: var(--audio); }
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
    .cloud-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-top: 8px; }
    .mark { display: inline-flex; align-items: center; gap: 5px; }
    .mark.down { color: var(--accent); }
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
  protected readonly hub = inject(HubService);

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  /** The playlist the address names (`/library/<id>`), or none: the grid. */
  private readonly chosen = toSignal(this.route.paramMap.pipe(map((params) => params.get('id'))), { initialValue: null });
  protected readonly cloud = inject(CloudService);
  /** `/cloud/<id>`: a playlist in the phone's cloud (read from the computer), not one of the phone's own. */
  protected readonly isCloud = toSignal(this.route.data.pipe(map((data) => data['cloud'] === true)), { initialValue: false });
  protected readonly newName = signal('');
  protected readonly renaming = signal<string | null>(null);
  protected readonly refusal = signal<RefusalView | null>(null);

  protected readonly selected = computed<Playlist | null>(() => {
    const id = this.chosen();
    if (id === null) return null;
    return this.isCloud() ? this.cloud.playlist(id) : (this.library.playlist(id) ?? null);
  });

  protected readonly songs = computed(() => {
    const playlist = this.selected();
    if (playlist === null) return [];
    return this.isCloud() ? this.cloud.songsOf(playlist) : this.library.songsOf(playlist);
  });

  protected readonly total = computed(() => {
    const seconds = this.songs().reduce((sum, song) => sum + (song.durationS ?? 0), 0);
    return seconds > 0 ? `, ${clockText(seconds)}` : '';
  });

  /** An album's planned tracks not made yet: the ones on the server, then the ones waiting. */
  protected readonly upcoming = computed(() => {
    const album = this.selected()?.album;
    if (album?.plan == null || !this.busy(album.stage)) return [];
    const made = new Set(this.songs().map((song) => song.title));
    return album.plan.tracks
      .map((track, index) => ({ index, title: track.title, tags: track.tags, making: index < album.sent }))
      .filter((row) => !made.has(row.title));
  });

  protected busy(stage: AlbumStage): boolean {
    return stage === 'planning' || stage === 'cover' || stage === 'making';
  }

  protected stageWords(stage: AlbumStage): string {
    switch (stage) {
      case 'planning': return 'writing';
      case 'cover': return 'painting the cover';
      case 'making': return 'making';
      case 'done': return 'done';
      case 'stopped': return 'stopped';
      case 'failed': return 'stopped by a problem';
    }
  }

  protected albumShare(album: AlbumMeta): number {
    return Math.min(1, album.madeS / (album.ask.minutes * 60));
  }

  protected async stopAlbum(playlist: Playlist): Promise<void> {
    const outcome = await this.hub.call<unknown>('POST', `/api/albums/${encodeURIComponent(playlist.id)}/stop`);
    this.refusal.set(outcome.ok ? null : outcome.refusal);
  }

  protected clock(seconds: number | null): string {
    return seconds === null ? '–:––' : clockText(seconds);
  }

  protected isCurrent(song: Song): boolean {
    return this.player.current()?.key === `${this.isCloud() ? 'cloud' : 'song'}:${song.id}`;
  }

  protected alsoIn(song: Song, here: Playlist): string | null {
    if (this.isCloud()) return null;
    const others = this.library.holding(song.id).filter((playlist) => playlist.id !== here.id).map((playlist) => playlist.name);
    return others.length === 0 ? null : others.join(', ');
  }

  protected play(playlist: Playlist, song: Song, event: MouseEvent): void {
    if ((event.target as HTMLElement).closest('button, input')) return;
    if (this.isCloud()) this.player.playCloud(playlist.id, song);
    else this.player.playPlaylist(playlist.id, song);
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

  protected async saveToCloud(playlist: Playlist): Promise<void> {
    const refusal = await this.cloud.saveAlbum(playlist, this.songs());
    this.refusal.set(refusal);
    if (refusal === null) void this.router.navigate(['/cloud', playlist.id]);
  }

  protected async deletePlaylist(playlist: Playlist): Promise<void> {
    if (this.isCloud()) {
      const yes = await this.confirm.ask({
        title: `Delete "${playlist.name}" from the cloud?`,
        message: `It is deleted from ${this.cloud.host()}'s library, with its songs that no other playlist there holds. A copy downloaded to this phone goes too. This cannot be undone.`,
        confirm: 'Delete from the cloud',
        danger: true,
      });
      if (!yes) return;
      if (this.offline.kept().has(playlist.id)) await this.offline.keep(playlist.id, false);
      this.refusal.set(await this.cloud.remove(playlist.id));
      void this.router.navigate(['/library']);
      return;
    }
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
