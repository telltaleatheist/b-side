/**
 * pairing — add a Crucible server by its address alone (Foundry's
 * crucible-remote-pairing, without its per-window owners).
 *
 *   begin   `startPairing(address)`: ping the address, open a pairing request.
 *           The answer shows the server's name and a short code; on a server
 *           with open pairing (the default) the first poll approves it.
 *   poll    `pollPairing`: pending, denied, expired or approved. Approved
 *           carries the token, which goes straight into the registry: it never
 *           reaches a client, and nor does the request's device code.
 *
 * A session's id is the only handle a client gets; it is random, and the hub's
 * key already gates every call that can name one.
 */

import { pollPairing, startPairing, type Pairing, type PairingRequest } from '@crucible/client';

import type { PairingProgress } from '../types';

interface Session {
  readonly request: PairingRequest;
  readonly view: PairingProgress;
  approved?: Pairing;
  polling?: Promise<PairingProgress>;
}

export class PairingSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly clientName: string,
    /** Store an approved server; answers the name it was stored under. */
    private readonly connect: (pairing: Pairing) => Promise<string>,
    private readonly beginRequest: typeof startPairing = startPairing,
    private readonly pollRequest: typeof pollPairing = pollPairing,
    private readonly now: () => number = Date.now,
  ) {}

  async begin(address: string): Promise<PairingProgress> {
    for (const [id, session] of this.sessions) {
      if (session.view.expiresAt <= this.now()) this.sessions.delete(id);
    }
    const request = await this.beginRequest(address, this.clientName);
    const view: PairingProgress = {
      id: crypto.randomUUID(),
      name: request.name,
      url: request.url,
      userCode: request.userCode,
      approvalRequired: request.approvalRequired,
      expiresAt: this.now() + request.expiresIn * 1000,
      pollAfterMs: Math.max(1000, request.interval * 1000),
      status: 'pending',
    };
    this.sessions.set(view.id, { request, view });
    return { ...view };
  }

  /** One poll at a time per session: a second caller shares the first's answer. */
  async poll(id: string): Promise<PairingProgress> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return { id, name: '', url: '', userCode: '', approvalRequired: false, expiresAt: 0, pollAfterMs: 0, status: 'expired' };
    }
    session.polling ??= this.advance(id, session).finally(() => {
      delete session.polling;
    });
    return session.polling;
  }

  cancel(id: string): void {
    this.sessions.delete(id);
  }

  private async advance(id: string, session: Session): Promise<PairingProgress> {
    if (session.view.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return { ...session.view, status: 'expired' };
    }
    const result = session.approved
      ? { status: 'approved' as const, pairing: session.approved }
      : await this.pollRequest(session.request);
    // Cancelled while the request ran: say nothing was stored.
    if (this.sessions.get(id) !== session) return { ...session.view, status: 'expired' };
    let name = session.view.name;
    if (result.status === 'approved') {
      session.approved = result.pairing;
      name = await this.connect(result.pairing);
    }
    if (result.status !== 'pending') this.sessions.delete(id);
    return { ...session.view, name, status: result.status };
  }
}
