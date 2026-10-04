/**
 * settings — B-Side's own preferences, `<userData>/settings.json`.
 *
 * One key today: `libraryDir`, absent meaning the default `<Music>/B-Side`.
 * Unknown keys are kept on write, so a newer B-Side's settings survive an older
 * one saving over them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeAtomically } from './atomic';
import { Refusal } from './refusal';
import type { AppSettingsView } from '../shared/types';

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

  view(): AppSettingsView {
    const stored = this.read()['libraryDir'];
    return {
      libraryDir: typeof stored === 'string' && stored !== '' ? stored : this.defaultLibraryDir,
      defaultLibraryDir: this.defaultLibraryDir,
    };
  }

  /** Set the library folder; null goes back to the default. */
  async setLibraryDir(dir: string | null): Promise<AppSettingsView> {
    const document = this.read();
    if (dir === null) delete document['libraryDir'];
    else document['libraryDir'] = path.resolve(dir);
    await writeAtomically(this.file, `${JSON.stringify(document, null, 2)}\n`);
    return this.view();
  }
}
