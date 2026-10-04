import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';

import type { Playlist, RefusalView, Take } from '@shared/types';

import { LibraryService } from '../../core/library.service';

/**
 * "Save to playlist" for one take: each playlist (a tick where the song already
 * is), and a box to make a new one and save into it in one go.
 */
@Component({
  selector: 'app-save-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="menu">
      @for (playlist of library.playlists(); track playlist.id) {
        <button type="button" class="row" [disabled]="busy() || holds(playlist)" (click)="save(playlist.id)">
          <span class="tick">{{ holds(playlist) ? '✓' : '+' }}</span>{{ playlist.name }}
        </button>
      }
      <form class="new" (submit)="$event.preventDefault(); create()">
        <input type="text" maxlength="120" placeholder="New playlist" [value]="name()"
               (input)="name.set($any($event.target).value)" />
        <button type="submit" class="primary small" [disabled]="busy() || name().trim() === ''">Make and save</button>
      </form>
      @if (refusal(); as refused) {
        <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
      }
      <button type="button" class="ghost small done" (click)="closed.emit()">Done</button>
    </div>
  `,
  styles: [`
    .menu {
      display: flex; flex-direction: column; gap: 4px; margin-top: 4px; padding: 8px;
      border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--bg-input);
    }
    .row {
      display: flex; align-items: center; gap: 6px; justify-content: flex-start;
      height: 26px; padding: 0 8px; border: 0; background: transparent; font-size: 12px; text-align: left;
    }
    .row:hover:not(:disabled) { background: var(--bg-hover); }
    .row:disabled { opacity: 0.7; cursor: default; }
    .tick { width: 12px; color: var(--accent); }
    .new { display: flex; gap: 6px; margin-top: 2px; }
    .new input { flex: 1; min-width: 0; height: 26px; font-size: 12px; }
    .done { align-self: flex-end; }
  `],
})
export class SaveMenuComponent {
  protected readonly library = inject(LibraryService);
  readonly take = input.required<Take>();
  readonly closed = output<void>();

  protected readonly name = signal('');
  protected readonly busy = signal(false);
  protected readonly refusal = signal<RefusalView | null>(null);

  protected holds(playlist: Playlist): boolean {
    const saved = this.take().savedAs;
    return saved !== null && playlist.songs.includes(saved);
  }

  protected async save(playlistId: string): Promise<void> {
    this.busy.set(true);
    this.refusal.set(await this.library.saveTake(this.take(), playlistId));
    this.busy.set(false);
  }

  protected async create(): Promise<void> {
    this.busy.set(true);
    const made = await this.library.createPlaylist(this.name());
    if ('code' in made) {
      this.refusal.set(made);
      this.busy.set(false);
      return;
    }
    this.name.set('');
    await this.save(made.id);
  }
}
