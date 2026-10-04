import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import type { HubSettingsView, RefusalView } from '@shared/types';

import { copyText } from '../../core/clipboard';
import { desktop, HubService } from '../../core/hub.service';
import { LibraryService } from '../../core/library.service';
import { HubPickerComponent } from '../../components/hub-picker/hub-picker.component';
import { ServersCardComponent } from './servers-card.component';

/**
 * Settings: the Crucible servers, where the library lives, and sharing the hub
 * with other devices. The library folder and sharing belong to the computer
 * B-Side runs on: other devices see them, and only that computer changes them.
 */
@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ServersCardComponent, HubPickerComponent],
  template: `
    <div class="page">
      <h1>Settings</h1>

      @if (hub.kind !== 'desktop') {
        <div class="card">
          <h2 class="card-title">This {{ hub.kind === 'ios' ? 'phone' : 'browser' }}</h2>
          <p class="detail">Connected to the B-Side on <strong>{{ hub.info()?.hostname ?? '…' }}</strong> at <span class="mono">{{ hub.address()?.url }}</span>.</p>
          @if (hub.kind === 'web') {
            <p class="hint">A browser keeps nothing for long: this tab's playing list clears a few minutes after the tab closes. Save songs to a playlist to keep them.</p>
          }
          @if (hub.kind === 'ios') {
            <app-hub-picker />
          }
        </div>
      }

      <app-servers-card />

      <div class="card">
        <h2 class="card-title">Library</h2>
        <p class="detail">Songs saved to a playlist are kept here, each as its audio file plus a .json sidecar with the tags, lyrics, seed, guidance, server and Crucible job it came from. Playlists are in playlists.json beside them.</p>
        <div class="dir mono">{{ settings()?.libraryDir ?? library.dir() }}</div>
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
          <p class="hint">Changing the folder does not move songs; B-Side lists whatever songs and playlists the new folder holds.</p>
        }
        @for (problem of library.problems(); track problem) {
          <div class="notice">{{ problem }}</div>
        }
      </div>

      <div class="card">
        <h2 class="card-title">Other devices</h2>
        @if (settings(); as view) {
          <p class="detail">Phones and other computers can play and make songs through this B-Side, and play your playlists. They never get your Crucible tokens.</p>
          @if (view.local) {
            <label class="toggle">
              <input type="checkbox" [checked]="view.sharing" [disabled]="busy()" (change)="share($any($event.target).checked)" />
              <span>Share on my network (port {{ view.port }})</span>
            </label>
          } @else {
            <p class="hint">Sharing is {{ view.sharing ? 'on' : 'off' }}. Only the computer B-Side runs on can change it.</p>
          }
          @if (view.sharing && view.local) {
            <p class="hint">Open one of these links on the other device (in a browser, or paste it into the B-Side phone app). The link carries this B-Side's key: share it only with people you want using it.</p>
            @for (link of view.links; track link) {
              <div class="link">
                <span class="mono">{{ link }}</span>
                <button type="button" class="ghost small" (click)="copy(link)">{{ copied() === link ? 'Copied' : 'Copy' }}</button>
              </div>
            } @empty {
              <p class="hint">This computer has no network address right now.</p>
            }
            <div class="actions">
              <button type="button" class="ghost small" (click)="replaceKey()">New key (signs out every other device)</button>
            </div>
          }
        } @else {
          <p class="hint">Reading the hub's settings…</p>
        }
      </div>

      @if (refusal(); as refused) {
        <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
      }
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; overflow-y: auto; }
    .page { max-width: 860px; margin: 0 auto; padding: 18px 22px 32px; display: flex; flex-direction: column; gap: 14px; }
    h1 { font-size: 20px; margin: 0; }
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
  protected readonly refusal = signal<RefusalView | null>(null);
  protected readonly busy = signal(false);
  protected readonly copied = signal<string | null>(null);
  protected readonly isDesktop = desktop !== null;

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    const outcome = await this.hub.call<HubSettingsView>('GET', '/api/settings');
    if (outcome.ok) this.settings.set(outcome.value);
    else this.refusal.set(outcome.refusal);
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
