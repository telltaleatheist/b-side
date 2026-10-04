import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import type { AppSettingsView, RefusalView } from '@shared/types';

import { api } from '../../core/bside';
import { LibraryService } from '../../core/library.service';
import { ServersCardComponent } from './servers-card.component';

/** Settings: the servers, and where the library lives. */
@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ServersCardComponent],
  template: `
    <div class="page">
      <h1>Settings</h1>
      <app-servers-card />

      <div class="card">
        <h2 class="card-title">Library</h2>
        <p class="detail">Every finished song is saved here as its audio file plus a .json sidecar with the tags, lyrics, seed, guidance, server and Crucible job it came from.</p>
        <div class="dir mono">{{ settings()?.libraryDir ?? library.dir() }}</div>
        <p class="hint">{{ library.songs().length }} {{ library.songs().length === 1 ? 'song' : 'songs' }} in it.</p>
        <div class="actions">
          <button type="button" class="ghost small" (click)="choose()">Choose a folder…</button>
          @if (settings(); as view) {
            @if (view.libraryDir !== view.defaultLibraryDir) {
              <button type="button" class="ghost small" (click)="reset()">Back to {{ view.defaultLibraryDir }}</button>
            }
          }
        </div>
        <p class="hint">Changing the folder does not move songs; B-Side lists whatever songs the new folder holds.</p>
        @if (refusal(); as refused) {
          <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; overflow-y: auto; }
    .page { max-width: 860px; margin: 0 auto; padding: 18px 22px 32px; display: flex; flex-direction: column; gap: 14px; }
    h1 { font-size: 20px; margin: 0; }
    .dir { font-size: 12px; color: var(--text-primary); }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  `],
})
export class SettingsPageComponent {
  protected readonly library = inject(LibraryService);
  protected readonly settings = signal<AppSettingsView | null>(null);
  protected readonly refusal = signal<RefusalView | null>(null);

  constructor() {
    if (api !== null) void api.settings.get().then((view) => this.settings.set(view));
  }

  protected async choose(): Promise<void> {
    if (api === null) return;
    const outcome = await api.settings.chooseLibraryDir();
    if (!outcome.ok) {
      this.refusal.set(outcome.refusal);
      return;
    }
    this.refusal.set(null);
    if (outcome.value !== null) this.settings.set(outcome.value);
  }

  protected async reset(): Promise<void> {
    if (api === null) return;
    const outcome = await api.settings.resetLibraryDir();
    this.refusal.set(outcome.ok ? null : outcome.refusal);
    if (outcome.ok) this.settings.set(outcome.value);
  }
}
