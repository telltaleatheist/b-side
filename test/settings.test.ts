import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AppSettings } from '../electron/settings';

test('sharing is on by default, and off only once turned off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-settings-'));
  try {
    const settings = new AppSettings(path.join(dir, 'settings.json'), path.join(dir, 'library'));
    await settings.ensureKey();
    expect(settings.view().sharing).toBe(true);
    expect((await settings.setSharing(false)).sharing).toBe(false);
    expect(settings.view().sharing).toBe(false);
    expect((await settings.setSharing(true)).sharing).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
