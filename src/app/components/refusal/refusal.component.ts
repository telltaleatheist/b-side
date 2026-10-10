import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { RefusalView } from '@shared/types';

/**
 * Split a refusal's message into its lead, the first sentence of its first line,
 * and the rest. A server's message can carry a whole engine log after its cause
 * (Victoria's failed loads, 2026-10-10: forty log lines and the cause cut off);
 * the cause is what a person needs to read first.
 */
export function leadOf(message: string): { lead: string; rest: string } {
  const text = message.trim();
  const firstLine = text.split('\n')[0] ?? '';
  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(firstLine);
  const lead = sentence?.[1] ?? firstLine;
  return { lead, rest: text.slice(lead.length).trim() };
}

/** A refusal: its code, its first sentence prominent, and anything after that folded away. */
@Component({
  selector: 'app-refusal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="refusal">
      <code>{{ refusal().code }}</code>
      <span class="lead">{{ parts().lead }}</span>
      @if (parts().rest !== '') {
        <details>
          <summary>More</summary>
          <pre>{{ parts().rest }}</pre>
        </details>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .lead { font-weight: 600; }
    details summary { cursor: pointer; color: var(--text-secondary); font-size: 12px; }
    pre { margin: 6px 0 0; max-height: 240px; overflow: auto; white-space: pre-wrap; font-size: 11px; color: var(--text-secondary); }
  `],
})
export class RefusalComponent {
  readonly refusal = input.required<RefusalView>();
  protected readonly parts = computed(() => leadOf(this.refusal().message));
}
