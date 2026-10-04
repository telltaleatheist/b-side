import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import type { RefusalView } from '@shared/types';

import { ConfirmService } from '../../core/confirm.service';
import { StudioService } from '../../core/studio.service';
import { IconComponent } from '../icon/icon.component';

/**
 * Presets kept on the server (the playground presets routes), as a row of
 * pills: tap one to fill the form; "Save as preset" names what the form holds
 * now. A preset is a sound, not a take, so the seed is never saved.
 */
@Component({
  selector: 'app-preset-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
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
        <button type="button" class="chip" [class.on]="preset.name === chosen()" (click)="choose(preset.name)">{{ preset.name }}</button>
      } @empty {
        <span class="hint">No presets yet. Set up a sound you like, then save it here.</span>
      }
    </div>
    @if (chosen() !== '' || said()) {
      <div class="foot">
        @if (said()) { <span class="hint">{{ said() }}</span> }
        @if (chosen() !== '') { <button type="button" class="link" (click)="remove()">Delete {{ chosen() }}</button> }
      </div>
    }
    @if (refusal() ?? studio.presetsRefusal(); as refused) {
      <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
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
    .link { border: none; background: transparent; padding: 0; color: var(--text-tertiary); font-size: 12px; text-decoration: underline; }
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
