/**
 * header — the key, meter and tempo a song's tags state, as Crucible 2.0.13's `key`, `meter` and
 * `bpm` (Victoria, 2026-10-13: her waltz album's minor tags came out major about half the time).
 * Crucible forces exactly the score's K:, M: and Q: lines from them while YuE2 writes the rest;
 * it reads no style text, so B-Sides parses its own tags here.
 *
 * Only what the tags say outright is sent: "A minor", "F# minor", "Bb major", "key of E minor";
 * "3/4", "6/8" or "waltz" (a waltz is in three); "90 BPM". A bare "E" or "mode" words are not a key.
 */

/**
 * The first Crucible whose header forcing works: 2.0.13 lists the fields but its check refused every
 * real install (crucible-pc-1, 2026-10-13); 2.0.14 passed a forced Em 3/4 76 on sung and instrumental.
 */
export const HEADER_FROM: readonly [number, number, number] = [2, 0, 14];

/** The 30 keys YuE2's scores use: 15 major and 15 minor, as ABC spells them. */
export const KEYS: readonly string[] = [
  'Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#',
  'Abm', 'Ebm', 'Bbm', 'Fm', 'Cm', 'Gm', 'Dm', 'Am', 'Em', 'Bm', 'F#m', 'C#m', 'G#m', 'D#m', 'A#m',
];

export interface SongHeader {
  readonly key?: string;
  readonly meter?: string;
  readonly bpm?: number;
}

const KEY = /\b(?:key of\s+)?([A-G])\s*(#|♯|b|♭|sharp|flat)?\s*(minor|major|min|maj)\b/i;
const METER = /\b([1-9]|1[0-6])\s*\/\s*(2|4|8|16)\b/;
const BPM = /\b(\d{2,3})\s*bpm\b/i;

function spell(letter: string, accidental: string | undefined, minor: boolean): string | null {
  const sharp = accidental !== undefined && /^(#|♯|sharp)$/i.test(accidental);
  const flat = accidental !== undefined && /^(b|♭|flat)$/i.test(accidental);
  const key = `${letter.toUpperCase()}${sharp ? '#' : flat ? 'b' : ''}${minor ? 'm' : ''}`;
  return KEYS.includes(key) ? key : null;
}

/** The header the tags state; each part only when the tags say it in so many words and YuE2 can take it. */
export function headerOf(tags: string): SongHeader {
  const header: { key?: string; meter?: string; bpm?: number } = {};
  const key = KEY.exec(tags);
  if (key !== null) {
    const spelled = spell(key[1] as string, key[2], /^min/i.test(key[3] as string));
    if (spelled !== null) header.key = spelled;
  }
  const meter = METER.exec(tags);
  if (meter !== null) header.meter = `${meter[1]}/${meter[2]}`;
  else if (/\bwaltz\b/i.test(tags)) header.meter = '3/4';
  const bpm = BPM.exec(tags);
  if (bpm !== null) {
    const n = Number(bpm[1]);
    if (n >= 40 && n <= 240) header.bpm = n;
  }
  return header;
}
