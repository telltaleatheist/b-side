import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, HostListener, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { INSTRUMENTAL_SUFFIX, SINGLES_NAME, type AlbumMeta, type AlbumStage, type Folder, type JobView, type Playlist, type RefusalView, type Song } from '@shared/types';

import { CoverComponent } from '../../components/cover/cover.component';
import { FolderMoveComponent } from '../../components/folder-move/folder-move.component';
import { NeedsCrucibleComponent } from '../../components/needs-crucible/needs-crucible.component';
import { FoldersService, type DropTarget, type ShelfItem } from '../../core/folders.service';
import { IconComponent } from '../../components/icon/icon.component';
import { albumProgress, coverNote } from '../../core/album-progress';
import { CloudService } from '../../core/cloud.service';
import { ConfirmService } from '../../core/confirm.service';
import { clockText } from '../../core/format';
import { desktop, HubService } from '../../core/hub.service';
import { LibraryService } from '../../core/library.service';
import { StudioService } from '../../core/studio.service';
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
/** The largest cover kept from the person's own image, in pixels square. */
const COVER_PX = 768;

@Component({
  selector: 'app-playlists-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RefusalComponent, RouterLink, CoverComponent, IconComponent, NgTemplateOutlet, FolderMoveComponent, NeedsCrucibleComponent],
  template: `
    <div class="page" [attr.data-drop-playlist]="remote() ? null : (selected()?.id ?? null)">
      @if (selected(); as playlist) {
        <a class="back" routerLink="/library"><app-icon name="chevron" [size]="16" class="flip" />Library</a>
        <header class="head">
          @if (ownCover(playlist)) {
            <!-- Drop an image on the cover, paste one (Ctrl+V), or pick one: the album's own cover. -->
            <div class="head-art drop-cover" [class.over]="coverOver()" title="Drop an image here, or paste one, for the album's cover"
                 (dragover)="coverDragOver($event)" (dragleave)="coverOver.set(false)" (drop)="coverDrop(playlist, $event)">
              <app-cover [key]="playlist.id" [src]="coverOf(playlist)" />
            </div>
          } @else {
            <app-cover class="head-art" [key]="playlist.id" [src]="coverOf(playlist)" />
          }
          <div class="head-text">
            @if (isPeer()) {
              <span class="kicker">{{ playlist.album ? 'Album' : 'Playlist' }} · in {{ peerName() }}'s library</span>
            } @else if (isCloud()) {
              <span class="kicker">{{ playlist.album ? 'Album' : 'Playlist' }} · in the cloud on {{ cloud.host() }}</span>
            } @else if (playlist.album; as album) {
              <span class="kicker" [class.amber]="busy(album.stage) && !interrupted(album)">Album · {{ interrupted(album) ? 'interrupted' : album.remakeOnly ? 'making a new take' : stageWords(album.stage) }}{{ folderPath(playlist) }}</span>
            } @else {
              <span class="kicker">Playlist{{ folderPath(playlist) }}</span>
            }
            @if (renaming() === 'playlist') {
              <input type="text" class="rename big" maxlength="120" aria-label="Playlist name" [value]="playlist.name"
                     (keydown.enter)="renamePlaylist(playlist, $any($event.target).value)"
                     (keydown.escape)="renaming.set(null)"
                     (blur)="renamePlaylist(playlist, $any($event.target).value)" />
            } @else {
              <h1 class="head-title">{{ playlist.name }}@if (canRewrite(playlist)) {<button type="button" class="icon-btn reroll" aria-label="A new album title" title="A new title, written by the album's model" [disabled]="rewriting() !== null || hub.needsCrucible()" (click)="rewrite(playlist, 'title')"><app-icon name="reroll" [size]="18" /></button>}</h1>
            }
            @if (playlist.album; as album) {
              @if (album.artist) {
                <span class="head-artist">{{ album.artist }}@if (canRewrite(playlist)) {<button type="button" class="icon-btn reroll" aria-label="A new artist" title="A new artist, written by the album's model" [disabled]="rewriting() !== null || hub.needsCrucible()" (click)="rewrite(playlist, 'artist')"><app-icon name="reroll" [size]="14" /></button>}</span>
              }
              @if (rewriting(); as what) { <span class="hint">Writing {{ what }} again…</span> }
              @if (album.blurb) { <span class="head-blurb">{{ album.blurb }}</span> }
              @if (album.plan?.core || album.ask.tags.length) {
                <span class="head-sound"><span class="kicker">Sound</span> {{ album.plan?.core || album.ask.tags.join(', ') }}</span>
              }
              <span class="head-sub">{{ album.ask.sung ? 'Sung' : 'Instrumental' }} · {{ songs().length }} {{ songs().length === 1 ? 'track' : 'tracks' }}@if (album.stage === 'done' || album.remakeOnly === 'done') { · <strong class="runtime">runs {{ runtime() }}</strong> (asked for {{ album.ask.minutes }} min)} @else { · {{ runtime() }} of {{ album.ask.minutes }} min}@if (album.writer) { · words by {{ album.writer }}}@if (album.soundBy) {, sound by {{ album.soundBy }}} @else if (album.lyricsBy && album.lyricsBy !== album.writer) {, lyrics by {{ album.lyricsBy }}}</span>
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
              @if (album.remakeRefusal; as refused) {
                <app-refusal [refusal]="refused" />
              }
            } @else {
              <span class="head-sub">{{ songs().length }} {{ songs().length === 1 ? 'song' : 'songs' }}{{ total() }}</span>
            }
            <div class="head-actions">
              <button type="button" class="primary" [disabled]="songs().length === 0" (click)="playAll(playlist)"><app-icon name="play" [size]="18" />Play</button>
              @if (!remote()) {
                <button type="button" class="ghost" [disabled]="songs().length < 2" title="Play it in a random order" (click)="player.shufflePlaylist(playlist.id)"><app-icon name="shuffle" [size]="18" />Shuffle</button>
              }
              @if (!remote() && playlist.album && library.canSave) {
                <button type="button" class="ghost" [disabled]="songs().length === 0" title="Save the album as a zip: its songs in order, their lyrics, the cover" (click)="downloadAlbum(playlist)"><app-icon name="download" [size]="18" />Download</button>
              }
              <button type="button" class="icon-btn outlined" aria-label="Play next" title="Play next: right after the song playing" [disabled]="songs().length === 0"
                      (click)="queue(playlist, true)"><app-icon name="play-next" [size]="18" /></button>
              <button type="button" class="icon-btn outlined" aria-label="Add to queue" title="Add to queue: at the end" [disabled]="songs().length === 0"
                      (click)="queue(playlist, false)"><app-icon name="queue-add" [size]="18" /></button>
              @if (!remote()) {
                <!-- Every song with its voice taken out, into "<name> (Instrumental)" (Owen, 2026-10-11). -->
                <button type="button" class="ghost" [disabled]="songs().length === 0 || !canStrip() || versioning() !== null" [title]="stripTitle(playlist.album ? 'album' : 'playlist', playlist)" (click)="makeInstrumental(playlist)"><app-icon name="no-voice" [size]="18" />Instrumental version</button>
              }
              @if (!remote() && cloud.linked() && playlist.album && !busy(playlist.album.stage)) {
                <button type="button" class="ghost" [disabled]="cloud.saving() !== null" (click)="saveToCloud(playlist)">
                  <app-icon name="cloud" [size]="18" />{{ cloud.saving()?.playlist === playlist.id ? 'Saving ' + cloud.saving()!.done + ' of ' + cloud.saving()!.of + '…' : 'Save to cloud' }}
                </button>
              }
              @if (!remote() && canContinue()) {
                <button type="button" class="ghost" [disabled]="hub.needsCrucible()" (click)="continueAlbum(playlist)"><app-icon name="play-next" [size]="18" />{{ playlist.album?.stage === 'done' ? 'Make the missing tracks' : 'Continue making it' }}</button>
              }
              @if (!remote() && playlist.album && busy(playlist.album.stage) && !interrupted(playlist.album)) {
                <button type="button" class="ghost stop" (click)="stopAlbum(playlist)"><app-icon name="close" [size]="16" />Stop making it</button>
              }
              @if (!remote() && playlist.album && playlist.album.stage === 'making' && (playlist.album.waitingFor || playlist.album.takingTurns)) {
                <button type="button" class="ghost" [title]="playlist.album.waitingFor ? 'Make this album before the others on its computer; the songs already started for the one ahead still finish' : 'Give this album the very next turn'" (click)="makeNext(playlist)"><app-icon name="play-next" [size]="16" />Make this next</button>
              }
              @if (canRewrite(playlist)) {
                <button type="button" class="ghost" [disabled]="rewriting() !== null || hub.needsCrucible()" title="The album's model describes the cover again; the image model, when the server has one, paints it" (click)="rewrite(playlist, 'cover')"><app-icon name="reroll" [size]="16" />New cover</button>
                <button type="button" class="ghost" [disabled]="rewriting() !== null || hub.needsCrucible()" title="15 more minutes of this album: new songs at the end, same sound, names that are not already on it" (click)="extendAlbum(playlist)"><app-icon name="queue-add" [size]="16" />More like this</button>
              }
              @if (!remote() && playlist.album) {
                <button type="button" class="ghost" title="Open Make with this album's description and settings, to change and make a new album beside this one" (click)="remakeAlbum(playlist)"><app-icon name="reroll" [size]="16" />Make it again</button>
              }
              @if (ownCover(playlist)) {
                <label class="ghost file-pick" title="Pick an image for the cover; or drop one on the cover, or paste one">
                  <app-icon name="edit" [size]="16" />Your own cover
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden (change)="coverPicked(playlist, $event)" />
                </label>
              }
              @if (!remote()) {
                <button type="button" class="icon-btn outlined" aria-label="Rename" title="Rename" (click)="renaming.set('playlist')"><app-icon name="edit" [size]="18" /></button>
                <button type="button" class="icon-btn outlined" aria-label="Move to folder" title="Move to folder…" [attr.aria-expanded]="movingPlaylist()" (click)="movingPlaylist.set(!movingPlaylist())"><app-icon name="folder" [size]="18" /></button>
              }
              @if (!isPeer()) {
              <button type="button" class="icon-btn outlined" [attr.aria-label]="isCloud() ? 'Delete from the cloud' : 'Delete'" [title]="isCloud() ? 'Delete from the cloud' : 'Delete'" (click)="deletePlaylist(playlist)"><app-icon name="trash" [size]="18" /></button>
              }
            </div>
            @if (versionNote(); as note) {
              <span class="hint version-note">{{ note.text }}
                @if (note.id !== selected()?.id) {
                  <button type="button" class="chip" (click)="openPlaylist(note.id)">Open {{ note.name }}</button>
                }
              </span>
            }
            @if (versionRefusal(); as refused) {
              <app-refusal [refusal]="refused" />
            }
          </div>
        </header>
        @if (playlist.album && !remote()) {
          <!-- Its new names, cover, tracks and takes are all made on a server (Owen, 2026-10-11). -->
          <app-needs-crucible />
        }
        @if (movingPlaylist() && !remote()) {
          <app-folder-move [item]="shelfPlaylist(playlist.id)" (done)="movingPlaylist.set(false)" />
        }
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
                <div class="sub">{{ song.params.tags ?? '' }}@if (song.structure) { · structure {{ song.structure }} }@if (aimText(song); as aimed) { · {{ aimed }} }@if (alsoIn(song, playlist); as others) { · also in {{ others }} }</div>
                @if (remakeState(playlist, song); as remake) {
                  @if (remake.job; as job) {
                    <div class="bar making-bar" [class.indeterminate]="jobShare(job) === null"><span [style.width.%]="(jobShare(job) ?? 0) * 100"></span></div>
                  }
                  <div class="remake-note">{{ remake.text }}</div>
                }
                @if (remakeMenu() === song.id) {
                  <!-- Make this track again (Victoria, 2026-10-11): a new take in this one's place. -->
                  <div class="move-menu remake-menu">
                    <span class="kicker">Make this track again</span>
                    <button type="button" class="ghost small" title="The same tags and words, sung again with a new seed" (click)="remake(playlist, song, 'keep')">{{ sungTrack(playlist, song) ? 'Same lyrics, new take' : 'A new take' }}</button>
                    @if (sungTrack(playlist, song)) {
                      <button type="button" class="ghost small" title="The lyricist writes this track's words again, then it is made with them" (click)="remake(playlist, song, 'new')">New lyrics too</button>
                    }
                    <button type="button" class="ghost small" (click)="remakeMenu.set(null)">Cancel</button>
                    <span class="hint">This take plays until the new one is in. Then the new one takes its place, and this one moves to {{ singlesName }}.</span>
                  </div>
                }
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
                <button type="button" class="icon-btn narrow-keep" aria-label="Make an instrumental version" [title]="stripTitle('song', playlist)" [disabled]="!canStrip() || versioning() !== null" (click)="makeInstrumental(playlist, song)"><app-icon name="no-voice" [size]="17" /></button>
                @if (canRewrite(playlist) && trackPlace(playlist, song.title) !== null) {
                  <button type="button" class="icon-btn" aria-label="A new name" title="A new name, written by the album's model" [disabled]="rewriting() !== null || hub.needsCrucible()" (click)="rewrite(playlist, 'track', trackPlace(playlist, song.title)!)"><app-icon name="reroll" [size]="16" /></button>
                }
                @if (canRemake(playlist, song)) {
                  <button type="button" class="icon-btn narrow-keep" aria-label="Make this track again" title="Make this track again: a new take in this one's place" [attr.aria-expanded]="remakeMenu() === song.id" [disabled]="remakeState(playlist, song) !== null || hub.needsCrucible()" (click)="remakeMenu.set(remakeMenu() === song.id ? null : song.id)"><app-icon name="make" [size]="17" /></button>
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
                @if (trackJob(playlist, row.index); as job) {
                  <div class="bar making-bar" [class.indeterminate]="jobShare(job) === null"><span [style.width.%]="(jobShare(job) ?? 0) * 100"></span></div>
                  <div class="meta amber">{{ jobStatus(job, jobs.now()) }}</div>
                }
              </div>
              <span class="mono time">{{ row.state }}</span>
              @if (canRewrite(playlist)) {
                <div class="actions shown">
                  <button type="button" class="icon-btn" aria-label="A new name" title="A new name, written by the album's model" [disabled]="rewriting() !== null || hub.needsCrucible()" (click)="rewrite(playlist, 'track', row.index)"><app-icon name="reroll" [size]="16" /></button>
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
        <!-- Folders first, then what is at the top. Dropped in the open space here, an album or folder leaves its folder. -->
        <div class="shelf" [attr.data-drop]="folders.mark(top)" (dragover)="folders.over($event, top)" (drop)="dropOn($event, top)">
          <ng-container *ngTemplateOutlet="shelf; context: { $implicit: null }" />
          @if (library.playlists().length === 0 && library.folders().length === 0) {
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
              <p class="hint">Nothing in it yet.</p>
            }
          </div>
        }
        @if (hub.kind === 'ios') {
          <a class="add-library ghost small" routerLink="/settings">+ Add another B-Sides library</a>
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
        <form class="new" (submit)="$event.preventDefault(); createFolder(null)">
          <input type="text" maxlength="120" placeholder="New folder" aria-label="New folder name" [value]="newFolder()" (input)="newFolder.set($any($event.target).value)" />
          <button type="submit" class="ghost" [disabled]="newFolder().trim() === ''"><app-icon name="folder" [size]="16" />Make</button>
        </form>
      }
      @if (refusal(); as refused) {
        <app-refusal [refusal]="refused" />
      }
    </div>

    <!-- One level of the shelf: its folders (each holding the next level), then its albums and playlists. -->
    <ng-template #shelf let-parent>
      @for (folder of library.foldersIn(parent); track folder.id) {
        <section class="folder" [class.open]="folders.isOpen(folder.id)">
          <div class="folder-head" [attr.draggable]="hub.onPhone() || renamingFolder() === folder.id ? null : 'true'" [attr.data-drop]="folders.mark(edge(folder.id))"
               (dragstart)="folders.dragStart($event, shelfFolder(folder.id))" (dragend)="folders.dragEnd()"
               (dragover)="folders.over($event, edge(folder.id))" (drop)="dropOn($event, edge(folder.id))">
            @if (renamingFolder() === folder.id) {
              <input type="text" class="rename" maxlength="120" aria-label="Folder name" [value]="folder.name"
                     (keydown.enter)="renameFolder(folder, $any($event.target).value)"
                     (keydown.escape)="renamingFolder.set(null)"
                     (blur)="renameFolder(folder, $any($event.target).value)" />
            } @else {
              <button type="button" class="folder-toggle" [attr.aria-expanded]="folders.isOpen(folder.id)" [title]="folders.isOpen(folder.id) ? 'Close the folder' : 'Open the folder'" (click)="folders.toggle(folder.id)">
                <app-icon name="chevron" [size]="16" class="chev" />
                <app-icon name="folder" [size]="18" class="folder-icon" />
                <span class="folder-name">{{ folder.name }}</span>
                <span class="folder-count">{{ countText(folder.id) }}</span>
              </button>
            }
            <span class="folder-acts">
              <button type="button" class="icon-btn" aria-label="Play folder" title="Play folder: every album and playlist in it, in order" [disabled]="!hasSongs(folder.id)" (click)="player.playFolder(folder.id)"><app-icon name="play" [size]="18" /></button>
              <button type="button" class="icon-btn" aria-label="Shuffle folder" title="Shuffle folder: every song in it, in a random order" [disabled]="!hasSongs(folder.id)" (click)="player.shuffleFolder(folder.id)"><app-icon name="shuffle" [size]="18" /></button>
              <button type="button" class="icon-btn" aria-label="More for this folder" title="Rename, move or delete" [attr.aria-expanded]="folderMenu() === folder.id" (click)="folderMenu.set(folderMenu() === folder.id ? null : folder.id)"><app-icon name="more" [size]="18" /></button>
            </span>
          </div>
          @if (folderMenu() === folder.id) {
            <div class="folder-menu">
              <button type="button" class="ghost small" (click)="renamingFolder.set(folder.id); folderMenu.set(null)"><app-icon name="edit" [size]="15" />Rename</button>
              <button type="button" class="ghost small" (click)="movingFolder.set(folder.id); folderMenu.set(null)"><app-icon name="folder" [size]="15" />Move to folder…</button>
              @if (folders.roomInside(folder.id)) {
                <button type="button" class="ghost small" (click)="newFolderIn.set(folder.id); folderMenu.set(null)"><app-icon name="plus" [size]="15" />New folder in it</button>
              }
              <button type="button" class="ghost small" (click)="deleteFolder(folder)"><app-icon name="trash" [size]="15" />Delete folder</button>
            </div>
          }
          @if (newFolderIn() === folder.id) {
            <form class="new folder-new" (submit)="$event.preventDefault(); createFolder(folder.id)">
              <input type="text" maxlength="120" [placeholder]="'New folder in ' + folder.name" aria-label="New folder name" [value]="newFolder()" (input)="newFolder.set($any($event.target).value)" />
              <button type="submit" class="ghost small" [disabled]="newFolder().trim() === ''">Make</button>
              <button type="button" class="ghost small" (click)="newFolderIn.set(null)">Cancel</button>
            </form>
          }
          @if (movingFolder() === folder.id) {
            <app-folder-move [item]="shelfFolder(folder.id)" (done)="movingFolder.set(null)" />
          }
          @if (folders.isOpen(folder.id)) {
            <div class="folder-body" [attr.data-drop]="folders.mark(inside(folder.id))" (dragover)="folders.over($event, inside(folder.id))" (drop)="dropOn($event, inside(folder.id))">
              <ng-container *ngTemplateOutlet="shelf; context: { $implicit: folder.id }" />
              @if (library.foldersIn(folder.id).length === 0 && library.playlistsIn(folder.id).length === 0) {
                <p class="hint">Nothing in it yet. {{ hub.onPhone() ? 'Open an album or playlist and use Move to folder… to put it here.' : 'Drag albums and playlists here, or use Move to folder… on their pages.' }}</p>
              }
            </div>
          }
        </section>
      }
      @if (library.playlistsIn(parent).length > 0) {
        <div class="grid">
          @for (playlist of library.playlistsIn(parent); track playlist.id) {
            <a class="tile drop-x" [routerLink]="['/library', playlist.id]" [attr.data-drop-playlist]="playlist.id" [attr.data-drop]="folders.mark(onPlaylist(playlist.id))"
               (dragstart)="folders.dragStart($event, shelfPlaylist(playlist.id))" (dragend)="folders.dragEnd()"
               (dragover)="folders.over($event, onPlaylist(playlist.id), 'x')" (drop)="dropOn($event, onPlaylist(playlist.id), 'x')">
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
          }
        </div>
      }
    </ng-template>
  `,
  styles: [`
    .add-library { display: inline-flex; align-self: flex-start; margin-top: 4px; text-decoration: none; }
    .move-menu { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding-top: 6px; }
    .actions.shown { opacity: 1; }
    .song-making .meta { font-size: 12px; color: var(--text-tertiary); }
    .remake-note { font-size: 12px; color: var(--audio); }
    .remake-menu .hint { flex-basis: 100%; font-size: 12px; }
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
    .drop-cover { border-radius: 8px; outline: 2px dashed transparent; outline-offset: 4px; transition: outline-color .15s; }
    .drop-cover.over { outline-color: var(--accent, currentColor); }
    .file-pick { cursor: pointer; }
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
    /* Wraps onto more lines rather than running off the side (Victoria, 0.1.19: "I have to scroll back and forth"). */
    .head-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-top: 4px; min-width: 0; }
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
    /* Folders (Victoria, 2026-10-11): a section per folder, its contents indented beneath its header. */
    .shelf { display: flex; flex-direction: column; gap: 14px; min-height: 40px; }
    .folder { display: flex; flex-direction: column; gap: 10px; }
    .folder-head { display: flex; align-items: center; gap: 4px; min-width: 0; border-radius: var(--radius-md); }
    .folder-head[draggable='true'] { cursor: grab; }
    .folder-head .rename { flex: 1; min-width: 0; }
    .folder-toggle {
      flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 8px;
      border: none; border-radius: var(--radius-md); background: transparent; color: var(--text-primary); text-align: left; cursor: pointer;
    }
    .folder-toggle:hover { background: var(--bg-hover); }
    .chev { color: var(--text-tertiary); transition: transform .15s ease; }
    .folder.open > .folder-head .chev { transform: rotate(90deg); }
    .folder-icon { color: var(--accent); }
    .folder-name { font-family: var(--font-display); font-weight: 800; font-size: 22px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .folder-count { font-size: 12px; color: var(--text-tertiary); white-space: nowrap; }
    .folder-acts { display: flex; flex: none; }
    .folder-acts .icon-btn { width: 40px; height: 40px; color: var(--text-secondary); }
    .folder-acts .icon-btn:hover:not(:disabled) { color: var(--accent); }
    .folder-menu { display: flex; flex-wrap: wrap; gap: 6px; padding-left: 8px; }
    .folder-new { padding-left: 8px; }
    .folder-body { display: flex; flex-direction: column; gap: 14px; margin-left: 15px; padding: 4px 0 8px 14px; border-left: 1px solid var(--border-subtle); min-height: 32px; }
    @media (max-width: 700px) {
      .actions .icon-btn:not(:last-child):not(.narrow-keep) { display: none; }
      .folder-name { font-size: 19px; }
      .folder-count { display: none; }
      .folder-body { margin-left: 8px; padding-left: 10px; }
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
  private readonly studio = inject(StudioService);
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

  // ── folders (Victoria, 2026-10-11) ──────────────────────────────────────────
  protected readonly folders = inject(FoldersService);
  protected readonly newFolder = signal('');
  /** The folder a new folder is being named in (its menu's New folder in it), or null. */
  protected readonly newFolderIn = signal<string | null>(null);
  protected readonly renamingFolder = signal<string | null>(null);
  protected readonly movingFolder = signal<string | null>(null);
  /** The folder whose menu (rename, move, delete) is open. */
  protected readonly folderMenu = signal<string | null>(null);
  /** This playlist's Move to folder… panel is open. */
  protected readonly movingPlaylist = signal(false);
  protected readonly top: DropTarget = { kind: 'folder', id: null, edge: false };

  protected edge(id: string): DropTarget {
    return { kind: 'folder', id, edge: true };
  }

  protected inside(id: string): DropTarget {
    return { kind: 'folder', id, edge: false };
  }

  protected onPlaylist(id: string): DropTarget {
    return { kind: 'playlist', id };
  }

  protected shelfFolder(id: string): ShelfItem {
    return { kind: 'folder', id };
  }

  protected shelfPlaylist(id: string): ShelfItem {
    return { kind: 'playlist', id };
  }

  protected dropOn(event: DragEvent, target: DropTarget, axis: 'x' | 'y' = 'y'): void {
    if (this.folders.dragging() === null) return;
    void this.folders.drop(event, target, axis).then((refusal) => this.refusal.set(refusal));
  }

  /** "3 albums, 1 playlist": what a folder holds, the folders inside it included. */
  protected countText(id: string): string {
    const under = this.library.playlistsUnder(id);
    const albums = under.filter((playlist) => playlist.album != null).length;
    const playlists = under.length - albums;
    const parts = [
      ...(albums > 0 ? [`${albums} ${albums === 1 ? 'album' : 'albums'}`] : []),
      ...(playlists > 0 ? [`${playlists} ${playlists === 1 ? 'playlist' : 'playlists'}`] : []),
    ];
    return parts.length === 0 ? 'empty' : parts.join(', ');
  }

  protected hasSongs(id: string): boolean {
    return this.library.playlistsUnder(id).some((playlist) => playlist.songs.length > 0);
  }

  /** " · in Greek Myths / Odyssey" for the page's kicker, when it is filed in a folder here. */
  protected folderPath(playlist: Playlist): string {
    if (this.remote() || playlist.folder == null) return '';
    const row = this.library.folderRows().find((each) => each.folder.id === playlist.folder);
    return row === undefined ? '' : ` · in ${row.path}`;
  }

  protected async createFolder(parent: string | null): Promise<void> {
    const made = await this.library.createFolder(this.newFolder(), parent);
    if ('code' in made) {
      this.refusal.set(made);
      return;
    }
    this.refusal.set(null);
    this.newFolder.set('');
    this.newFolderIn.set(null);
    // Made inside a closed folder: open it, so the new one is seen.
    if (parent !== null && !this.folders.isOpen(parent)) this.folders.toggle(parent);
  }

  protected async renameFolder(folder: Folder, name: string): Promise<void> {
    if (this.renamingFolder() !== folder.id) return;
    this.renamingFolder.set(null);
    if (name.trim() === '' || name.trim() === folder.name) return;
    this.refusal.set(await this.library.renameFolder(folder.id, name));
  }

  /** Delete a folder: only the folder goes; what was in it moves up a level, and says where. */
  protected async deleteFolder(folder: Folder): Promise<void> {
    this.folderMenu.set(null);
    const into = folder.parent === null ? 'the top of the library' : `"${this.library.folder(folder.parent)?.name ?? 'the folder it is in'}"`;
    const inside = this.library.foldersIn(folder.id).length + this.library.playlistsIn(folder.id).length;
    const yes = await this.confirm.ask({
      title: `Delete the folder "${folder.name}"?`,
      message: inside === 0
        ? 'It is empty, so only the folder goes.'
        : `Only the folder goes. The albums, playlists and folders in it move up a level, to ${into}; no album, playlist or song is deleted.`,
      confirm: 'Delete folder',
      danger: false,
    });
    if (!yes) return;
    this.refusal.set(await this.library.deleteFolder(folder.id));
  }

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
    // Back only to make a track again: the rest of its plan is not being made.
    const busy = this.busy(album.stage) && !this.interrupted(album) && album.remakeOnly == null;
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

  // ── instrumental versions (Owen, 2026-10-11; shared/core/strip.ts) ───────────
  /** Whether the active server can take a song's voice out now. */
  protected readonly canStrip = computed(() => !this.hub.needsCrucible() && this.hub.strip()?.can === true);
  /** The song or playlist whose instrumental version is being asked for now. */
  protected readonly versioning = signal<string | null>(null);
  protected readonly versionNote = signal<{ readonly text: string; readonly id: string; readonly name: string } | null>(null);
  protected readonly versionRefusal = signal<RefusalView | null>(null);

  /** The button's hint: what it does, or why it cannot now. */
  protected stripTitle(what: 'song' | 'album' | 'playlist', playlist: Playlist): string {
    if (this.hub.needsCrucible()) return 'Set up a Crucible server first: the voice is taken out on it';
    const strip = this.hub.strip();
    if (strip === null) return 'Asking the server whether it can take the voice out…';
    if (!strip.can) return strip.why ?? 'This server cannot take the voice out of songs';
    const into = `"${playlist.name}${INSTRUMENTAL_SUFFIX}"`;
    return what === 'song'
      ? `Make an instrumental version: the voice taken out, filed in ${into}`
      : `Make an instrumental version of every song in this ${what}: the voices taken out, filed in ${into}`;
  }

  protected async makeInstrumental(playlist: Playlist, song?: Song): Promise<void> {
    this.versioning.set(song?.id ?? playlist.id);
    this.versionRefusal.set(null);
    const outcome = song === undefined
      ? await this.hub.call<JobView[]>('POST', `/api/playlists/${encodeURIComponent(playlist.id)}/instrumental`)
      : await this.hub.call<JobView[]>('POST', `/api/songs/${encodeURIComponent(song.id)}/instrumental`, { playlist: playlist.id });
    this.versioning.set(null);
    if (!outcome.ok) {
      this.versionRefusal.set(outcome.refusal);
      return;
    }
    for (const job of outcome.value) this.hub.upsertJob(job);
    const target = outcome.value[0]?.playlist ?? null;
    if (target === null) return;
    const name = this.library.playlist(target)?.name ?? `${playlist.name}${INSTRUMENTAL_SUFFIX}`;
    const count = outcome.value.length;
    // One song's version lands beside it, here (Owen, 2026-10-11); a playlist's in its own playlist.
    this.versionNote.set(song !== undefined
      ? { id: target, name, text: `${song.title} (Instrumental) is being made; it appears right after ${song.title}.` }
      : { id: target, name, text: `${count === 1 ? 'One song is' : `${count} songs are`} being made instrumental, into ${name}.` });
  }

  protected openPlaylist(id: string): void {
    void this.router.navigate(['/library', id]);
  }

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

  /** Make this next (Victoria, 2026-10-11): ahead of the other albums on its server. */
  protected async makeNext(playlist: Playlist): Promise<void> {
    const outcome = await this.hub.call<unknown>('POST', `/api/albums/${encodeURIComponent(playlist.id)}/next`);
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

  /** The length a song aimed for, honestly: "aimed 3–5 min", and whether it missed. */
  protected aimText(song: Song): string | null {
    const aim = song.aim;
    if (aim == null || (aim.min === null && aim.max === null)) return null;
    const minutes = (s: number | null): string => (s === null ? '' : `${+(s / 60).toFixed(1)}`);
    const range = aim.min !== null && aim.max !== null ? `${minutes(aim.min)}–${minutes(aim.max)} min`
      : aim.min !== null ? `${minutes(aim.min)}+ min` : `up to ${minutes(aim.max)} min`;
    return `aimed ${range}${aim.inRange === false ? ', landed outside' : ''}`;
  }

  /** The job making this album track on a server now, for its bar; null when none is. */
  protected trackJob(playlist: Playlist, track: number): JobView | null {
    if (this.isPeer()) return this.peers.albumJob(this.peerKey(), playlist.id, track);
    return this.hub.albumJobs().get(`${playlist.id}:${track}`) ?? null;
  }

  protected async extendAlbum(playlist: Playlist): Promise<void> {
    const outcome = await this.hub.call<unknown>('POST', `/api/albums/${encodeURIComponent(playlist.id)}/extend`);
    this.refusal.set(outcome.ok ? null : outcome.refusal);
  }

  protected remakeAlbum(playlist: Playlist): void {
    const album = playlist.album;
    if (album == null) return;
    this.studio.remakeAlbum(album.ask, album.server);
    void this.router.navigate(['/make']);
  }

  protected async downloadAlbum(playlist: Playlist): Promise<void> {
    this.refusal.set(await this.library.saveAlbum(playlist.id));
  }

  /** Dragging an image over the cover. */
  protected readonly coverOver = signal(false);

  /** An album on this computer: its cover can be the person's own image. */
  protected ownCover(playlist: Playlist): boolean {
    return !this.remote() && playlist.album != null;
  }

  protected coverDragOver(event: DragEvent): void {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    this.coverOver.set(true);
  }

  protected coverDrop(playlist: Playlist, event: DragEvent): void {
    this.coverOver.set(false);
    const image = Array.from(event.dataTransfer?.files ?? []).find((file) => file.type.startsWith('image/'));
    // Not an image (a song dropped on the cover): the window's own drop files it as before.
    if (image === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    void this.setCover(playlist, image);
  }

  protected coverPicked(playlist: Playlist, event: Event): void {
    const input = event.target as HTMLInputElement;
    const image = input.files?.[0];
    input.value = '';
    if (image !== undefined) void this.setCover(playlist, image);
  }

  /** Ctrl+V with an image on the clipboard, on an album's page: its cover. */
  @HostListener('document:paste', ['$event'])
  protected pasted(event: ClipboardEvent): void {
    const playlist = this.selected();
    if (playlist === null || playlist === undefined || !this.ownCover(playlist)) return;
    const target = event.target as HTMLElement | null;
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const image = Array.from(event.clipboardData?.items ?? []).find((item) => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile();
    if (image == null) return;
    event.preventDefault();
    void this.setCover(playlist, image);
  }

  /** Shrink the image to a cover (at most COVER_PX square, JPEG) and keep it as the album's cover. */
  private async setCover(playlist: Playlist, image: Blob): Promise<void> {
    let data: string;
    try {
      const bitmap = await createImageBitmap(image);
      const side = Math.min(bitmap.width, bitmap.height);
      const size = Math.min(COVER_PX, side);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      // Square, from the middle: a cover is square.
      canvas.getContext('2d')?.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
      data = canvas.toDataURL('image/jpeg', 0.9).replace(/^data:[^,]*,/, '');
    } catch {
      this.refusal.set({ code: 'cover_unreadable', message: 'That image could not be read; try a PNG or JPEG.' });
      return;
    }
    const outcome = await this.hub.call<unknown>('PUT', `/api/albums/${encodeURIComponent(playlist.id)}/cover`, { image: data, type: 'image/jpeg' });
    this.refusal.set(outcome.ok ? null : outcome.refusal);
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

  // ── Make this track again (Victoria, 2026-10-11) ────────────────────────────

  /** The song whose Make this track again choices are open. */
  protected readonly remakeMenu = signal<string | null>(null);
  /** The track ("<album>:<place>") whose remake is being asked for now (new words take a minute to write). */
  protected readonly asking = signal<{ readonly key: string; readonly fresh: boolean } | null>(null);

  /** A made album track on this computer can be made again, once the album's music has begun. */
  protected canRemake(playlist: Playlist, song: Song): boolean {
    const album = playlist.album;
    if (!this.canRewrite(playlist) || album == null || album.stage === 'planning' || album.stage === 'cover') return false;
    const at = this.trackPlace(playlist, song.title);
    return at !== null && at < album.sent;
  }

  /** The track is sung: it can have its words written again. */
  protected sungTrack(playlist: Playlist, song: Song): boolean {
    const at = this.trackPlace(playlist, song.title);
    return playlist.album?.ask.sung === true && at !== null && playlist.album.plan?.tracks[at]?.lyrics != null;
  }

  /** What is happening to a track being made again, for its row; null when nothing is. */
  protected remakeState(playlist: Playlist, song: Song): { readonly job: JobView | null; readonly text: string } | null {
    const album = playlist.album;
    const at = this.trackPlace(playlist, song.title);
    if (album == null || at === null) return null;
    const asking = this.asking();
    if (asking?.key === `${playlist.id}:${at}`) return { job: null, text: asking.fresh ? 'Writing new words for a new take…' : 'Asking for a new take…' };
    if (!(album.remakes ?? []).some((each) => each.at === at)) return null;
    const job = this.trackJob(playlist, at);
    if (job !== null) return { job, text: `New take: ${jobStatus(job, this.jobs.now())}. This one plays until it is in.` };
    return {
      job: null,
      text: album.waitingFor ? `A new take is made once "${album.waitingFor}" is finished.` : 'A new take is waiting its turn. This one plays until it is in.',
    };
  }

  protected async remake(playlist: Playlist, song: Song, lyrics: 'keep' | 'new'): Promise<void> {
    const at = this.trackPlace(playlist, song.title);
    this.remakeMenu.set(null);
    if (at === null) return;
    this.asking.set({ key: `${playlist.id}:${at}`, fresh: lyrics === 'new' });
    const outcome = await this.hub.call<unknown>('POST', `/api/albums/${encodeURIComponent(playlist.id)}/tracks/${at}/remake`, { lyrics });
    this.asking.set(null);
    this.refusal.set(outcome.ok ? null : outcome.refusal);
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
