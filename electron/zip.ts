/**
 * zip — write a .zip of files and texts, stored (not compressed): an album's audio is already
 * compressed, so deflating it would cost time for nothing (Victoria, 2026-10-10: "I love that I
 * can download individual songs, but I can't do that for albums").
 *
 * Each file is read twice, once for its CRC and once into the zip, so a song is never held in
 * memory whole. Names are UTF-8 (flag bit 11). Zip32: past 4 GiB or 65,535 entries it refuses.
 */
import { createReadStream, createWriteStream, promises as fsp } from 'node:fs';
import { once } from 'node:events';

import { writeAtomically } from './atomic';

/** One entry: a file on disk, or a text written as UTF-8. */
export type ZipEntry =
  | { readonly name: string; readonly file: string }
  | { readonly name: string; readonly text: string };

const LIMIT = 0xffffffff;

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crcUpdate(crc: number, bytes: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (const byte of bytes) c = (TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function crcOfFile(file: string): Promise<number> {
  let crc = 0;
  for await (const chunk of createReadStream(file)) crc = crcUpdate(crc, chunk as Buffer);
  return crc;
}

/** DOS date and time for a zip header. */
function dosTime(at: Date): { time: number; date: number } {
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((Math.max(1980, at.getFullYear()) - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

/** Write `entries` as a zip at `target`; an interrupted write never sits under `target`. */
export async function writeZip(target: string, entries: readonly ZipEntry[]): Promise<void> {
  if (entries.length > 0xffff) throw new Error('Too many files for one zip.');
  const temporary = `${target}.writing`;
  await writeAtomically(temporary, '');
  const out = createWriteStream(temporary);
  const write = async (bytes: Uint8Array): Promise<void> => {
    if (!out.write(bytes)) await once(out, 'drain');
  };
  const { time, date } = dosTime(new Date());
  const central: Buffer[] = [];
  let offset = 0;
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8');
      const text = 'text' in entry ? Buffer.from(entry.text, 'utf8') : null;
      const size = text !== null ? text.length : (await fsp.stat((entry as { file: string }).file)).size;
      const crc = text !== null ? crcUpdate(0, text) : await crcOfFile((entry as { file: string }).file);
      if (size > LIMIT || offset > LIMIT) throw new Error('The album is too large for one zip (over 4 GB).');

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(size, 18);
      local.writeUInt32LE(size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      await write(local);
      await write(name);
      if (text !== null) await write(text);
      else for await (const chunk of createReadStream((entry as { file: string }).file)) await write(chunk as Buffer);

      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(20, 4);
      record.writeUInt16LE(20, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt16LE(0, 10);
      record.writeUInt16LE(time, 12);
      record.writeUInt16LE(date, 14);
      record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(size, 20);
      record.writeUInt32LE(size, 24);
      record.writeUInt16LE(name.length, 28);
      record.writeUInt32LE(offset, 42);
      central.push(record, name);
      offset += 30 + name.length + size;
    }
    const directory = Buffer.concat(central);
    if (offset > LIMIT) throw new Error('The album is too large for one zip (over 4 GB).');
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    await write(directory);
    await write(end);
    out.end();
    await once(out, 'finish');
  } catch (error) {
    out.destroy();
    await fsp.rm(temporary, { force: true });
    throw error;
  }
  await fsp.rm(target, { force: true });
  await fsp.rename(temporary, target);
}
