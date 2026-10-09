/**
 * atomic — write a file so that an interruption leaves the old one intact.
 *
 * Bytes go to a sibling temporary and are renamed into place (a rename is
 * atomic on one volume). On Windows the rename can fail for a few milliseconds
 * while an antivirus or indexer holds the fresh file (EPERM/EBUSY/EACCES), so it
 * retries briefly; a lock that outlives the retries is a real failure and throws.
 * Same function as Foundry's electron/atomic.ts.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

export async function writeAtomically(destination: string, bytes: Uint8Array | string): Promise<void> {
  const target = path.resolve(destination);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.writing`;
  await fsp.writeFile(temporary, bytes);
  await renameIntoPlace(temporary, target);
}

const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Rename a finished file onto its final name. The one place every rename onto a
 * final name goes through, so the Windows retry is not something a caller can
 * forget. The budget (~6 s) covers an antivirus scanning a fresh multi-MB song,
 * and a player closing the file it was reading; a lock that outlives it throws.
 */
export async function renameIntoPlace(temporary: string, target: string): Promise<void> {
  for (let wait = 50; ; wait *= 2) {
    try {
      await fsp.rename(temporary, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT.has(code) || wait > 3200) throw err;
      await new Promise((rest) => setTimeout(rest, wait));
    }
  }
}
