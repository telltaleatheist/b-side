import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { SINGLES_NAME, type AlbumMeta, type AlbumStage, type Playlist, type RefusalView, type Song } from '@shared/types';

import { CoverComponent } from '../../components/cover/cover.component';
import { IconComponent } from '../../components/icon/icon.component';
import { albumProgress, coverNote } from '../../core/album-progress';
import { CloudService } from '../../core/cloud.service';
import { ConfirmService } from '../../core/confirm.service';
import { clockText } from '../../core/format';
import { desktop, HubService } from '../../core/hub.service';
import { LibraryService } from '../../core/library.service';
import { OfflineService } from '../../core/offline.service';
import { jobCancellable, jobEnded, jobShare, jobStatus, jobTitle } from '../../core/job-status';
import { JobsService } from '../../core/jobs.service';
import { PeersService, peerId } from '../../core/peers.service';
import { PlayerService } from '../../core/player.service';
import { RefusalComponent } from '../../components/refusal/refusal.component';

/**
 * The library: every playlist as a cover (`/library`), and one playlist's page
 * (`/library/<id>`) with its songs in play order. A song lives while some
 * playlist holds it, so taking it out of its last playlist deletes it — and
 * the page says so before it does.
 */
@Component({
  selector: 'app-playlists-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RefusalComponent, RouterLink, CoverComponent, IconComponent],
  template: `
    <div class="page" [attr.data-drop-playlist]="remote() ? null : (selected()?.id ?? null)">
      @if (selected(); as playlist) {
        <a class="back" routerLink="/library"><app-icon name="chevron" [size]="16" class="flip" />Library</a>
        <header class="head">
          <app-cover class="head-art" [key]="playlist.id" [src]="coverOf(playlist)" />
          <div class="head-text">
            @if (isPeer()) {
              <span class="kicker">{{ playlist.album ? 'Album' : 'Playlist' }} · in {{ peerName() }}'s library</span>
            } @else if (isCloud()) {
              <span class="kicker">{{ playlist.album ? 'Album' : 'Playlist' }} · in the cloud on {{ cloud.host() }}</span>
            } @else if (playlist.album; as album) {
              <span class="kicker" [class.amber]="busy(album.stage) && !interrupted(album)">Album · {{ interrupted(album) ? 'interrupted' : stageWords(album.stage) }}</span>
            } @else {
              <span class="kicker">Playlist</span>
            }
            @if (renaming() === 'playlist') {
              <input type="text" class="rename big" maxlength="120" aria-label="Playlist name" [value]="playlist.name"
                     (keydown.enter)="renamePlaylist(playlist, $any($event.target).value)"
                     (keydown.escape)="renaming.set(null)"
                     (blur)="renamePlaylist(playlist, $any($event.target).value)" />
            } @else {
              <h1 class="head-title">{{ playlist.name }}@if (canRewrite(playlist)) {<button type="button" class="icon-btn reroll" aria-label="A new album title" title="A new title, written by the album's model" [disabled]="rewriting() !== null" (click)="rewrite(playlist, 'title')"><app-icon name="reroll" [size]="18" /></button>}</h1>
            }
            @if (playlist.album; as album) {
              @if (album.artist) {
                <span class="head-artist">{{ album.artist }}@if (canRewrite(playlist)) {<button type="button" class="icon-btn reroll" aria-label="A new artist" title="A new artist, written by the album's model" [disabled]="rewriting() !== null" (click)="rewrite(playlist, 'artist')"><app-icon name="reroll" [size]="14" /></button>}</span>
              }
              @if (rewriting(); as what) { <span class="hint">Writing {{ what }} again…</span> }
              @if (album.blurb) { <span class="head-blurb">{{ album.blurb }}</span> }
              @if (album.plan?.core || album.ask.tags.length) {
                <span class="head-sound"><span class="kicker">Sound</span> {{ album.plan?.core || album.ask.tags.join(', ') }}</span>
              }
              <span class="head-sub">{{ album.ask.sung ? 'Sung' : 'Instrumental' }} · {{ songs().length }} {{ songs().length === 1 ? 'track' : 'tracks' }}@if (album.stage === 'done') { · <strong class="runtime">runs {{ runtime() }}</strong> (asked for {{ album.ask.minutes }} min)} @else { · {{ runtime() }} of {{ album.ask.minutes }} min}@if (album.writer) { · written by {{ album.writer }}}@if (album.lyricsBy) {, lyrics by {{ album.lyricsBy }}}</span>
              @if (busy(album.stage) && !interrupted(album)) {
                @let progress = albumProgress(album);
                <div class="progress-line">
                  <span class="progress-label">{{ progress.label }}</span>
                  @if (!progress.waiting) { <span class="mono progress-pct">{{ Math.round(progress.share * 100) }}%</span> }
                </div>
                <div class="bar album-bar" [class.indeterminate]="progress.waiting"><span [style.width.%]="progress.waiting ? null : progress.share * 100"></span></div>
              }
              @if (coverNote(album); as note) { <span class="hint">{{ note }}</span> }
              @if (album.refusal; as refused) {
                <app-refusal [refusal]="refused" />
              }
            } @else {
              <span class="head-sub">{{ songs().length }} {{ songs().length === 1 ? 'song' : 'songs' }}{{ total() }}</span>
            }
            <div class="head-actions">
              <button type="button" class="primary" [disabled]="songs().length === 0" (click)="playAll(playlist)"><app-icon name="play" [size]="18" />Play</button>
              <button type="button" class="icon-btn outlined" aria-label="Play next" title="Play next: right after the song playing" [disabled]="songs().length === 0"
                      (click)="queue(playlist, true)"><app-icon name="play-next" [size]="18" /></button>
              <button type="button" class="icon-btn outlined" aria-label="Add to queue" title="Add to queue: at the end" [disabled]="songs().length === 0"
                      (click)="queue(playlist, false)"><app-icon name="queue-add" [size]="18" /></button>
              @if (!remote() && cloud.linked() && playlist.album && !busy(playlist.album.stage)) {
                <button type="button" class="ghost" [disabled]="cloud.saving() !== null" (click)="saveToCloud(playlist)">
                  <app-icon name="cloud" [size]="18" />{{ cloud.saving()?.playlist === playlist.id ? 'Saving ' + cloud.saving()!.done + ' of ' + cloud.saving()!.of + '…' : 'Save to cloud' }}
                </button>
              }
              @if (!remote() && canContinue()) {
                <button type="button" class="ghost" (click)="continueAlbum(playlist)"><app-icon name="play-next" [size]="18" />{{ playlist.album?.stage === 'done' ? 'Make the missing tracks' : 'Continue making it' }}</button>
              }
              @if (!remote() && playlist.album && busy(playlist.album.stage) && !interrupted(playlist.album)) {
                <button type="button" class="ghost stop" (click)="stopAlbum(playlist)"><app-icon name="close" [size]="16" />Stop making it</button>
              }
              @if (canRewrite(playlist)) {
                <button type="button" class="ghost" [disabled]="rewriting() !== null" title="The album's model describes the cover again; the image model, when the server has one, paints it" (click)="rewrite(playlist, 'cover')"><app-icon name="reroll" [size]="16" />New cover</button>
              }
              @if (!remote()) {
                <button type="button" class="icon-btn outlined" aria-label="Rename" title="Rename" (click)="renaming.set('playlist')"><app-icon name="edit" [size]="18" /></button>
              }
              @if (!isPeer()) {
              <button type="button" class="icon-btn outlined" [attr.aria-label]="isCloud() ? 'Delete from the cloud' : 'Delete'" [title]="isCloud() ? 'Delete from the cloud' : 'Delete'" (click)="deletePlaylist(playlist)"><app-icon name="trash" [size]="18" /></button>
              }
            </div>
          </div>
        </header>
        @if (!isPeer() && offline.offered() && (isCloud() || !hub.onPhone())) {
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
                @if (moving() === song.id) {
                  <div class="move-menu">
                    <span class="kicker">Move to</span>
                    @for (target of moveTargets(playlist); track target.id) {
                      <button type="button" class="ghost small" (click)="moveSong(playlist, song, target)">{{ target.name }}</button>
                    }
                    <button type="button" class="ghost small" (click)="moving.set(null)">Cancel</button>
                  </div>
                }
              </div>
              <span class="mono time">{{ clock(song.durationS) }}</span>
              <div class="actions">
                <button type="button" class="icon-btn" aria-label="Play next" title="Play next" (click)="queue(playlist, true, song)"><app-icon name="play-next" [size]="18" /></button>
                <button type="button" class="icon-btn" aria-label="Add to queue" title="Add to queue" (click)="queue(playlist, false, song)"><app-icon name="queue-add" [size]="18" /></button>
              @if (!remote()) {
                <button type="button" class="icon-btn" aria-label="Move up" title="Move up" [disabled]="at === 0" (click)="move(playlist, at, -1)"><app-icon name="down" [size]="18" class="flip-v" /></button>
                <button type="button" class="icon-btn" aria-label="Move down" title="Move down" [disabled]="at === songs().length - 1" (click)="move(playlist, at, 1)"><app-icon name="down" [size]="18" /></button>
                <button type="button" class="icon-btn" aria-label="Rename" title="Rename" (click)="renaming.set(song.id)"><app-icon name="edit" [size]="16" /></button>
                @if (canRewrite(playlist) && trackPlace(playlist, song.title) !== null) {
                  <button type="button" class="icon-btn" aria-label="A new name" title="A new name, written by the album's model" [disabled]="rewriting() !== null" (click)="rewrite(playlist, 'track', trackPlace(playlist, song.title)!)"><app-icon name="reroll" [size]="16" /></button>
                }
                @if (!playlist.album && moveTargets(playlist).length > 0) {
                  <button type="button" class="icon-btn" aria-label="Move to another playlist" title="Move to another playlist" (click)="moving.set(moving() === song.id ? null : song.id)"><app-icon name="library" [size]="17" /></button>
                }
                @if (isDesktop) {
                  <button type="button" class="icon-btn" aria-label="Save a copy" title="Save a copy…" (click)="saveCopy(song)"><app-icon name="save" [size]="18" /></button>
                  <button type="button" class="icon-btn" aria-label="Show in folder" title="Show in folder" (click)="reveal(song)"><app-icon name="library" [size]="18" /></button>
                }
                <button type="button" class="icon-btn" aria-label="Take it out of this playlist" title="Take it out of this playlist" (click)="removeSong(playlist, song)"><app-icon name="close" [size]="18" /></button>
              }
              </div>
            </div>
          } @empty {
            @if (!playlist.album && making().length === 0) { <p class="hint">Nothing in it yet. Songs you make land in {{ singlesName }}; move one here from there.</p> }
          }
          @for (job of making(); track job.key; let at = $index) {
            <div class="item upcoming song-making" [class.making]="!jobEnded(job)">
              <span class="num mono">{{ (songs().length + at + 1 < 10 ? '0' : '') + (songs().length + at + 1) }}</span>
              <div class="main">
                <div class="title">{{ jobTitle(job) }}</div>
                <div class="sub">{{ job.params.tags ?? '' }}</div>
                @if (!jobEnded(job)) {
                  <div class="bar making-bar" [class.indeterminate]="jobShare(job) === null"><span [style.width.%]="(jobShare(job) ?? 0) * 100"></span></div>
                }
                <div class="meta" [class.amber]="!jobEnded(job)">{{ jobStatus(job, jobs.now()) }}</div>
                @if (job.refusal; as refused) {
                  <app-refusal [refusal]="refused" />
                }
              </div>
              <div class="actions shown">
                @if (jobCancellable(job)) {
                  <button type="button" class="icon-btn" aria-label="Cancel" title="Cancel" (click)="jobs.cancel(job.key)"><app-icon name="close" [size]="18" /></button>
                } @else if (jobEnded(job)) {
                  <button type="button" class="icon-btn" aria-label="Dismiss" title="Dismiss" (click)="jobs.dismiss(job.key)"><app-icon name="trash" [size]="16" /></button>
                }
              </div>
            </div>
          }
          @for (row of upcoming(); track row.index) {
            <div class="item upcoming" [class.making]="row.making">
              <span class="num mono">{{ (row.index + 1 < 10 ? '0' : '') + (row.index + 1) }}</span>
              <div class="main">
                <div class="title">{{ row.title }}</div>
                <div class="sub">{{ row.tags }}</div>
              </div>
              <span class="mono time">{{ row.state }}</span>
              @if (canRewrite(playlist)) {
                <div class="actions shown">
                  <button type="button" class="icon-btn" aria-label="A new name" title="A new name, written by the album's model" [disabled]="rewriting() !== null" (click)="rewrite(playlist, 'track', row.index)"><app-icon name="reroll" [size]="16" /></button>
                </div>
              }
            </div>
          }
          @if (playlist.album?.stage === 'planning') {
            <p class="hint">Everything is written and painted first: the names, tags{{ playlist.album?.ask?.sung ? ', lyrics' : '' }} and the cover. The music starts once it is all ready.</p>
          }
        </div>
      } @else {
        <div class="title-row">
          <h1 class="page-title">Library</h1>
        </div>
        @if (cloud.linked()) { <h2 class="section-title">On this phone</h2> }
        <div class="grid">
          @for (playlist of library.playlists(); track playlist.id) {
            <a class="tile" [routerLink]="['/library', playlist.id]" [attr.data-drop-playlist]="playlist.id">
              <app-cover class="tile-art" [key]="playlist.id" [src]="hub.coverUrl(playlist)" />
              <span class="tile-name">{{ playlist.name }}</span>
              @if (playlist.album; as album) {
                <span class="tile-sub" [class.amber]="busy(album.stage) && !interrupted(album)">{{ album.artist || 'Album' }}{{ interrupted(album) ? ' · interrupted' : busy(album.stage) ? ' · ' + stageWords(album.stage) : '' }}</span>
                @if (busy(album.stage) && !interrupted(album)) {
                  <div class="bar tile-bar album-bar" [class.indeterminate]="albumProgress(album).waiting"><span [style.width.%]="albumProgress(album).waiting ? null : albumProgress(album).share * 100"></span></div>
                }
              } @else {
                <span class="tile-sub">{{ playlist.songs.length }} {{ playlist.songs.length === 1 ? 'song' : 'songs' }}</span>
              }
            </a>
          } @empty {
            <p class="hint">{{ cloud.linked() ? 'Nothing kept only on this phone.' : 'No playlists yet. Save a song from the playing list, or make one here.' }}</p>
          }
        </div>
        @for (peer of peers.present(); track peer.url) {
          <div class="cloud-head">
            <h2 class="section-title">{{ peers.name(peer) }}'s library</h2>
            <span class="mono hint">{{ peer.library?.songs?.length ?? 0 }} songs · on the network</span>
          </div>
          <div class="grid">
            @for (playlist of peer.library?.playlists ?? []; track playlist.id) {
              <a class="tile" [routerLink]="['/peer', peerId(peer), playlist.id]">
                <app-cover class="tile-art" [key]="playlist.id" [src]="peers.coverUrl(peerId(peer), playlist)" />
                <span class="tile-name">{{ playlist.name }}</span>
                <span class="tile-sub">{{ playlist.album ? (playlist.album.artist || 'Album') : playlist.songs.length + (playlist.songs.length === 1 ? ' song' : ' songs') }}</span>
              </a>
            } @empty {
              <p class="hint">Nothing in it yet.</p>
            }
          </div>
        }
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
        <app-refusal [refusal]="refused" />
      }
    </div>
  `,
  styles: [`
    .move-menu { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-top: 6px; }
    .actions.shown { opacity: 1; }
    .song-making .meta { font-size: 12px; color: var(--text-tertiary); }
    .song-making .meta.amber { color: var(--audio); }
    .making-bar { margin-top: 6px; }
    .making-bar > span { background: var(--audio); }
    .runtime { color: var(--text-primary); font-weight: 700; }
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
    .reroll { display: inline-flex; vertical-align: middle; margin-left: 6px; opacity: .55; }
    .reroll:hover:not(:disabled) { opacity: 1; }
    .head-sound { font-size: 13px; color: var(--text-secondary); }
    .ghost.stop { border-color: var(--audio); color: var(--audio); }
    .head-blurb { font-size: 14px; color: var(--text-secondary); font-style: italic; }
    .amber { color: var(--audio) !important; }
    .progress-line { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-top: 10px; font-size: 13px; color: var(--text-dim, inherit); }
    .progress-pct { font-size: 12px; opacity: .8; }
    .tile-bar { margin-top: 6px; height: 3px; }
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
  protected readonly jobs = inject(JobsService);
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
  protected readonly peers = inject(PeersService);
  /** `/peer/<host>/<id>`: a playlist in another B-Sides library on the network, read and played from there. */
  protected readonly isPeer = toSignal(this.route.data.pipe(map((data) => data['peer'] === true)), { initialValue: false });
  private readonly peerKey = toSignal(this.route.paramMap.pipe(map((params) => params.get('peer') ?? '')), { initialValue: '' });
  /** Not this library's own: nothing on it is edited from here. */
  protected readonly remote = computed(() => this.isCloud() || this.isPeer());
  protected readonly peerName = computed(() => {
    const peer = this.peers.byId(this.peerKey());
    return peer === null ? this.peerKey() : this.peers.name(peer);
  });
  protected readonly peerId = peerId;
  protected readonly newName = signal('');
  protected readonly renaming = signal<string | null>(null);
  /** Which piece of the album its model is writing again (a sentence's noun), or null. */
  protected readonly rewriting = signal<string | null>(null);
  protected readonly refusal = signal<RefusalView | null>(null);

  protected readonly selected = computed<Playlist | null>(() => {
    const id = this.chosen();
    if (id === null) return null;
    if (this.isPeer()) return this.peers.playlist(this.peerKey(), id);
    return this.isCloud() ? this.cloud.playlist(id) : (this.library.playlist(id) ?? null);
  });

  protected readonly songs = computed(() => {
    const playlist = this.selected();
    if (playlist === null) return [];
    if (this.isPeer()) return this.peers.songsOf(this.peerKey(), playlist);
    return this.isCloud() ? this.cloud.songsOf(playlist) : this.library.songsOf(playlist);
  });

  protected readonly total = computed(() => {
    const seconds = this.songs().reduce((sum, song) => sum + (song.durationS ?? 0), 0);
    return seconds > 0 ? `, ${clockText(seconds)}` : '';
  });

  /** An album's planned tracks not made yet: the ones on the server, then the ones waiting. */
  protected readonly upcoming = computed(() => {
    const album = this.selected()?.album;
    if (album?.plan == null) return [];
    // Interrupted (the stage says making, but nothing is): its rows are not being made.
    const busy = this.busy(album.stage) && !this.interrupted(album);
    const made = new Set(this.songs().map((song) => song.title));
    const redo = new Set(album.redo ?? []);
    return album.plan.tracks
      .map((track, index) => {
        const making = busy && index < album.sent && !redo.has(index);
        const state = making ? 'making' : busy ? 'waiting' : 'not made';
        return { index, title: track.title, tags: track.tags, making, state, lost: index < album.sent };
      })
      // Stopped or done: only the tracks it set out to make and has no song for (one past the length was never meant).
      // Making: every track left. Otherwise only the ones it set out to make and has no song for, and
      // the rest of the plan only while the album is short of its length (past it, they were never needed).
      .filter((row) => !made.has(row.title) && (busy || row.lost || album.madeS < album.ask.minutes * 60));
  });

  /** The album's real length: its songs added up. */
  protected readonly runtime = computed(() => clockText(this.songs().reduce((sum, song) => sum + (song.durationS ?? 0), 0)));

  /** An album that did not finish (stopped, failed, or done with tracks missing) can carry on. */
  protected readonly canContinue = computed(() => {
    const album = this.selected()?.album;
    if (album == null || (this.busy(album.stage) && !this.interrupted(album))) return false;
    if (album.plan === null) return album.stage !== 'done';
    return this.upcoming().length > 0;
  });

  protected async continueAlbum(playlist: Playlist): Promise<void> {
    const outcome = await this.hub.call<unknown>('POST', `/api/albums/${encodeURIComponent(playlist.id)}/resume`);
    this.refusal.set(outcome.ok ? null : outcome.refusal);
  }

  /**
   * Its stage says it is being made, but nothing is (no writing, no track on
   * the server): it was interrupted, and Continue takes over from Stop.
   */
  protected interrupted(album: AlbumMeta): boolean {
    return this.busy(album.stage) && album.working === false;
  }

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

  protected readonly albumProgress = albumProgress;
  protected readonly coverNote = coverNote;
  protected readonly Math = Math;

  /** This device's songs being made into the playlist on show (New Songs), after its songs. */
  protected readonly making = computed(() => {
    const id = this.selected()?.id;
    return id === undefined ? [] : this.jobs.jobs().filter((job) => job.playlist === id);
  });
  protected readonly moving = signal<string | null>(null);
  protected readonly singlesName = SINGLES_NAME;
  protected readonly jobEnded = jobEnded;
  protected readonly jobTitle = jobTitle;
  protected readonly jobShare = jobShare;
  protected readonly jobStatus = jobStatus;
  protected readonly jobCancellable = jobCancellable;

  /** Where a song can move: every other playlist that is not an album. */
  protected moveTargets(from: Playlist): Playlist[] {
    return this.library.playlists().filter((playlist) => playlist.id !== from.id && playlist.album == null);
  }

  protected async moveSong(from: Playlist, song: Song, to: Playlist): Promise<void> {
    this.moving.set(null);
    const added = await this.library.addSong(to.id, song.id);
    this.refusal.set(added ?? (await this.library.removeSong(from.id, song.id)));
  }

  protected async stopAlbum(playlist: Playlist): Promise<void> {
    const outcome = await this.hub.call<unknown>('POST', `/api/albums/${encodeURIComponent(playlist.id)}/stop`);
    this.refusal.set(outcome.ok ? null : outcome.refusal);
  }

  protected clock(seconds: number | null): string {
    return seconds === null ? '–:––' : clockText(seconds);
  }

  protected isCurrent(song: Song): boolean {
    const key = this.isPeer() ? `peer:${this.peerKey()}:${song.id}` : `${this.isCloud() ? 'cloud' : 'song'}:${song.id}`;
    return this.player.current()?.key === key;
  }

  protected alsoIn(song: Song, here: Playlist): string | null {
    if (this.remote()) return null;
    const others = this.library.holding(song.id).filter((playlist) => playlist.id !== here.id).map((playlist) => playlist.name);
    return others.length === 0 ? null : others.join(', ');
  }

  /** Play next (`next`) or Add to queue: the whole playlist, or one song of it. */
  protected queue(playlist: Playlist, next: boolean, song?: Song): void {
    const items = this.player.itemsOf(playlist.id, this.isCloud(), song === undefined ? undefined : [song], this.isPeer() ? this.peerKey() : undefined);
    if (next) this.player.playNext(items, playlist.name);
    else this.player.addToQueue(items, playlist.name);
  }

  protected play(playlist: Playlist, song: Song, event: MouseEvent): void {
    if ((event.target as HTMLElement).closest('button, input')) return;
    if (this.isPeer()) this.player.playPeer(this.peerKey(), playlist.id, song);
    else if (this.isCloud()) this.player.playCloud(playlist.id, song);
    else this.player.playPlaylist(playlist.id, song);
  }

  protected playAll(playlist: Playlist): void {
    if (this.isPeer()) this.player.playPeer(this.peerKey(), playlist.id);
    else if (this.isCloud()) this.player.playCloud(playlist.id);
    else this.player.playPlaylist(playlist.id);
  }

  protected coverOf(playlist: Playlist): string | null {
    if (this.isPeer()) return this.peers.coverUrl(this.peerKey(), playlist);
    return this.isCloud() ? this.cloud.coverUrl(playlist) : this.hub.coverUrl(playlist);
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

  /** An album on this computer, planned, and not being written: its pieces can be written again. */
  protected canRewrite(playlist: Playlist): boolean {
    const album = playlist.album;
    if (this.remote() || album == null || album.plan === null) return false;
    if (album.plan.tracks.length < (album.plan.trackCount ?? 0)) return false;
    return album.stage !== 'planning' || this.interrupted(album);
  }

  /** A song's place in its album's plan, by its name; null when the plan has no track by that name. */
  protected trackPlace(playlist: Playlist, title: string): number | null {
    const at = playlist.album?.plan?.tracks.findIndex((track) => track.title.toLowerCase() === title.toLowerCase()) ?? -1;
    return at < 0 ? null : at;
  }

  /** Have the album's model write one piece again: its title, its artist, its cover, or a track's name. */
  protected async rewrite(playlist: Playlist, piece: 'title' | 'artist' | 'cover' | 'track', track?: number): Promise<void> {
    this.rewriting.set(piece === 'title' ? 'the title' : piece === 'artist' ? 'the artist' : piece === 'cover' ? 'the cover' : "a track's name");
    const outcome = await this.hub.call<unknown>('POST', `/api/albums/${encodeURIComponent(playlist.id)}/regenerate`, { piece, ...(track === undefined ? {} : { track }) });
    this.rewriting.set(null);
    this.refusal.set(outcome.ok ? null : outcome.refusal);
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
