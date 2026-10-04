/**
 * settings — B-Side's own preferences, `<userData>/settings.json`.
 *
 *   libraryDir  where saved songs and playlists live; absent means `<Music>/B-Side`
 *   sharing     whether the hub listens beyond this computer (default: no)
 *   hubPort     the hub's port (default DEFAULT_HUB_PORT); edit the file to change it
 *   hubKey      the key every hub request carries; made on first run, replaced
 *               from Settings (which signs every other device out)
 *
 * Unknown keys are kept on write, so a newer B-Side's settings survive an older
 * one saving over them.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeAtomically } from './atomic';
import { Refusal } from './refusal';
import { DEFAULT_HUB_PORT } from '../shared/types';

export interface StoredSettings {
  readonly libraryDir: string;
  readonly defaultLibraryDir: string;
  readonly sharing: boolean;
  readonly port: number;
  readonly key: string;
}

function newKey(): string {
  return randomBytes(24).toString('base64url');
}

export class AppSettings {
  constructor(
    private readonly file: string,
    readonly defaultLibraryDir: string,
  ) {}

  private read(): Record<string, unknown> {
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Refusal('settings_unreadable', `${this.file} is not a JSON object; move it aside to start over.`);
    }
    return parsed as Record<string, unknown>;
  }

  private async write(document: Record<string, unknown>): Promise<void> {
    await writeAtomically(this.file, `${JSON.stringify(document, null, 2)}\n`);
  }

  /** The hub's key, made and written the first time it is asked for. */
  async ensureKey(): Promise<void> {
    const document = this.read();
    if (typeof document['hubKey'] === 'string' && document['hubKey'] !== '') return;
    document['hubKey'] = newKey();
    await this.write(document);
  }

  view(): StoredSettings {
    const document = this.read();
    const stored = document['libraryDir'];
    const port = document['hubPort'];
    const key = document['hubKey'];
    if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new Refusal('settings_port_invalid', `hubPort in ${this.file} must be a port number (1-65535), not ${JSON.stringify(port)}.`);
    }
    if (typeof key !== 'string' || key === '') {
      throw new Refusal('settings_key_missing', `${this.file} has no hubKey; ensureKey() runs before the hub starts.`);
    }
    return {
      libraryDir: typeof stored === 'string' && stored !== '' ? stored : this.defaultLibraryDir,
      defaultLibraryDir: this.defaultLibraryDir,
      sharing: document['sharing'] === true,
      port: typeof port === 'number' ? port : DEFAULT_HUB_PORT,
      key,
    };
  }

  /** Set the library folder; null goes back to the default. */
  async setLibraryDir(dir: string | null): Promise<StoredSettings> {
    const document = this.read();
    if (dir === null) delete document['libraryDir'];
    else document['libraryDir'] = path.resolve(dir);
    await this.write(document);
    return this.view();
  }

  async setSharing(sharing: boolean): Promise<StoredSettings> {
    const document = this.read();
    document['sharing'] = sharing;
    await this.write(document);
    return this.view();
  }

  /** A new key: every device that had the old one must be given the new link. */
  async replaceKey(): Promise<StoredSettings> {
    const document = this.read();
    document['hubKey'] = newKey();
    await this.write(document);
    return this.view();
  }
}
