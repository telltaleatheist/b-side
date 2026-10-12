/**
 * An album sung in the person's own words (Victoria's "Poems Set to Music", Owen 2026-10-11: "if the
 * user wants to paste lyrics in directly, even with no structure, they should be able to. we should
 * provide the structure if they want it, but it shouldnt be required"). YuE2 sings plain text too
 * (Owen pasted a paragraph on bananas and it sang it), so the words go as they are: no lyricist, no
 * fix-up, nothing cut. Section tags are added only when asked, and never change a word.
 */

/** One track: its words as given, and its name when the person gave one ("# Name" on its first line). */
export interface OwnTrack {
  readonly title: string | null;
  readonly lyrics: string;
}

/** The most tracks one album takes in its own words, and the longest words one track takes. */
export const OWN_TRACKS_MAX = 45;
export const OWN_WORDS_MAX = 6000;

const SEPARATOR = /^\s*-{3,}\s*$/;
const HEADING = /^\s*#\s+(.+?)\s*$/;
const SECTION = /\[(verse|pre-chorus|chorus|bridge|interlude|outro|intro|instrumental)[^\]]*\]/i;

/**
 * The tracks in `text`: one per block between lines of `---`. A block whose first line is
 * "# Name" is named that, and the line is not sung. The words are kept exactly; only the blank
 * lines around each block go (and Windows line ends).
 */
export function ownTracks(text: string): OwnTrack[] {
  const tracks: OwnTrack[] = [];
  const blocks: string[][] = [[]];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (SEPARATOR.test(line)) blocks.push([]);
    else (blocks[blocks.length - 1] as string[]).push(line);
  }
  for (const block of blocks) {
    let lines = block;
    const first = lines.findIndex((line) => line.trim() !== '');
    if (first < 0) continue;
    const heading = HEADING.exec(lines[first] as string);
    const title = heading ? (heading[1] as string).slice(0, 80) : null;
    lines = heading ? lines.slice(first + 1) : lines.slice(first);
    const lyrics = lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '');
    if (lyrics.trim() === '') continue;
    tracks.push({ title, lyrics });
  }
  return tracks;
}

/**
 * Section tags for words that have none (the "Add verse and chorus tags" choice): each stanza
 * (lines between blank lines) a [Verse], and a stanza sung more than once the [Chorus]. Words that
 * carry a tag already are left exactly as they are; no word is ever changed.
 */
export function withSections(lyrics: string): string {
  if (SECTION.test(lyrics)) return lyrics;
  const stanzas = lyrics.split(/\n\s*\n/).map((stanza) => stanza.trim()).filter((stanza) => stanza !== '');
  const key = (stanza: string): string => stanza.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const seen = new Map<string, number>();
  for (const stanza of stanzas) seen.set(key(stanza), (seen.get(key(stanza)) ?? 0) + 1);
  return stanzas.map((stanza) => `${(seen.get(key(stanza)) ?? 0) > 1 ? '[Chorus]' : '[Verse]'}\n${stanza}`).join('\n\n');
}

/** What the words are about, for the sound writer: the opening lines, without tags. */
export function ownIdea(lyrics: string): string {
  const lines = lyrics.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !/^\[[^\]]*\]$/.test(line));
  return lines.slice(0, 4).join(' / ').slice(0, 280);
}
