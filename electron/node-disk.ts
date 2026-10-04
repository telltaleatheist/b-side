/**
 * node-disk — the shared core's `Disk` over Node's fs, for the desktop hub.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

import { writeAtomically } from './atomic';
import type { Vault } from '../shared/core/servers';
import type { Disk } from '../shared/core/disk';

function missing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

export const nodeDisk: Disk = {
  async mkdir(dir) {
    await fsp.mkdir(dir, { recursive: true });
  },
  async list(dir) {
    try {
      return await fsp.readdir(dir);
    } catch (err) {
      if (missing(err)) return null;
      throw err;
    }
  },
  async readText(file) {
    try {
      return await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (missing(err)) return null;
      throw err;
    }
  },
  writeText: (file, text) => writeAtomically(file, text),
  async exists(file) {
    try {
      await fsp.access(file);
      return true;
    } catch {
      return false;
    }
  },
  async move(from, to) {
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
  },
  async copy(from, to) {
    const temporary = `${to}.writing`;
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.copyFile(from, temporary);
    await fsp.rename(temporary, to);
  },
  async remove(file) {
    await fsp.rm(file, { force: true });
  },
};

/** The server list as a file (`<userData>/servers.json`). */
export function fileVault(file: string): Vault {
  return {
    where: file,
    read: () => nodeDisk.readText(file),
    write: (text) => writeAtomically(file, text),
  };
}
