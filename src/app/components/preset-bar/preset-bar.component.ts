import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import type { RefusalView } from '@shared/types';

import { ConfirmService } from '../../core/confirm.service';
import { StudioService } from '../../core/studio.service';
import { IconComponent } from '../icon/icon.component';
import { RefusalComponent } from '../refusal/refusal.component';

/**
 * Presets kept on the server (the playground presets routes), as a row of
 * pills: tap one to fill the form; its × deletes it, once the person says so
 * in the app's own dialog (Owen, 2026-10-11). "Save as preset" names what the
 * form holds now. A preset is a sound, not a take, so the seed is never saved.
 */
@Component({
  selector: 'app-preset-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RefusalComponent, IconComponent],
  template: `
    <div class="head">
      <span class="label">Presets</span>
      <button type="button" class="save-btn" (click)="naming.set(!naming())"><app-icon name="bookmark" [size]="14" />Save as preset</button>
    </div>
    @if (naming()) {
      <form class="naming" (submit)="$event.preventDefault(); save()">
        <input type="text" maxlength="80" placeholder="Name this sound" aria-label="Preset name"
               [value]="name()" (input)="name.set($any($event.target).value)" />
        <button type="submit" class="primary small" [disabled]="busy() || name().trim() === ''">Save</button>
      </form>
    }
    <div class="chips">
      @for (preset of studio.presets(); track preset.name) {
        <span class="chip preset" [class.on]="preset.name === chosen()">
          <button type="button" class="pick" (click)="choose(preset.name)">{{ preset.name }}</button>
          <button type="button" class="drop" [attr.aria-label]="'Delete the preset ' + preset.name" title="Delete this preset"
                  (click)="remove(preset.name)"><app-icon name="close" [size]="12" /></button>
        </span>
      } @empty {
        <span class="hint">No presets yet. Set up a sound you like, then save it here.</span>
      }
    </div>
    @if (said()) {
      <div class="foot"><span class="hint">{{ said() }}</span></div>
    }
    @if (refusal() ?? studio.presetsRefusal(); as refused) {
      <app-refusal [refusal]="refused" />
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 10px; }
    .head { display: flex; align-items: center; justify-content: space-between; }
    .save-btn {
      display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
      border: 1px solid var(--border-default); border-radius: 999px; background: transparent;
      color: var(--accent); font-size: 12px; font-weight: 600;
    }
    .naming { display: flex; gap: 8px; }
    .naming input { flex: 1; min-width: 0; }
    .chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .foot { display: flex; align-items: center; gap: 12px; }
    /* The pill holds two buttons: its name loads it, its × deletes it. */
    .preset { padding: 0 4px 0 0; gap: 2px; }
    .preset button { border: none; background: transparent; color: inherit; font: inherit; cursor: pointer; }
    .pick { height: 100%; padding: 0 4px 0 13px; }
    .drop {
      display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px;
      border-radius: 50%; opacity: 0.7;
    }
    .drop:hover, .drop:focus-visible { opacity: 1; background: color-mix(in srgb, currentColor 14%, transparent); }
  `],
})
export class PresetBarComponent {
  protected readonly studio = inject(StudioService);
  private readonly confirm = inject(ConfirmService);

  protected readonly chosen = signal('');
  protected readonly name = signal('');
  protected readonly said = signal('');
  protected readonly refusal = signal<RefusalView | null>(null);
  protected readonly busy = signal(false);
  protected readonly naming = signal(false);

  protected choose(name: string): void {
    this.chosen.set(name);
    this.refusal.set(null);
    const preset = this.studio.presets().find((p) => p.name === name);
    if (preset === undefined) return;
    this.studio.applyPreset(preset);
    this.name.set(preset.name);
    this.said.set(`Loaded ${preset.name}`);
  }

  protected async save(): Promise<void> {
    const wanted = this.name().trim();
    if (wanted === '') {
      this.said.set('Name the preset first');
      return;
    }
    if (this.studio.presets().some((p) => p.name === wanted)) {
      const replace = await this.confirm.ask({
        title: `Replace the preset ${wanted}?`,
        message: 'It is saved on the server, so every app using this server sees the change.',
        confirm: 'Replace',
        danger: false,
      });
      if (!replace) return;
    }
    this.busy.set(true);
    const refusal = await this.studio.savePreset(wanted);
    this.busy.set(false);
    this.refusal.set(refusal);
    if (refusal === null) {
      this.chosen.set(wanted);
      this.naming.set(false);
      this.said.set(`Saved ${wanted}`);
    } else {
      this.said.set('Not saved');
    }
  }

  protected async remove(gone: string): Promise<void> {
    const yes = await this.confirm.ask({
      title: `Delete the preset ${gone}?`,
      message: 'It is removed from the server for every app that uses it.',
      confirm: 'Delete',
      danger: true,
    });
    if (!yes) return;
    const refusal = await this.studio.deletePreset(gone);
    this.refusal.set(refusal);
    if (refusal === null) {
      if (this.chosen() === gone) this.chosen.set('');
      this.said.set(`Deleted ${gone}`);
    } else {
      this.said.set('Not deleted');
    }
  }
}
