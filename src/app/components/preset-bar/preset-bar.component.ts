import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import type { RefusalView } from '@shared/types';

import { ConfirmService } from '../../core/confirm.service';
import { StudioService } from '../../core/studio.service';

/**
 * Presets kept on the server (the playground presets routes): choose one to
 * fill the form, name the form and Save, or Delete the chosen one. A preset is a
 * sound, not a take, so the seed is never saved.
 */
@Component({
  selector: 'app-preset-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <select aria-label="Presets" (change)="choose($any($event.target).value)">
      <option value="" [selected]="chosen() === ''">{{ studio.presets().length ? 'Load a preset…' : 'No presets yet' }}</option>
      @for (preset of studio.presets(); track preset.name) {
        <option [value]="preset.name" [selected]="preset.name === chosen()">{{ preset.name }}</option>
      }
    </select>
    <button type="button" class="ghost small" [disabled]="chosen() === ''" (click)="remove()">Delete</button>
    <input type="text" class="name" maxlength="80" placeholder="Preset name"
           [value]="name()" (input)="name.set($any($event.target).value)" (keydown.enter)="save()" />
    <button type="button" class="ghost small" [disabled]="busy()" (click)="save()">Save preset</button>
    @if (said()) { <span class="hint">{{ said() }}</span> }
    @if (refusal() ?? studio.presetsRefusal(); as refused) {
      <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
    }
  `,
  styles: [`
    :host {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
      padding-bottom: 12px; border-bottom: 1px solid var(--border-subtle);
    }
    select { width: 200px; padding-top: 4px; padding-bottom: 4px; }
    input.name { width: 180px; padding-top: 4px; padding-bottom: 4px; }
    .refusal { flex-basis: 100%; }
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
      this.said.set(`Saved ${wanted}`);
    } else {
      this.said.set('Not saved');
    }
  }

  protected async remove(): Promise<void> {
    const gone = this.chosen();
    if (gone === '') return;
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
      this.chosen.set('');
      this.said.set(`Deleted ${gone}`);
    } else {
      this.said.set('Not deleted');
    }
  }
}
