/**
 * clients — who is listening to the hub, and when a browser tab is gone.
 *
 * Every client (the desktop window, a browser tab, the iOS app) names itself on
 * each request with an id and a kind, and listens on one event stream
 * (`GET /api/events`). This tracks those streams, so the hub can send a client
 * its own jobs and takes, and everyone the library.
 *
 * A WEB client's playing list dies with its tab (Owen: the running list "start[s]
 * to clear when the browser closes"). A tab that closes simply stops listening, so
 * when a web client has had no stream for `graceMs` — long enough to cover a
 * reload or a network blip — it is declared closed and `onClosed` clears it. The
 * desktop and iOS clients are never closed this way: a phone that is backgrounded
 * stops listening on purpose (heat, battery) and keeps its list.
 */
import type { ServerResponse } from 'node:http';

import { Refusal } from '../refusal';
import { CLIENT_KINDS, type ClientKind, type HubEvent } from '../../shared/types';

/** How often an idle stream gets a comment line, so proxies and phones keep it open. */
const HEARTBEAT_MS = 25_000;

export interface ClientName {
  readonly id: string;
  readonly kind: ClientKind;
}

/** Read and check a client's id and kind, as a request states them. */
export function clientName(id: unknown, kind: unknown): ClientName {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
    throw new Refusal('client_invalid', 'This request does not say which device it comes from (X-BSide-Client).');
  }
  if (typeof kind !== 'string' || !CLIENT_KINDS.includes(kind as ClientKind)) {
    throw new Refusal('client_kind_invalid', `A device is one of ${CLIENT_KINDS.join(', ')} (X-BSide-Client-Kind).`);
  }
  return { id, kind: kind as ClientKind };
}

export class ClientTracker {
  private readonly streams = new Map<string, Set<ServerResponse>>();
  private readonly kinds = new Map<string, ClientKind>();
  private readonly closing = new Map<string, NodeJS.Timeout>();
  /** Web clients declared closed: a take that lands for one now has nobody to play it. */
  private readonly closed = new Set<string>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly graceMs: number,
    private readonly onClosed: (client: string) => void,
  ) {
    this.heartbeat = setInterval(() => {
      for (const set of this.streams.values()) for (const stream of set) stream.write(': keep-alive\n\n');
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** A client keeps the kind it first said; a different one is a mistake, not a new device. */
  note(client: ClientName): void {
    const known = this.kinds.get(client.id);
    if (known !== undefined && known !== client.kind) {
      throw new Refusal('client_kind_changed', `Device ${client.id} said it was ${known}, and now says ${client.kind}.`);
    }
    this.kinds.set(client.id, client.kind);
    // A tab that comes back after it was cleared starts a fresh playing list.
    this.closed.delete(client.id);
  }

  /**
   * Clients that have takes from before this run and no stream yet (the hub
   * restarted). Web ones get the same grace as a tab that just went quiet.
   */
  adopt(clients: Map<string, ClientKind>): void {
    for (const [id, kind] of clients) {
      if (!this.kinds.has(id)) this.kinds.set(id, kind);
      if (kind === 'web' && !this.streams.has(id)) this.startClosing(id);
    }
  }

  open(client: ClientName, stream: ServerResponse): void {
    this.note(client);
    const timer = this.closing.get(client.id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.closing.delete(client.id);
    }
    let set = this.streams.get(client.id);
    if (set === undefined) {
      set = new Set();
      this.streams.set(client.id, set);
    }
    set.add(stream);
    stream.on('close', () => {
      set.delete(stream);
      if (set.size > 0) return;
      this.streams.delete(client.id);
      if (client.kind === 'web') this.startClosing(client.id);
    });
  }

  /** One event to one client's streams. */
  send(client: string, event: HubEvent): void {
    const set = this.streams.get(client);
    if (set === undefined) return;
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of set) stream.write(line);
  }

  /** One event to every stream. */
  broadcast(event: HubEvent): void {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const set of this.streams.values()) for (const stream of set) stream.write(line);
  }

  /** Whether the client has been declared closed (its tab is gone): nothing more is kept for it. */
  isClosed(client: string): boolean {
    return this.closed.has(client);
  }

  /** End every stream (the hub is stopping or rebinding); clients reconnect on their own. */
  endAll(): void {
    for (const set of this.streams.values()) for (const stream of set) stream.end();
  }

  private startClosing(id: string): void {
    if (this.closing.has(id)) return;
    const timer = setTimeout(() => {
      this.closing.delete(id);
      if (this.streams.has(id)) return;
      this.kinds.delete(id);
      this.closed.add(id);
      console.log(`[hub] web client ${id} has been gone ${Math.round(this.graceMs / 60000)} min; clearing its playing list`);
      this.onClosed(id);
    }, this.graceMs);
    timer.unref();
    this.closing.set(id, timer);
  }
}
