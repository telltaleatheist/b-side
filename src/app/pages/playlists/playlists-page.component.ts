import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import type { Playlist, RefusalView, Song } from '@shared/types';

import { ConfirmService } from '../../core/confirm.service';
import { clockText } from '../../core/format';
import { desktop } from '../../core/hub.service';
import { LibraryService } from '../../core/library.service';
import { OfflineService } from '../../core/offline.service';
import { PlayerService } from '../../core/player.service';

/**
 * Playlists: the songs somebody kept. Pick a playlist on the left; its songs
 * play in the order on the right (move them up and down to change it). A song
 * lives while some playlist holds it, so taking it out of its last playlist
 * deletes it — and the page says so before it does.
 */
@Component({
  selector: 'app-playlists-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="layout">
      <aside class="lists">
        <div class="label">Playlists</div>
        @for (playlist of library.playlists(); track playlist.id) {
          <button type="button" class="pick" [class.on]="selected()?.id === playlist.id" (click)="chosen.set(playlist.id)">
            <span class="name">{{ playlist.name }}</span>
            <span class="n">{{ playlist.songs.length }}</span>
          </button>
        } @empty {
          <p class="hint">No playlists yet. Save a song from the playing list, or make one here.</p>
        }
        <form class="new" (submit)="$event.preventDefault(); create()">
          <input type="text" maxlength="120" placeholder="New playlist" [value]="newName()" (input)="newName.set($any($event.target).value)" />
          <button type="submit" class="ghost small" [disabled]="newName().trim() === ''">Make</button>
        </form>
      </aside>

      <section class="songs">
        @if (selected(); as playlist) {
          <div class="head">
            @if (renaming() === 'playlist') {
              <input type="text" class="rename" maxlength="120" [value]="playlist.name"
                     (keydown.enter)="renamePlaylist(playlist, $any($event.target).value)"
                     (keydown.escape)="renaming.set(null)"
                     (blur)="renamePlaylist(playlist, $any($event.target).value)" />
            } @else {
              <h1>{{ playlist.name }}</h1>
            }
            <span class="spacer"></span>
            <button type="button" class="primary small" [disabled]="songs().length === 0" (click)="player.playPlaylist(playlist.id)">Play</button>
            <button type="button" class="ghost small" (click)="renaming.set('playlist')">Rename</button>
            <button type="button" class="ghost small" (click)="deletePlaylist(playlist)">Delete</button>
          </div>
          <p class="hint">{{ songs().length }} {{ songs().length === 1 ? 'song' : 'songs' }}{{ total() }}</p>
          @if (offline.offered()) {
            <label class="keep">
              <input type="checkbox" [checked]="offline.kept().has(playlist.id)" (change)="offline.keep(playlist.id, $any($event.target).checked)" />
              <span>Keep on this phone</span>
              @if (offline.kept().has(playlist.id)) {
                <span class="hint">{{ offline.countOn(playlist.songs) }} of {{ playlist.songs.length }} on the phone{{ offline.busy() ? ' — saving…' : '' }}</span>
              }
            </label>
            @if (offline.problem(); as trouble) { <div class="notice">{{ trouble }}</div> }
          }
          <div class="list">
            @for (song of songs(); track song.id; let at = $index) {
              <div class="item" [class.current]="isCurrent(song)" (click)="play(playlist, song, $event)">
                <span class="num">{{ at + 1 }}</span>
                <div class="main">
                  @if (renaming() === song.id) {
                    <input type="text" class="rename" maxlength="200" [value]="song.title"
                           (keydown.enter)="renameSong(song, $any($event.target).value)"
                           (keydown.escape)="renaming.set(null)"
                           (blur)="renameSong(song, $any($event.target).value)" />
                  } @else {
                    <div class="title">
                      @if (isCurrent(song)) { <span class="now">{{ player.paused() ? '❚❚' : '▶︎' }}</span> }
                      {{ song.title }}
                    </div>
                  }
                  <div class="sub">{{ song.params.tags ?? '' }}</div>
                  <div class="meta">
                    {{ clock(song.durationS) }}
                    @if (song.params.seed !== null) { · seed {{ song.params.seed }} }
                    @if (song.params.instrumental) { · instrumental }
                    @if (alsoIn(song, playlist); as others) { · also in {{ others }} }
                  </div>
                </div>
                <div class="actions">
                  <button type="button" class="icon" title="Move up" [disabled]="at === 0" (click)="move(playlist, at, -1)">↑</button>
                  <button type="button" class="icon" title="Move down" [disabled]="at === songs().length - 1" (click)="move(playlist, at, 1)">↓</button>
                  <button type="button" class="icon" title="Rename" (click)="renaming.set(song.id)">✎</button>
                  @if (isDesktop) {
                    <button type="button" class="icon" title="Save a copy…" (click)="saveCopy(song)">⤓</button>
                    <button type="button" class="icon" title="Show in folder" (click)="reveal(song)">⌂</button>
                  }
                  <button type="button" class="icon" title="Take it out of this playlist" (click)="removeSong(playlist, song)">×</button>
                </div>
              </div>
            } @empty {
              <p class="hint">Nothing in it yet. Use Save on a song in the playing list.</p>
            }
          </div>
        } @else {
          <p class="hint pad">Choose a playlist.</p>
        }
        @if (refusal(); as refused) {
          <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
        }
      </section>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); height: 100%; }
    .lists {
      display: flex; flex-direction: column; gap: 4px; padding: 14px 12px; overflow-y: auto;
      border-right: 1px solid var(--border-subtle); background: var(--bg-sunken);
    }
    .pick {
      display: flex; align-items: center; gap: 8px; justify-content: space-between;
      height: 30px; padding: 0 10px; border: 0; background: transparent; text-align: left; font-size: 12.5px;
    }
    .pick.on { background: var(--accent-faint); color: var(--accent); }
    .pick .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pick .n { font-size: 11px; color: var(--text-tertiary); }
    .new { display: flex; gap: 6px; margin-top: 8px; }
    .new input { flex: 1; min-width: 0; height: 26px; font-size: 12px; }
    .songs { display: flex; flex-direction: column; gap: 8px; padding: 16px 20px; overflow-y: auto; min-height: 0; }
    .head { display: flex; align-items: center; gap: 6px; }
    h1 { font-size: 18px; margin: 0; }
    .spacer { flex: 1; }
    .list { display: flex; flex-direction: column; gap: 6px; }
    .item {
      display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; cursor: pointer;
      border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-elevated);
    }
    .item:hover { border-color: var(--border-default); }
    .item.current { border-color: var(--audio); background: var(--audio-soft); }
    .num { color: var(--text-tertiary); font-size: 12px; min-width: 18px; padding-top: 1px; font-variant-numeric: tabular-nums; }
    .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .title { font-size: 12.5px; font-weight: 600; overflow-wrap: anywhere; }
    .now { color: var(--audio); margin-right: 4px; font-size: 10px; }
    .sub { font-size: 11.5px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta { font-size: 11.5px; color: var(--text-secondary); }
    .rename { padding: 3px 6px; font-size: 12.5px; }
    .actions { display: flex; gap: 2px; }
    .icon {
      border: 0; background: transparent; color: var(--text-tertiary);
      font-size: 14px; line-height: 1; padding: 3px 5px; border-radius: var(--radius-sm);
    }
    .icon:hover:not(:disabled) { color: var(--accent); background: var(--bg-hover); }
    .pad { padding: 8px 0; }
    .keep { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
    @media (max-width: 700px) {
      .layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
      .lists { border-right: 0; border-bottom: 1px solid var(--border-subtle); max-height: 40vh; }
      .songs { padding: 12px 16px; }
    }
  `],
})
export class PlaylistsPageComponent {
  protected readonly library = inject(LibraryService);
  protected readonly player = inject(PlayerService);
  protected readonly offline = inject(OfflineService);
  private readonly confirm = inject(ConfirmService);
  protected readonly isDesktop = desktop !== null;

  protected readonly chosen = signal<string | null>(null);
  protected readonly newName = signal('');
  protected readonly renaming = signal<string | null>(null);
  protected readonly refusal = signal<RefusalView | null>(null);

  /** The chosen playlist, else the first one. */
  protected readonly selected = computed<Playlist | null>(() => {
    const playlists = this.library.playlists();
    return playlists.find((playlist) => playlist.id === this.chosen()) ?? playlists[0] ?? null;
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
    return seconds === null ? 'length unknown' : clockText(seconds);
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
    this.chosen.set(made.id);
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
    this.chosen.set(null);
  }

  protected async saveCopy(song: Song): Promise<void> {
    this.refusal.set(await this.library.saveCopy(song));
  }

  protected async reveal(song: Song): Promise<void> {
    this.refusal.set(await this.library.reveal(song));
  }
}
