import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import type { Outcome, RefusalView, ServerProbe, ServerView } from '@shared/types';

import { api } from '../../core/bside';
import { ConfirmService } from '../../core/confirm.service';
import { ServersService } from '../../core/servers.service';

interface Editing {
  readonly name: string;
  readonly url: string;
  readonly newName: string;
  readonly token: string;
}

/**
 * The Crucible servers B-Side can use, and the one it does.
 *
 * Add one by pasting its pairing line (`crucible://<name>@<host>:<port>/#<token>`,
 * what Crucible's console and `crucible pair` print) or by typing its address
 * and token. The token field is write-only: this card is never told a stored
 * token, so editing a server leaves the token box empty and empty keeps it.
 */
@Component({
  selector: 'app-servers-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card">
      <h2 class="card-title">Crucible servers</h2>
      <p class="detail">B-Side sends every song to the server marked "in use". Its songs, presets and tag suggestions come from that server.</p>

      @for (server of servers.servers(); track server.name) {
        <div class="server" [class.active]="server.active">
          @if (editing()?.name === server.name) {
            <div class="grid">
              <label class="field"><span class="label">Name</span>
                <input type="text" [value]="editing()!.newName" (input)="setEdit('newName', $any($event.target).value)" /></label>
              <label class="field"><span class="label">Address</span>
                <input type="text" [value]="editing()!.url" (input)="setEdit('url', $any($event.target).value)" /></label>
              <label class="field"><span class="label">Token</span>
                <input type="password" autocomplete="off" placeholder="unchanged — type to replace"
                       (input)="setEdit('token', $any($event.target).value)" /></label>
            </div>
            <div class="actions">
              <button type="button" class="primary small" (click)="saveEdit()">Save</button>
              <button type="button" class="ghost small" (click)="editing.set(null)">Cancel</button>
            </div>
          } @else {
            <div class="top">
              <span class="name">{{ server.name }}</span>
              @if (server.active) { <span class="badge">in use</span> }
              <span class="url mono">{{ server.url }}</span>
              @if (!server.hasToken) { <span class="warn">no token</span> }
            </div>
            <div class="actions">
              @if (!server.active) {
                <button type="button" class="primary small" (click)="run(server.name, api!.servers.setActive(server.name))">Use this server</button>
              }
              <button type="button" class="ghost small" [disabled]="testing() === server.name" (click)="test(server)">
                {{ testing() === server.name ? 'Testing…' : 'Test connection' }}
              </button>
              <button type="button" class="ghost small" (click)="edit(server)">Edit</button>
              <button type="button" class="danger small" (click)="remove(server)">Remove</button>
            </div>
          }
          @if (probes()[server.name]; as probe) {
            <p class="ok">Connected: {{ probe.name }} · Crucible {{ probe.version }} · {{ probe.backend }}@if (!probe.audio) { — <span class="warn">this server does not offer audio jobs</span>}</p>
          }
          @if (refusals()[server.name]; as refused) {
            <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
          }
        </div>
      } @empty {
        <p class="notice">No server yet. Paste a pairing line below.</p>
      }

      <div class="add">
        <span class="label">Add a server from its pairing line</span>
        <div class="line">
          <input type="password" autocomplete="off" spellcheck="false" placeholder="crucible://name@host:7100/#token"
                 [value]="pairing()" (input)="pairing.set($any($event.target).value)" (keydown.enter)="addPairing()" />
          <button type="button" class="primary" [disabled]="pairing().trim() === ''" (click)="addPairing()">Add</button>
        </div>
        <p class="hint">The line holds the server's token, so the box hides it. Crucible prints it on its console page and with "crucible pair".</p>
      </div>

      <details class="add">
        <summary class="label">…or enter an address and token by hand</summary>
        <div class="grid">
          <label class="field"><span class="label">Name</span>
            <input type="text" placeholder="PC" [value]="handName()" (input)="handName.set($any($event.target).value)" /></label>
          <label class="field"><span class="label">Address</span>
            <input type="text" placeholder="http://192.168.1.20:7100" [value]="handUrl()" (input)="handUrl.set($any($event.target).value)" /></label>
          <label class="field"><span class="label">Token</span>
            <input type="password" autocomplete="off" [value]="handToken()" (input)="handToken.set($any($event.target).value)" /></label>
        </div>
        <div class="actions"><button type="button" class="primary small" (click)="addByHand()">Add server</button></div>
      </details>

      @if (addRefusal(); as refused) {
        <div class="refusal"><code>{{ refused.code }}</code><span>{{ refused.message }}</span></div>
      }
    </div>
  `,
  styles: [`
    .server {
      display: flex; flex-direction: column; gap: 6px;
      border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: 8px 10px;
    }
    .server.active { border-color: var(--accent-strong); }
    .top { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .name { font-weight: 600; }
    .url { font-size: 11.5px; color: var(--text-secondary); }
    .badge {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--ok); background: var(--ok-soft); border-radius: 999px; padding: 2px 8px;
    }
    .warn { color: var(--warn); font-size: 12px; }
    .ok { color: var(--ok); font-size: 12px; margin: 0; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .add { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border-subtle); padding-top: 10px; }
    details.add > summary { cursor: pointer; }
    .line { display: flex; gap: 6px; }
    .grid { display: grid; grid-template-columns: 1fr 2fr 2fr; gap: 8px; }
    .field { display: flex; flex-direction: column; gap: 4px; }
  `],
})
export class ServersCardComponent {
  protected readonly servers = inject(ServersService);
  private readonly confirm = inject(ConfirmService);
  protected readonly api = api;

  protected readonly pairing = signal('');
  protected readonly handName = signal('');
  protected readonly handUrl = signal('');
  protected readonly handToken = signal('');
  protected readonly addRefusal = signal<RefusalView | null>(null);

  protected readonly editing = signal<Editing | null>(null);
  protected readonly testing = signal<string | null>(null);
  protected readonly probes = signal<Record<string, ServerProbe>>({});
  protected readonly refusals = signal<Record<string, RefusalView>>({});

  protected async addPairing(): Promise<void> {
    if (api === null) return;
    const outcome = await api.servers.addPairing(this.pairing());
    this.addRefusal.set(outcome.ok ? null : outcome.refusal);
    if (outcome.ok) this.pairing.set('');
  }

  protected async addByHand(): Promise<void> {
    if (api === null) return;
    const outcome = await api.servers.add({ name: this.handName(), url: this.handUrl(), token: this.handToken() });
    this.addRefusal.set(outcome.ok ? null : outcome.refusal);
    if (outcome.ok) {
      this.handName.set('');
      this.handUrl.set('');
      this.handToken.set('');
    }
  }

  protected edit(server: ServerView): void {
    this.editing.set({ name: server.name, newName: server.name, url: server.url, token: '' });
  }

  protected setEdit(field: 'url' | 'newName' | 'token', value: string): void {
    this.editing.update((editing) => (editing === null ? null : { ...editing, [field]: value }));
  }

  protected async saveEdit(): Promise<void> {
    const editing = this.editing();
    if (api === null || editing === null) return;
    const ok = await this.run(editing.name, api.servers.update(editing.name, {
      name: editing.newName,
      url: editing.url,
      token: editing.token === '' ? null : editing.token,
    }));
    if (ok) this.editing.set(null);
  }

  protected async remove(server: ServerView): Promise<void> {
    if (api === null) return;
    const yes = await this.confirm.ask({
      title: `Remove ${server.name}?`,
      message: 'B-Side forgets its address and token. Songs it made stay in your library.',
      confirm: 'Remove',
      danger: true,
    });
    if (yes) await this.run(server.name, api.servers.remove(server.name));
  }

  protected async test(server: ServerView): Promise<void> {
    if (api === null) return;
    this.testing.set(server.name);
    const outcome = await api.servers.test(server.name);
    this.testing.set(null);
    this.probes.update((all) => {
      const next = { ...all };
      if (outcome.ok) next[server.name] = outcome.value;
      else delete next[server.name];
      return next;
    });
    this.note(server.name, outcome.ok ? null : outcome.refusal);
  }

  /** Run a change to one server; its refusal shows on that server's row. */
  protected async run(name: string, pending: Promise<Outcome<ServerView[]>>): Promise<boolean> {
    const outcome = await pending;
    this.note(name, outcome.ok ? null : outcome.refusal);
    return outcome.ok;
  }

  private note(name: string, refusal: RefusalView | null): void {
    this.refusals.update((all) => {
      const next = { ...all };
      if (refusal === null) delete next[name];
      else next[name] = refusal;
      return next;
    });
  }
}
