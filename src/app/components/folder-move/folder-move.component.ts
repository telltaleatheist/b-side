import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';

import type { RefusalView } from '@shared/types';

import { FoldersService, type ShelfItem } from '../../core/folders.service';
import { LibraryService } from '../../core/library.service';
import { IconComponent } from '../icon/icon.component';
import { RefusalComponent } from '../refusal/refusal.component';

/**
 * Move to folder…: the drag and drop's moves as buttons (Victoria, 2026-10-11), so an album, a
 * playlist or a folder can be filed, taken out, or put earlier or later on the phone (which has no
 * drag) and from the keyboard. A new folder can be made here too, and the item goes straight in.
 */
@Component({
  selector: 'app-folder-move',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, RefusalComponent],
  template: `
    <div class="move" role="group" [attr.aria-label]="'Move ' + name()">
      <span class="kicker">Move to</span>
      <div class="places">
        <button type="button" class="place" [class.here]="here() === null" [disabled]="here() === null" (click)="to(null)">
          <app-icon name="library" [size]="16" />Top of the library@if (here() === null) {<span class="hint"> · here now</span>}
        </button>
        @for (row of rows(); track row.folder.id) {
          <button type="button" class="place" [style.padding-left.px]="12 + row.depth * 16" [class.here]="here() === row.folder.id"
                  [disabled]="here() === row.folder.id" (click)="to(row.folder.id)">
            <app-icon name="folder" [size]="16" />{{ row.folder.name }}@if (here() === row.folder.id) {<span class="hint"> · here now</span>}
          </button>
        }
      </div>
      @if (naming()) {
        <form class="new" (submit)="$event.preventDefault(); makeFolder(nameBox.value)">
          <input #nameBox type="text" maxlength="120" placeholder="New folder name" aria-label="New folder name" autofocus />
          <button type="submit" class="ghost small">Make and move</button>
        </form>
      }
      <div class="acts">
        <button type="button" class="ghost small" (click)="naming.set(!naming())"><app-icon name="plus" [size]="15" />New folder…</button>
        <button type="button" class="ghost small" [disabled]="!folders.canShift(item(), -1)" (click)="shift(-1)" title="One place earlier where it is"><app-icon name="down" [size]="15" class="flip-v" />Earlier</button>
        <button type="button" class="ghost small" [disabled]="!folders.canShift(item(), 1)" (click)="shift(1)" title="One place later where it is"><app-icon name="down" [size]="15" />Later</button>
        <button type="button" class="ghost small" (click)="done.emit()">Done</button>
      </div>
      @if (refusal(); as refused) { <app-refusal [refusal]="refused" /> }
    </div>
  `,
  styles: [`
    .move { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--border-default); border-radius: var(--radius-md); background: var(--bg-elevated); max-width: 520px; }
    .places { display: flex; flex-direction: column; max-height: 260px; overflow-y: auto; }
    .place {
      display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 6px 12px; border: none; border-radius: var(--radius-md);
      background: transparent; color: var(--text-primary); font-size: 14px; text-align: left; cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .place:hover:not(:disabled) { background: var(--bg-hover); }
    .place:disabled { cursor: default; color: var(--text-tertiary); }
    .place.here { color: var(--accent); }
    .acts { display: flex; flex-wrap: wrap; gap: 6px; }
    .new { display: flex; gap: 8px; }
    .new input { flex: 1; min-width: 0; }
    .flip-v { transform: scaleY(-1); }
  `],
})
export class FolderMoveComponent {
  protected readonly folders = inject(FoldersService);
  private readonly library = inject(LibraryService);

  readonly item = input.required<ShelfItem>();
  readonly done = output();
  protected readonly naming = signal(false);
  protected readonly refusal = signal<RefusalView | null>(null);

  protected readonly name = computed(() => {
    const item = this.item();
    return (item.kind === 'playlist' ? this.library.playlist(item.id)?.name : this.library.folder(item.id)?.name) ?? '';
  });
  protected readonly here = computed(() => this.folders.whereIs(this.item()));
  /** Every folder, as shown; moving a folder, never itself or the folders inside it, nor one too deep to hold it. */
  protected readonly rows = computed(() => {
    const item = this.item();
    return this.library.folderRows().filter((row) => item.kind === 'playlist' || this.folders.canHold(item.id, row.folder.id));
  });

  protected async to(folder: string | null): Promise<void> {
    const refusal = await this.folders.place(this.item(), folder);
    this.refusal.set(refusal);
    if (refusal === null) this.done.emit();
  }

  protected async shift(by: -1 | 1): Promise<void> {
    this.refusal.set(await this.folders.shift(this.item(), by));
  }

  /** A new folder at the top of the library, and the item straight into it. */
  protected async makeFolder(name: string): Promise<void> {
    if (name.trim() === '') return;
    const made = await this.library.createFolder(name, null);
    if ('code' in made) {
      this.refusal.set(made);
      return;
    }
    this.naming.set(false);
    await this.to(made.id);
  }
}
