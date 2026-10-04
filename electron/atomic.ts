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
  const transient = new Set(['EPERM', 'EBUSY', 'EACCES']);
  for (let wait = 50; ; wait *= 2) {
    try {
      await fsp.rename(temporary, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!transient.has(code) || wait > 800) throw err;
      await new Promise((rest) => setTimeout(rest, wait));
    }
  }
}
