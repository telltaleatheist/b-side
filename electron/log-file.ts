/**
 * log-file — everything the app says on its console, also kept in a file, so a problem on
 * someone else's computer can be read afterwards (crucible-pc-1, 2026-10-11: Victoria's album
 * failed "ran out of room", and B-Sides on Windows kept no log to say why).
 *
 * `<userData>/logs/b-sides.log`, each line stamped with the time. Past LOG_MAX it is moved to
 * `b-sides.1.log` (one older file kept) and a new one begun. A log that cannot be written never
 * stops the app: the console still says it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { format } from 'node:util';

const LOG_MAX = 5 * 1024 * 1024;

export function keepLog(dir: string): string {
  const file = path.join(dir, 'b-sides.log');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return file;
  }
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    // No log yet.
  }
  const write = (level: string, args: unknown[]): void => {
    try {
      if (size > LOG_MAX) {
        fs.renameSync(file, path.join(dir, 'b-sides.1.log'));
        size = 0;
      }
      const line = `${new Date().toISOString()} ${level} ${format(...args)}\n`;
      fs.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch {
      // Unwritable: the console still has it.
    }
  };
  for (const [level, method] of [['info', 'log'], ['warn', 'warn'], ['error', 'error']] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]): void => {
      original(...args);
      write(level, args);
    };
  }
  return file;
}
