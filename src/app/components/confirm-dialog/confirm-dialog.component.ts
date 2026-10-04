import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { ConfirmService } from '../../core/confirm.service';

/** The confirm card: a veil, a title, a sentence, Cancel and the named action. Esc cancels. */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'answer(false)' },
  template: `
    @if (confirm.asked(); as asked) {
      <div class="veil" (click)="answer(false)">
        <div class="dialog card" role="alertdialog" aria-modal="true" (click)="$event.stopPropagation()">
          <h2 class="card-title">{{ asked.title }}</h2>
          <p class="detail">{{ asked.message }}</p>
          <div class="actions">
            <button type="button" class="ghost" (click)="answer(false)">Cancel</button>
            <button type="button" [class.danger]="asked.danger" [class.primary]="!asked.danger" (click)="answer(true)" autofocus>
              {{ asked.confirm }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .veil {
      position: fixed; inset: 0; z-index: 1000;
      display: flex; align-items: center; justify-content: center;
      background: var(--bg-overlay);
      backdrop-filter: blur(3px);
    }
    .dialog { width: min(420px, calc(100vw - 40px)); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5); }
    .actions { display: flex; justify-content: flex-end; gap: 8px; }
  `],
})
export class ConfirmDialogComponent {
  protected readonly confirm = inject(ConfirmService);

  protected answer(yes: boolean): void {
    this.confirm.asked()?.answer(yes);
  }
}
