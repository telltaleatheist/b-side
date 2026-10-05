import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { HubService, parseHubLink } from '../../core/hub.service';

/**
 * Connect this device to a B-Sides hub: paste the link the desktop's Settings
 * shows (`http://<computer>:<port>/#key=...`). The phone app's first screen,
 * and what a browser tab sees when its key is wrong or was replaced.
 */
@Component({
  selector: 'app-hub-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="picker" (submit)="$event.preventDefault(); connect()">
      <label class="label" for="hub-link">B-Sides link</label>
      <input id="hub-link" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
             placeholder="http://192.168.1.20:7300/#key=…" [value]="link()" (input)="link.set($any($event.target).value)" />
      <p class="hint">On the computer running B-Sides: Settings → Other devices → turn on sharing, then copy a link.</p>
      <button type="submit" class="primary" [disabled]="link().trim() === ''">Connect</button>
      @if (wrong()) {
        <div class="refusal"><code>link_invalid</code><span>That is not a B-Sides link: it looks like http://computer:7300/#key=…</span></div>
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
