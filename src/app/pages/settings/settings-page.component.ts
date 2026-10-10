import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import type { FirewallView } from '@shared/api';
import { ALBUM_SPACE_GB, type HubPreferences, type HubSettingsView, type RefusalView, type SongFormat } from '@shared/types';

import { copyText } from '../../core/clipboard';
import { CloudService } from '../../core/cloud.service';
import { PeersService } from '../../core/peers.service';
import { desktop, HubService, isNative, parseHubLink } from '../../core/hub.service';
import { PlayerService } from '../../core/player.service';
import { LibraryService } from '../../core/library.service';
import { HubPickerComponent } from '../../components/hub-picker/hub-picker.component';
import { ServersCardComponent } from './servers-card.component';
import { RefusalComponent } from '../../components/refusal/refusal.component';
import { StudioService } from '../../core/studio.service';

/**
 * Settings: the Crucible servers, where the library lives, and sharing the hub
 * with other devices. The library folder and sharing belong to the computer
 * B-Sides runs on: other devices see them, and only that computer changes them.
 */
@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RefusalComponent, ServersCardComponent, HubPickerComponent],
  template: `
    <div class="page">
      <h1 class="page-title">Settings</h1>

      @if (hub.kind !== 'desktop') {
        <div class="card">
          <h2 class="card-title">This {{ hub.kind === 'ios' ? 'phone' : 'browser' }}</h2>
          @if (hub.onPhone()) {
            <p class="detail">This phone makes songs on a Crucible server by itself (the servers below), and keeps its playlists on the phone.</p>
            <details>
              <summary class="hint">Use a B-Sides computer instead</summary>
              <p class="hint">Its playlists and servers, instead of this phone's. This phone's own playlists stay here for when you switch back.</p>
              <app-hub-picker />
            </details>
          } @else {
            <p class="detail">Connected to the B-Sides on <strong>{{ hub.info()?.hostname ?? '…' }}</strong> at <span class="mono">{{ hub.address()?.url }}</span>.</p>
            @if (hub.kind === 'web') {
              <p class="hint">A browser keeps nothing for long: this tab's playing list clears a few minutes after the tab closes. Save songs to a playlist to keep them.</p>
            }
            @if (hub.kind === 'ios') {
              <app-hub-picker />
              <div class="actions">
                <button type="button" class="ghost small" (click)="hub.usePhone()">Use a Crucible server from this phone instead</button>
              </div>
              <p class="hint">No computer needed: the phone makes songs itself and keeps its own playlists.</p>
            }
          }
        </div>
      }

      @if (cloud.available()) {
        <div class="card">
          <h2 class="card-title">Cloud</h2>
          @if (cloud.address(); as address) {
            <p class="detail">Albums you save go to the B-Sides on <strong>{{ cloud.host() }}</strong>. They stream from it, or download to keep on this phone.</p>
            <p class="hint mono">{{ address.url }} · {{ cloudWords() }}</p>
            <div class="actions">
              <button type="button" class="ghost small" (click)="cloud.refresh()">Check again</button>
              <button type="button" class="ghost small" (click)="cloud.unlink()">Unlink</button>
            </div>
          } @else {
            <p class="detail">Link a B-Sides computer as this phone's cloud: albums you save go there, and stream or download back. On the computer: Settings → Other devices → turn on sharing; type the address it shows.</p>
            <form class="link" (submit)="$event.preventDefault(); linkCloud()">
              <input type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Computer's address"
                     placeholder="192.168.1.20" [value]="cloudLink()" (input)="cloudLink.set($any($event.target).value)" />
              <button type="submit" class="primary small" [disabled]="cloudLink().trim() === ''">Link</button>
            </form>
            @if (cloudLinkWrong()) {
              <div class="refusal"><code>link_invalid</code><span>That is not an address: type one like 192.168.1.20 or owens-mac-studio.local</span></div>
            }
          }
        </div>
      }

      <app-servers-card />

      @if (!isNative) {
        <div class="card">
          <h2 class="card-title">Output</h2>
          <p class="detail">Where B-Sides plays on this {{ isDesktop ? 'computer' : 'browser' }}. "System default" follows whatever the computer is set to; a device you pick here is used even when the default changes.</p>
          <label class="field">
            <span class="label">Play through</span>
            <select aria-label="Output device" (change)="player.useOutput($any($event.target).value)">
              <option value="" [selected]="player.outputDevice() === ''">System default</option>
              @for (device of outputs(); track device.deviceId) {
                <option [value]="device.deviceId" [selected]="device.deviceId === player.outputDevice()">{{ device.label || 'Unnamed output' }}</option>
              }
            </select>
          </label>
          @if (player.outputProblem(); as problem) { <div class="notice">{{ problem }}</div> }
        </div>
      }

      @if (!hub.onPhone()) {
        <div class="card">
          <h2 class="card-title">Writing</h2>
          <p class="detail">Who writes everything that is words: a song's tags and lyrics, and an album's name, artist, track list, lyrics and cover description. The music is always the Crucible server's.</p>
          <label class="toggle">
            <input type="radio" name="writer" [checked]="preferences()?.writer !== 'claude'" (change)="setWriter('bside')" />
            <span><strong>B-Sides' model</strong>, on the Crucible server.</span>
          </label>
          <label class="toggle">
            <input type="radio" name="writer" [checked]="preferences()?.writer === 'claude'" (change)="setWriter('claude')" />
            <span><strong>Claude Sonnet 5.5</strong> (<span class="mono">claude -p</span>), through Claude Code on this computer; its sign-in pays. A stand-in while B-Sides' model is retrained.</span>
          </label>
          @if (writerRefusal(); as refused) {
            <app-refusal [refusal]="refused" />
          }
        </div>
      }

      <div class="card">
        <h2 class="card-title">Song format</h2>
        <p class="detail">How new songs are made and kept{{ hub.onPhone() ? ' on this phone' : '' }}. Songs already made keep their format.</p>
        <label class="toggle">
          <input type="radio" name="format" [checked]="preferences()?.songFormat === 'mp3'" (change)="setFormat('mp3')" />
          <span><strong>MP3</strong>, 192 kbps: about 4 MB for a 3-minute song. Sounds the same on phones, earbuds and most speakers.</span>
        </label>
        <label class="toggle">
          <input type="radio" name="format" [checked]="preferences()?.songFormat === 'flac'" (change)="setFormat('flac')" />
          <span><strong>FLAC</strong>, lossless: about 34 MB for a 3-minute song.</span>
        </label>
        @if (hub.onPhone()) {
          <span class="label">Album space on this phone</span>
          <div class="actions">
            @for (gb of spaceChoices; track gb) {
              <button type="button" class="chip" [class.on]="preferences()?.albumSpaceGb === gb" (click)="setSpace(gb)">{{ gb }} GB</button>
            }
          </div>
          <p class="hint">Albums kept only on this phone may take this much; past it, Make asks you to save some to your cloud or delete one first. An hour of MP3 is about 85 MB.</p>
        }
        @if (formatRefusal(); as refused) {
          <app-refusal [refusal]="refused" />
        }
      </div>

      <div class="card">
        <h2 class="card-title">Library</h2>
        <p class="detail">Songs saved to a playlist are kept here, each as its audio file plus a .json sidecar with the tags, lyrics, seed, guidance, server and Crucible job it came from. Playlists are in playlists.json beside them.</p>
        @if (hub.onPhone()) {
          <div class="dir">On this phone, backed up with it.</div>
        } @else {
          <div class="dir mono">{{ settings()?.libraryDir ?? library.dir() }}</div>
        }
        <p class="hint">{{ library.songs().length }} {{ library.songs().length === 1 ? 'song' : 'songs' }} in {{ library.playlists().length }} {{ library.playlists().length === 1 ? 'playlist' : 'playlists' }}.</p>
        @if (isDesktop) {
          <div class="actions">
            <button type="button" class="ghost small" (click)="choose()">Choose a folder…</button>
            @if (settings(); as view) {
              @if (view.libraryDir !== view.defaultLibraryDir) {
                <button type="button" class="ghost small" (click)="reset()">Back to {{ view.defaultLibraryDir }}</button>
              }
            }
          </div>
          <p class="hint">Changing the folder does not move songs; B-Sides lists whatever songs and playlists the new folder holds.</p>
        }
        @for (problem of library.problems(); track problem) {
          <div class="notice">{{ problem }}</div>
        }
      </div>

      <div class="card">
        <h2 class="card-title">Other devices</h2>
        @if (settings(); as view) {
          <p class="detail">Phones and other computers can play and make songs through this B-Sides, and play your playlists. They never get your Crucible tokens.</p>
          @if (view.local) {
            <label class="toggle">
              <input type="checkbox" [checked]="view.sharing" [disabled]="busy()" (change)="share($any($event.target).checked)" />
              <span>Share on my network (port {{ view.port }})</span>
            </label>
          } @else {
            <p class="hint">Sharing is {{ view.sharing ? 'on' : 'off' }}. Only the computer B-Sides runs on can change it.</p>
          }
          @if (view.sharing && view.local) {
            @if (view.requireKey) {
              <p class="hint">Open one of these links on the other device (in a browser, or paste it into the B-Sides phone app). The link carries this B-Sides' key: share it only with people you want using it.</p>
            } @else {
              <p class="hint">Type this computer's address into the B-Sides phone app, or open it in a browser. No key: anything that can reach this computer on port {{ view.port }} can use B-Sides, so share only on networks you trust.</p>
            }
            @for (link of view.links; track link) {
              <div class="link">
                <span class="mono">{{ link }}</span>
                <button type="button" class="ghost small" (click)="copy(link)">{{ copied() === link ? 'Copied' : 'Copy' }}</button>
              </div>
            } @empty {
              <p class="hint">This computer has no network address right now.</p>
            }
            @if (firewall(); as wall) {
              @if (!wall.reachableOnPrivate) {
                <div class="notice">Windows Firewall is keeping other devices away from B-Sides (port {{ wall.port }}).</div>
                <div class="actions">
                  <button type="button" class="ghost small" [disabled]="busy()" (click)="allowFirewall()">Allow B-Sides through Windows Firewall</button>
                </div>
                <p class="hint">Windows asks for permission once. This lets in devices on Private networks only.</p>
              }
              @for (network of wall.publicNetworks; track network) {
                <div class="notice">Windows treats the network “{{ network }}” as Public, so other devices on it cannot reach B-Sides. If it is your home network, set it to Private.</div>
                <div class="actions">
                  <button type="button" class="ghost small" (click)="openNetworkSettings()">Open network settings</button>
                </div>
              }
            }
            @if (firewallRefusal(); as refused) {
              <app-refusal [refusal]="refused" />
            }
            <label class="toggle">
              <input type="checkbox" [checked]="view.requireKey" [disabled]="busy()" (change)="requireKey($any($event.target).checked)" />
              <span>Require a key (devices then need the link, not just the address)</span>
            </label>
            @if (view.requireKey) {
              <div class="actions">
                <button type="button" class="ghost small" (click)="replaceKey()">New key (signs out every other device)</button>
              </div>
            }
          }
        } @else {
          <p class="hint">Reading the hub's settings…</p>
        }
      </div>

      <div class="card">
        <h2 class="card-title">Other libraries</h2>
        <p class="detail">Another B-Sides on your network, added by its address: its songs show in your Library and play from there. Nothing is copied. When it is off or away, it is simply not listed. On that computer: Settings → Other devices → turn on sharing.</p>
        @for (peer of peers.peers(); track peer.url) {
          <div class="link">
            <span class="peer-dot" [class.ok]="peer.state === 'ok'" [class.away]="peer.state === 'away'"></span>
            <span class="peer-names">
              <span>{{ peers.name(peer) }}</span>
              <span class="hint mono">{{ peer.url }} · {{ peer.state === 'ok' ? (peer.library?.songs?.length ?? 0) + ' songs' : peer.state === 'away' ? 'not answering now' : 'looking…' }}</span>
            </span>
            <button type="button" class="ghost small" (click)="peers.remove(peer.url)">Remove</button>
          </div>
        }
        <form class="link peer-add" (submit)="$event.preventDefault(); addPeer()">
          <input type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Its address"
                 placeholder="its address, like 192.168.68.50" [value]="peerAddress()" (input)="peerAddress.set($any($event.target).value)" />
          <input type="text" maxlength="40" aria-label="What to call it" placeholder="name (optional), like Victoria"
                 [value]="peerLabel()" (input)="peerLabel.set($any($event.target).value)" />
          <button type="submit" class="primary small" [disabled]="peerAddress().trim() === '' || peerAdding()">{{ peerAdding() ? 'Looking…' : 'Add' }}</button>
        </form>
        @if (peerNote(); as note) { <p class="hint">{{ note }}</p> }
      </div>

      @if (refusal(); as refused) {
        <app-refusal [refusal]="refused" />
      }
    </div>
  `,
  styles: [`
    .peer-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--text-muted); flex: none; }
    .peer-dot.ok { background: #5fbf7a; }
    .peer-dot.away { background: var(--warn); }
    .peer-names { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .peer-add { flex-wrap: wrap; }
    .peer-add input { flex: 1; min-width: 160px; }
    :host { display: block; height: 100%; overflow-y: auto; }
    .page { max-width: 860px; margin: 0 auto; padding: 18px 20px 32px; display: flex; flex-direction: column; gap: 16px; }

    .dir { font-size: 12px; color: var(--text-primary); overflow-wrap: anywhere; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .link { display: flex; align-items: center; gap: 8px; }
    .link .mono { font-size: 12px; overflow-wrap: anywhere; flex: 1; min-width: 0; }
    @media (max-width: 600px) { .page { padding: 14px 16px 24px; } }
  `],
})
export class SettingsPageComponent {
  protected readonly hub = inject(HubService);
  protected readonly library = inject(LibraryService);
  protected readonly settings = signal<HubSettingsView | null>(null);
  protected readonly preferences = signal<HubPreferences | null>(null);
  protected readonly formatRefusal = signal<RefusalView | null>(null);
  protected readonly refusal = signal<RefusalView | null>(null);
  protected readonly busy = signal(false);
  protected readonly copied = signal<string | null>(null);
  protected readonly isDesktop = desktop !== null;
  /** Windows' firewall and the hub's port, read while sharing is on (null off Windows or before the read). */
  protected readonly firewall = signal<FirewallView | null>(null);
  protected readonly firewallRefusal = signal<RefusalView | null>(null);

