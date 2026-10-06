import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { HubService, parseHubLink } from '../../core/hub.service';

/**
 * Connect this device to a B-Sides hub by its address, as Ollama is reached
 * (`192.168.1.20`), or by the link with its key when that B-Sides requires one. The phone app's first screen,
 * and what a browser tab sees when its key is wrong or was replaced.
 */
@Component({
  selector: 'app-hub-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="picker" (submit)="$event.preventDefault(); connect()">
      <label class="label" for="hub-link">Computer's address</label>
      <input id="hub-link" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
             placeholder="192.168.1.20" [value]="link()" (input)="link.set($any($event.target).value)" />
      <p class="hint">On the computer running B-Sides: Settings → Other devices → turn on sharing; it shows its address.</p>
      <button type="submit" class="primary" [disabled]="link().trim() === ''">Connect</button>
      @if (wrong()) {
        <div class="refusal"><code>link_invalid</code><span>That is not an address: type one like 192.168.1.20 or owens-mac-studio.local</span></div>
      }
    </form>
  `,
  styles: [`
    .picker { display: flex; flex-direction: column; gap: 8px; }
    .picker button { align-self: flex-start; }
  `],
})
export class HubPickerComponent {
  private readonly hub = inject(HubService);
  protected readonly link = signal('');
  protected readonly wrong = signal(false);

  protected connect(): void {
    const address = parseHubLink(this.link());
    this.wrong.set(address === null);
    if (address === null) return;
    this.hub.useHub(address);
    this.link.set('');
  }
}
