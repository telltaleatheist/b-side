import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';

import { clashesWith, clashText, indexOfTag } from '@shared/tags';

import { api } from '../../core/bside';
import { StudioService } from '../../core/studio.service';

/**
 * Style tags as chips, the Crucible playground's way.
 *
 * Typing a phrase then a comma or Enter commits it as a chip; a paste with
 * commas splits into chips (the input sees the commas); Backspace on an empty
 * box removes the last chip; leaving the box commits what was typed. Under it,
 * the server's suggestions by group: click to add, click again to remove.
 *
 * Conflicts are the server's map: a picked chip that contradicts another picked
 * chip is red, a suggestion that would contradict a picked tag is outlined red,
 * and the tooltip says what it conflicts with and why.
 */
@Component({
  selector: 'app-tag-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="head">
      <label class="label" for="tag-typed">Style tags</label>
      <button type="button" class="ghost small" title="Copy these tags as one comma-separated line"
              [disabled]="studio.tags().length === 0" (click)="copy()">Copy</button>
      @if (copied()) { <span class="hint">Copied</span> }
    </div>
    <div class="box" (click)="focusBox($event)">
      @for (tag of studio.tags(); track tag; let at = $index) {
        <span class="chip" [class.conflict]="conflicts(tag)" [title]="clashTitle(tag)">
          <span>{{ tag }}</span>
          <button type="button" class="x" [attr.aria-label]="'Remove ' + tag" (click)="studio.removeTag(at)">×</button>
        </span>
      }
      <input #typed id="tag-typed" type="text" autocomplete="off" spellcheck="false"
             [placeholder]="studio.tags().length === 0 ? (studio.page()?.tagsPlaceholder ?? 'genre, instruments, voice, language, tempo') : ''"
             (keydown)="key($event)" (input)="typedInput()" (blur)="commit()" />
    </div>
    @if (studio.page()?.tagsHint; as hint) { <p class="hint">{{ hint }}</p> }

    @if (studio.page(); as page) {
      @if (page.suggestions.length > 0) {
        <div class="suggestions">
          <div class="title">Suggestions</div>
          @for (group of page.suggestions; track group.group) {
            <div class="group">
              <span class="group-name">{{ group.group }}</span>
              <div class="pills">
                @for (tag of group.tags; track tag) {
                  <button type="button" class="pill"
                          [class.picked]="picked(tag)"
                          [class.conflict]="clashTitle(tag) !== ''"
                          [title]="clashTitle(tag)"
                          (click)="studio.toggleTag(tag)">{{ tag }}</button>
                }
              </div>
            </div>
          }
        </div>
      }
    }
  `,
  styles: [`
    :host { display: flex; flex-direction: column; gap: 6px; }
    .head { display: flex; align-items: center; gap: 8px; }
    .box {
      display: flex; flex-wrap: wrap; align-items: center; gap: 5px;
      min-height: 36px; padding: 5px 7px;
      border: 1px solid var(--border-default); border-radius: var(--radius-md);
      background: var(--bg-input); cursor: text;
    }
    .box:focus-within { border-color: var(--accent); box-shadow: var(--focus-ring); }
    .box input {
      flex: 1 1 140px; min-width: 120px; width: auto;
      border: 0; outline: none; box-shadow: none; background: transparent; padding: 3px 2px;
    }
    .chip {
      display: inline-flex; align-items: center; gap: 2px;
      padding: 2px 3px 2px 10px; border-radius: 999px;
      font-size: 12px; color: var(--accent);
      background: var(--accent-faint); border: 1px solid var(--accent-strong);
    }
    .chip.conflict { color: var(--error); border-color: var(--error); background: var(--error-soft); }
    .x {
      border: 0; background: transparent; color: inherit; padding: 0 5px;
      font-size: 14px; line-height: 1; cursor: pointer;
    }
    .x:hover:not(:disabled) { background: transparent; color: var(--text-primary); }

    .suggestions {
      margin-top: 4px; padding: 4px 12px 8px;
      border: 1px solid var(--border-subtle); border-radius: var(--radius);
      background: var(--bg-elevated);
    }
    .title { font-size: 11px; color: var(--text-tertiary); padding: 4px 0 2px; }
    .group {
      display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: 10px;
      align-items: start; padding: 7px 0; border-top: 1px solid var(--border-subtle);
    }
    .title + .group { border-top: 0; }
    .group-name {
      font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--text-tertiary); padding-top: 4px;
    }
    .pills { display: flex; flex-wrap: wrap; gap: 5px; }
    .pill {
      font-size: 12px; padding: 2px 9px; border-radius: 999px;
      border: 1px solid var(--border-default); background: var(--bg-input); color: var(--text-secondary);
    }
    .pill:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); background: var(--bg-input); }
    .pill.picked { color: var(--accent); border-color: var(--accent-strong); background: var(--accent-faint); }
    .pill.conflict { border-color: var(--error); color: var(--error); }
    .pill.picked.conflict { background: var(--error-soft); }
  `],
})
export class TagInputComponent {
  protected readonly studio = inject(StudioService);
  protected readonly copied = signal(false);
  private readonly typed = viewChild.required<ElementRef<HTMLInputElement>>('typed');

  protected picked(tag: string): boolean {
    return indexOfTag(this.studio.tags(), tag) >= 0;
  }

  protected conflicts(tag: string): boolean {
    return this.studio.conflicted().has(tag.toLowerCase());
  }

  /** What `tag` contradicts among the picked tags, as a tooltip; '' when nothing. */
  protected clashTitle(tag: string): string {
    return clashText(clashesWith(tag, this.studio.tags(), this.studio.page()?.conflicts ?? {}));
  }

  protected key(event: KeyboardEvent): void {
    const input = this.typed().nativeElement;
    if (event.key === ',' || event.key === 'Enter') {
      event.preventDefault();
      this.commit();
    } else if (event.key === 'Backspace' && input.value === '' && this.studio.tags().length > 0) {
      this.studio.removeTag(this.studio.tags().length - 1);
    }
  }

  /** A comma typed or pasted commits: a pasted "a, b, c" becomes three chips. */
  protected typedInput(): void {
    if (this.typed().nativeElement.value.includes(',')) this.commit();
  }

  protected commit(): void {
    const input = this.typed().nativeElement;
    if (input.value.trim() !== '') this.studio.addTags(input.value);
    input.value = '';
  }

  protected focusBox(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.typed().nativeElement.focus();
  }

  protected async copy(): Promise<void> {
    this.commit();
    if (api === null) return;
    await api.clipboard.write(this.studio.tagLine());
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1500);
  }
}