  constructor() {
    void this.load();
    void this.loadPreferences();
    void this.readOutputs();
  }

  private async loadPreferences(): Promise<void> {
    const outcome = await this.hub.call<HubPreferences>('GET', '/api/preferences');
    if (outcome.ok) this.preferences.set(outcome.value);
    else this.formatRefusal.set(outcome.refusal);
  }

  protected readonly spaceChoices = ALBUM_SPACE_GB;
  protected readonly player = inject(PlayerService);
  protected readonly isNative = isNative;
  /** This computer's audio outputs, as the browser engine lists them (the "default" entries are the System default row). */
  protected readonly outputs = signal<MediaDeviceInfo[]>([]);

  private async readOutputs(): Promise<void> {
    if (isNative || !navigator.mediaDevices?.enumerateDevices) return;
    const devices = await navigator.mediaDevices.enumerateDevices();
    this.outputs.set(devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications'));
  }
  protected readonly cloud = inject(CloudService);
  protected readonly peers = inject(PeersService);
  protected readonly peerAddress = signal('');
  protected readonly peerLabel = signal('');
  protected readonly peerAdding = signal(false);
  protected readonly peerNote = signal<string | null>(null);

  protected async addPeer(): Promise<void> {
    this.peerAdding.set(true);
    const note = await this.peers.add(this.peerAddress(), this.peerLabel());
    this.peerAdding.set(false);
    this.peerNote.set(note);
    if (note === null || note.includes('stays added')) {
      this.peerAddress.set('');
      this.peerLabel.set('');
    }
  }
  protected readonly cloudLink = signal('');
  protected readonly cloudLinkWrong = signal(false);

  protected cloudWords(): string {
    switch (this.cloud.state()) {
      case 'ok': return `${this.cloud.library()?.playlists.length ?? 0} playlists and albums`;
      case 'loading': return 'reading…';
      case 'unreachable': return 'not answering';
      case 'key': return 'the link\'s key was replaced: link it again';
      case 'none': return '';
    }
  }

  protected linkCloud(): void {
    const address = parseHubLink(this.cloudLink());
    this.cloudLinkWrong.set(address === null);
    if (address === null) return;
    this.cloud.link(address);
    this.cloudLink.set('');
  }

  protected async setSpace(albumSpaceGb: number): Promise<void> {
    const outcome = await this.hub.call<HubPreferences>('PUT', '/api/preferences', { albumSpaceGb });
    this.formatRefusal.set(outcome.ok ? null : outcome.refusal);
    if (outcome.ok) this.preferences.set(outcome.value);
  }

  protected readonly writerRefusal = signal<RefusalView | null>(null);
  private readonly studio = inject(StudioService);

  protected async setWriter(writer: 'bside' | 'claude'): Promise<void> {
    const outcome = await this.hub.call<HubPreferences>('PUT', '/api/preferences', { writer });
    this.writerRefusal.set(outcome.ok ? null : outcome.refusal);
    if (outcome.ok) {
      this.preferences.set(outcome.value);
      // The Studio names who writes: read again, so it says the new writer.
      void this.studio.reload();
    } else {
      // The radio shows what is in force, not what was refused.
      this.preferences.set({ ...(this.preferences() as HubPreferences) });
    }
  }

  protected async setFormat(songFormat: SongFormat): Promise<void> {
    const outcome = await this.hub.call<HubPreferences>('PUT', '/api/preferences', { songFormat });
    this.formatRefusal.set(outcome.ok ? null : outcome.refusal);
    if (outcome.ok) this.preferences.set(outcome.value);
  }

  private async load(): Promise<void> {
    // The phone's own hub has no computer settings (folder, sharing, key) to read.
    if (this.hub.onPhone()) return;
    const outcome = await this.hub.call<HubSettingsView>('GET', '/api/settings');
    if (outcome.ok) {
      this.settings.set(outcome.value);
      void this.readFirewall();
    } else {
      this.refusal.set(outcome.refusal);
    }
  }

  /** Only the computer B-Sides runs on, only while it shares: that is when the firewall decides anything. */
  private async readFirewall(): Promise<void> {
    const view = this.settings();
    if (desktop === null || view === null || !view.local || !view.sharing) {
      this.firewall.set(null);
      return;
    }
    const outcome = await desktop.firewall();
    this.firewallRefusal.set(outcome.ok ? null : outcome.refusal);
    this.firewall.set(outcome.ok ? outcome.value : null);
  }

  protected async allowFirewall(): Promise<void> {
    if (desktop === null) return;
    this.busy.set(true);
    const outcome = await desktop.allowThroughFirewall();
    this.busy.set(false);
    this.firewallRefusal.set(outcome.ok ? null : outcome.refusal);
    if (outcome.ok) this.firewall.set(outcome.value);
  }

  protected async openNetworkSettings(): Promise<void> {
    if (desktop === null) return;
    const outcome = await desktop.openNetworkSettings();
    this.firewallRefusal.set(outcome.ok ? null : outcome.refusal);
  }

  protected async choose(): Promise<void> {
    if (desktop === null) return;
    const outcome = await desktop.chooseLibraryDir();
    if (!outcome.ok) {
      this.refusal.set(outcome.refusal);
      return;
    }
    this.refusal.set(null);
    if (outcome.value !== null) this.settings.set(outcome.value);
  }

  protected async reset(): Promise<void> {
    if (desktop === null) return;
    const outcome = await desktop.resetLibraryDir();
    this.refusal.set(outcome.ok ? null : outcome.refusal);
    if (outcome.ok) this.settings.set(outcome.value);
  }

  protected async share(sharing: boolean): Promise<void> {
    this.busy.set(true);
    const outcome = await this.hub.call<HubSettingsView>('PUT', '/api/settings/sharing', { sharing });
    this.busy.set(false);
    this.refusal.set(outcome.ok ? null : outcome.refusal);
    if (outcome.ok) {
      this.settings.set(outcome.value);
      void this.readFirewall();
    }
  }

  protected async requireKey(requireKey: boolean): Promise<void> {
    this.busy.set(true);
    const outcome = await this.hub.call<HubSettingsView>('PUT', '/api/settings/require-key', { requireKey });
    this.busy.set(false);
    this.refusal.set(outcome.ok ? null : outcome.refusal);
    if (outcome.ok) this.settings.set(outcome.value);
  }

  protected async replaceKey(): Promise<void> {
    const outcome = await this.hub.call<{ settings: HubSettingsView; key: string }>('POST', '/api/settings/key');
    if (!outcome.ok) {
      this.refusal.set(outcome.refusal);
      return;
    }
    this.refusal.set(null);
    this.settings.set(outcome.value.settings);
    this.hub.rekey(outcome.value.key);
  }

  protected async copy(link: string): Promise<void> {
    await copyText(link);
    this.copied.set(link);
    setTimeout(() => this.copied.set(null), 1500);
  }
}
