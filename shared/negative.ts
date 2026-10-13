/**
 * negative — what an instrumental is pushed AWAY from (Owen, 2026-10-12: "lets just try to get it to
 * hum").
 *
 * YuE2 composes with guidance when cfg is above 1: a second branch runs on a "negative" prompt, and
 * the output leans away from it. Crucible's stock negative is the instruction and the score with no
 * tags and no words, so cfg alone never touched the invented singer (2026-10-11: cfg 1.5 and 3.0 did
 * nothing). Since Crucible's `negative_tags` and `negative_lyrics` (2026-10-12), the negative branch
 * can name the voice itself: the same score, with tags that ASK for singers and words to sing. On
 * one seed each, Tool went from humming to less humming and Breaking Benjamin from forbidden words
 * to humming (instrumental-prompt-experiment, 2026-10-12). A nudge toward humming, not a switch.
 *
 * B-Sides writes the text (prompting is its side; Crucible exposes the knob). The voice meter and
 * re-rolls of 1.0.38-1.0.42 are gone: a hum counted as voice, and re-rolls often came out worse.
 */

/** The guidance an instrumental is sent with when it names a negative (songJob); the person's own cfg wins. */
export const NEGATIVE_CFG = 2;

/** Put first in the negative tags: every kind of voice, so guidance pushes away from all of them. */
export const NEGATIVE_VOICES = 'lead vocals, female vocals, male vocals, singing, choir, spoken word';

const INSTRUMENTAL_PHRASE = /^(instrumental|no (vocals?|singing|choir|spoken words?|voice))$/i;

/** The negative tags: the voices, then the song's own tags without its "no vocals" phrases. */
export function negativeTags(tags: string): string {
  const rest = tags.split(',').map((t) => t.trim().replace(/\.$/, '')).filter((t) => t !== '' && !INSTRUMENTAL_PHRASE.test(t));
  return rest.length > 0 ? `${NEGATIVE_VOICES}, ${rest.join(', ')}` : NEGATIVE_VOICES;
}

/** The negative lyrics: a verse of the first four real lines of the planning lyrics (section tags are not lines). */
export function negativeLyrics(planning: string): string {
  const lines = planning.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !/^\[[^\]]*\]$/.test(l));
  return `[Verse]\n${lines.slice(0, 4).join('\n')}\n`;
}

/** What an instrumental sends beside its own tags and planning lyrics. */
export interface Negative {
  readonly tags: string;
  readonly lyrics: string;
}

export function negativeFor(tags: string, planning: string): Negative {
  return { tags: negativeTags(tags), lyrics: negativeLyrics(planning) };
}
