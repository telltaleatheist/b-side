/**
 * servers — the Crucible servers B-Side knows, and which one it uses.
 *
 * Stored as `<userData>/servers.json`:
 *
 *   { "active": "<name>" | null, "servers": [{ "name", "url", "token" }] }
 *
 * The NAME is the key (it is what a pairing line carries and what a song's
 * sidecar records). Tokens live only here and in main's memory: every view the
 * renderer gets says `hasToken`, never the token itself.
 *
 * The class takes its file path rather than asking Electron for it, so the
 * tests run it without an Electron process.
 */
import * as fs from 'node:fs';

import { parsePairing } from '@crucible/client';

import { writeAtomically } from './atomic';
import { Refusal } from './refusal';
import type { ServerInput, ServerView } from '../shared/types';

export interface StoredServer {
  readonly name: string;
  readonly url: string;
  readonly token: string;
}

interface Document {
  active: string | null;
  servers: StoredServer[];
}

/** A base URL as the SDK wants it: http(s), no trailing slash, no `/v1`. */
export function normaliseUrl(raw: string): string {
  let url = raw.trim();
  if (url === '') throw new Refusal('server_url_missing', 'A server needs its address, e.g. http://192.168.1.20:7100');
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Refusal('server_url_invalid', `${raw.trim()} is not an address B-Side can reach (e.g. http://192.168.1.20:7100)`);
  }
  const pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

export class ServerRegistry {
  constructor(private readonly file: string) {}

  /** The file as stored, or an empty registry when there is none yet. */
  private read(): Document {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { active: null, servers: [] };
      throw err;
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Document).servers)) {
      throw new Refusal('servers_unreadable', `${this.file} is not a B-Side server list; move it aside to start over.`);
    }
    const document = parsed as Document;
    return {
      active: typeof document.active === 'string' ? document.active : null,
      servers: document.servers.filter(
        (s): s is StoredServer =>
          typeof s?.name === 'string' && typeof s.url === 'string' && typeof s.token === 'string',
      ),
    };
  }

  private async write(document: Document): Promise<void> {
    await writeAtomically(this.file, `${JSON.stringify(document, null, 2)}\n`);
  }

  views(): ServerView[] {
    const document = this.read();
    return document.servers.map((server) => ({
      name: server.name,
      url: server.url,
      hasToken: server.token !== '',
      active: server.name === document.active,
    }));
  }

  /** The stored entry, token included — main only. */
  get(name: string): StoredServer {
    const found = this.read().servers.find((server) => server.name === name);
    if (found === undefined) throw new Refusal('unknown_server', `B-Side has no server named ${name}.`);
    return found;
  }

  /** The server jobs go to, or a refusal that says how to get one. */
  active(): StoredServer {
    const document = this.read();
    const found = document.servers.find((server) => server.name === document.active);
    if (found === undefined) {
      throw new Refusal('no_server', 'No Crucible server is chosen. Add one in Settings (paste its pairing line).');
    }
    return found;
  }

  /** Add the server a `crucible://` line names. The same name again replaces its url and token. */
  async addPairing(line: string): Promise<ServerView[]> {
    const pairing = parsePairing(line);
    return this.put({ name: pairing.name, url: pairing.url, token: pairing.token }, null);
  }

  /**
   * The stored entry at this address, token included — main only. Null when none
   * points there. Two addresses are one server when they normalise the same
   * (`URL` lower-cases the host and drops a default port).
   */
  atAddress(url: string): StoredServer | null {
    const wanted = normaliseUrl(url);
    return this.read().servers.find((server) => normaliseUrl(server.url) === wanted) ?? null;
  }

  /**
   * Use the Crucible this computer published (its pairing file), and make it the
   * one in use.
   *
   * An entry already at that ADDRESS keeps its name — the person may have
   * renamed it — and takes the published token, because the pairing file is the
   * token's one owner: a reinstall rotates it, and pressing this again is the
   * repair for the 401 that follows. Otherwise the server is added under the
   * name the line carries, exactly as a pasted pairing line is.
   */
  async usePublished(published: { name: string; url: string; token: string }): Promise<{ name: string; servers: ServerView[] }> {
    const existing = this.atAddress(published.url);
    const name = existing?.name ?? published.name;
    await this.put({ name, url: published.url, token: published.token }, existing?.name ?? null);
    return { name, servers: await this.setActive(name) };
  }

  /**
   * Store a server paired by its address, and answer the name it is under.
   * Pairing the same address again is the repair for a rotated token: the entry
   * keeps its name and takes the new token. It becomes the one in use only when
   * none is; switching is the person's choice, in Settings.
   */
  async addPaired(pairing: { name: string; url: string; token: string }): Promise<string> {
    const existing = this.atAddress(pairing.url);
    const name = existing?.name ?? pairing.name;
    await this.put({ name, url: pairing.url, token: pairing.token }, existing?.name ?? null);
    return name;
  }

  async add(input: ServerInput): Promise<ServerView[]> {
    const name = input.name.trim();
    if (this.read().servers.some((server) => server.name === name)) {
      throw new Refusal('server_name_taken', `There is already a server named ${name}; edit that one instead.`);
    }
    if (input.token === null || input.token.trim() === '') {
      throw new Refusal('server_token_missing', 'A server needs its token (or paste its pairing line instead).');
    }
    return this.put({ name, url: input.url, token: input.token.trim() }, null);
  }

  async update(previous: string, input: ServerInput): Promise<ServerView[]> {
    const stored = this.get(previous);
    const token = input.token === null || input.token.trim() === '' ? stored.token : input.token.trim();
    return this.put({ name: input.name.trim(), url: input.url, token }, previous);
  }

  /** Write one entry, replacing `replacing` (an edit) or a same-named entry (a re-pair). */
  private async put(entry: StoredServer, replacing: string | null): Promise<ServerView[]> {
    const name = entry.name.trim();
    if (name === '') throw new Refusal('server_name_missing', 'A server needs a name.');
    const url = normaliseUrl(entry.url);
    const document = this.read();
    if (replacing !== null && replacing !== name && document.servers.some((s) => s.name === name)) {
      throw new Refusal('server_name_taken', `There is already a server named ${name}.`);
    }
    const next: StoredServer = { name, url, token: entry.token };
    const at = document.servers.findIndex((server) => server.name === (replacing ?? name));
    if (at >= 0) document.servers[at] = next;
    else document.servers.push(next);
    if (replacing !== null && document.active === replacing) document.active = name;
    // The first server is the one to use: there is no other choice to make.
    if (document.active === null || !document.servers.some((s) => s.name === document.active)) {
      document.active = name;
    }
    await this.write(document);
    return this.views();
  }

  async remove(name: string): Promise<ServerView[]> {
    const document = this.read();
    if (!document.servers.some((server) => server.name === name)) {
      throw new Refusal('unknown_server', `B-Side has no server named ${name}.`);
    }
    document.servers = document.servers.filter((server) => server.name !== name);
    if (document.active === name) document.active = document.servers[0]?.name ?? null;
    await this.write(document);
    return this.views();
  }

  async setActive(name: string): Promise<ServerView[]> {
    const document = this.read();
    if (!document.servers.some((server) => server.name === name)) {
      throw new Refusal('unknown_server', `B-Side has no server named ${name}.`);
    }
    document.active = name;
    await this.write(document);
    return this.views();
  }
}
