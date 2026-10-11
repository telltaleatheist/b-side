/**
 * tags — the style-tag chip arithmetic, pure so both the form and the tests use it.
 *
 * The VOCABULARY and the CONFLICT MAP are the server's (`GET /v1/playground`,
 * crucible/audio/tags/song.toml); this file only applies them, exactly as the
 * Crucible playground does: tags compare case-insensitively, a phrase never
 * holds a comma, and a picked tag "conflicts" when another picked tag is on its
 * list.
 */
import type { TagConflict } from './types';

export type ConflictMap = Readonly<Record<string, readonly TagConflict[]>>;

/** The phrases in a comma-separated line, trimmed, blanks dropped. */
export function splitTags(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** Index of `tag` in `tags`, ignoring case; -1 when absent. */
export function indexOfTag(tags: readonly string[], tag: string): number {
  const wanted = tag.toLowerCase();
  return tags.findIndex((other) => other.toLowerCase() === wanted);
}

/** `tags` plus every phrase of `text` not already there (case-insensitive), in order. */
export function addTags(tags: readonly string[], text: string): string[] {
  const next = [...tags];
  for (const tag of splitTags(text)) {
    if (indexOfTag(next, tag) < 0) next.push(tag);
  }
  return next;
}

/** `tag` added when absent, removed when present: a suggestion click. */
export function toggleTag(tags: readonly string[], tag: string): string[] {
  const at = indexOfTag(tags, tag);
  if (at < 0) return addTags(tags, tag);
  return tags.filter((_, index) => index !== at);
}

/**
 * A tag that asks for a voice: a singer, a choir, rapping, a duet, sung harmonies ("three-part
 * harmonies", the song page's own Vocal tag). An instrumental never carries one. Harmonies count
 * only as "<n>-part harmonies": "guitar harmonies" is an instrument's.
 */
export const VOICE_TAG = /\b(vocals?|voices?|vocalists?|vocali[sz](?:e|es|ing)|singing|sung|singers?|choir|choral|chant(?:s|ing)?|humm(?:ing|ed)|whisper(?:s|ed|ing)?|spoken|scat|beatbox(?:ing)?|yodel(?:s|ing)?|rap|rapping|a cappella|crooner|duets?|[a-z]+-part harmon(?:y|ies))\b/i;

/**
 * The tags without any that asks for a voice (Owen, 2026-10-08: instrumental
 * means no voice). "Instrumental" and "no vocals" themselves are kept.
 */
export function withoutVoice(tags: readonly string[]): string[] {
  return tags.filter((tag) => /^(instrumental|no vocals|no singing)$/i.test(tag.trim()) || !VOICE_TAG.test(tag));
}

/** The phrases that end every instrumental style line (YuE2's own instrumental examples). */
export const NO_VOICE_CLAUSE: readonly string[] = ['no vocals', 'no singing', 'no choir', 'no spoken words'];

/** A language named on its own ("Spanish", "Japanese lyrics"): recognised so English is never added beside it. */
const LANGUAGE = /^(english|chinese|mandarin|cantonese|japanese|korean|spanish|french|german|italian|portuguese|brazilian portuguese|russian|ukrainian|polish|czech|slovak|slovenian|croatian|serbian|bosnian|bulgarian|romanian|hungarian|greek|turkish|dutch|flemish|swedish|norwegian|danish|finnish|icelandic|estonian|latvian|lithuanian|irish|gaelic|scottish gaelic|welsh|breton|basque|catalan|galician|maltese|albanian|macedonian|armenian|georgian|azerbaijani|kazakh|uzbek|mongolian|arabic|hebrew|yiddish|persian|farsi|kurdish|pashto|urdu|hindi|punjabi|bengali|gujarati|marathi|tamil|telugu|kannada|malayalam|sinhala|nepali|thai|lao|khmer|burmese|vietnamese|indonesian|malay|filipino|tagalog|cebuano|javanese|hawaiian|maori|samoan|tongan|swahili|amharic|somali|yoruba|igbo|hausa|zulu|xhosa|afrikaans|shona|wolof|lingala|haitian creole|creole|patois|latin|esperanto|sanskrit)( language| lyrics| vocals?| singing)?$/i;
/**
 * Words that describe a singer more than an instrument, kept out of an instrumental's style
 * (crucible-pc-1, from YuE2's instrumental guidance, 2026-10-11): with the melody moved off the
 * voice, nothing should invite YuE2 to sing it.
 */
// "epic" in metal tends to mean a choir (crucible-pc-1, 2026-10-11).
const SINGER_LIKE = /\b(soaring|anthemic|operatic|epic)\b/i;

const NO_VOICE = /^(instrumental|no vocals?|no singing|no choir|no spoken words?|without vocals|vocal-free)$/i;
const TEMPO = /\b\d{2,3}\s*BPM\b/i;
/**
 * A voice by its singer alone ("male", "female"): a voice phrase too, beside VOICE_TAG's. Not a
 * possessive: "children's pop" is a genre, and a sung song's other voices are dropped beside its lead.
 */
const SINGER = /^(male|female|man|woman|boy|girl|child|children)\b(?!['’])/i;

/**
 * The languages YuE2 sings (its model card, m-a-p/YuE2-3B: zh and en), the only two B-Sides offers
 * (Owen, 2026-10-11). Another one the person typed is sent as typed, and the Studio says so.
 */
const DECLARED_LANGUAGE = /^(english|chinese|mandarin|cantonese)\b/i;

/** A sung line's language when it is one YuE2 does not declare (the Studio says so); null otherwise. */
export function undeclaredLanguage(line: string): string | null {
  const language = splitTags(line).find((tag) => LANGUAGE.test(tag));
  return language !== undefined && !DECLARED_LANGUAGE.test(language) ? language : null;
}

function isVoice(tag: string): boolean {
  return VOICE_TAG.test(tag) || SINGER.test(tag);
}

/** An instrumental's lead as YuE2's instrumental examples word it ("lyrical violin melody"). */
const MELODY = /\b(melody|lead)\b/i;
/** An instrument that can carry a melody; drums, bass, riffs and the like cannot. */
const MELODIC = /\b(guitars?|piano|keys|rhodes|synths?|strings|violins?|viola|cello|fiddle|banjo|mandolin|harp|sax(ophone)?|trumpet|trombone|horns?|flute|clarinet|oboe|organ|accordion|harmonica|ukulele|sitar|koto|marimba|vibraphone|xylophone|glockenspiel|kalimba|bells|erhu|guzheng|pipa|bagpipes?)\b/i;
const NOT_MELODIC = /\b(drums?|bass|riffs?|harmonics|808|percussion|pads?)\b/i;

/**
 * An instrumental's melody when its tags name none: its first melodic instrument as "<x> melody",
 * else one fitting the genre. Owen, 2026-10-11: a preset's instrumental ("soul ... piano, strings")
 * never named what carries its melody, and YuE2 sang it; only Describe had added one.
 */
function fallbackMelody(tags: readonly string[]): string {
  const instrument = tags.find((tag) => MELODIC.test(tag) && !NOT_MELODIC.test(tag));
  if (instrument !== undefined) return `${instrument} melody`;
  return tags.some((tag) => /\b(rock|metal|punk|grunge)\b/i.test(tag)) ? 'lead guitar melody' : 'piano melody';
}

/**
 * The lead: who or what carries the melody, exactly one a song (Owen, 2026-10-11: "lead instrument
 * should be its own tag ... in songs with lyrics, thatll be 'gritty male voice' or 'female vocal'").
 * Sung, the singer phrase; instrumental, one instrument as "<instrument> melody" ("piano" is sent as
 * "piano melody"; one already saying melody or lead is kept as it is). An instrumental never has a
 * voice for a lead. Blank: null, and the tags' own lead stands (leadOf).
 */
export function leadPhrase(lead: string, instrumental: boolean): string | null {
  const said = lead.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  if (said === '') return null;
  if (!instrumental) return said;
  if (isVoice(said)) return null;
  return MELODY.test(said) ? said : `${said} melody`;
}

/** Whether `tag` could be a song's lead: a voice when sung, a melody or lead instrument when instrumental. */
export function isLead(tag: string, instrumental: boolean): boolean {
  if (LANGUAGE.test(tag.trim())) return false;
  return instrumental ? MELODY.test(tag) && !isVoice(tag) : isVoice(tag);
}

/**
 * Whether a lead still fits after Vocals changed: an instrumental's is no voice, a sung song's is
 * one. Make clears one that does not (Owen, 2026-10-11).
 */
export function leadFits(lead: string, instrumental: boolean): boolean {
  return instrumental ? !isVoice(lead) : isVoice(lead);
}

/** The tags' own lead, with none given: the first phrase that could be one (isLead); null when none. */
export function leadOf(tags: readonly string[], instrumental: boolean): string | null {
  return tags.find((tag) => isLead(tag, instrumental)) ?? null;
}

/**
 * A style line in YuE2's official form (the yue2-music skill, YuE rev 18a07bb6, read 2026-10-10;
 * Owen via crucible-pc-1), applied to whatever wrote the tags, the person included:
 *   sung          the language first (every official example), "English" when the tags name none
 *                 (Owen, 2026-10-11: English or Chinese, the two YuE2 sings; another the person typed
 *                 is kept, and the Studio says YuE2 does not support it), then the lead (the one
 *                 singer), then the rest as written with no other voice; exactly one "N BPM"
 *                 ("describe them consistently in the style").
 *   instrumental  "Instrumental" first, then the lead ("<instrument> melody"); no language and no
 *                 voice; exactly one "N BPM"; ending "no vocals, no singing, no choir, no spoken words".
 * The lead (Owen, 2026-10-11: one lead a song, the person's or the writer's) is `lead` when given
 * (leadPhrase), else the tags' own first voice (sung) or melody (instrumental): an instrumental whose
 * style never named what carries its melody let YuE2 sing it. Each phrase once (ignoring case), in
 * the order given otherwise; the first tempo is the one kept (the album's own before a track's).
 * Nothing else is dropped: what the person typed stays.
 */
export function styleLine(tags: string, instrumental: boolean, lead?: string | null): string {
  const given = lead == null ? null : leadPhrase(lead, instrumental);
  const seen = new Set<string>();
  // "distorted guitar" and "distorted guitars" are one phrase (crucible-pc-1, 2026-10-11).
  const keyOf = (tag: string): string => tag.toLowerCase().replace(/s$/, '');
  // A line already ended with YuE2's full stop (an album's own, sent again) reads as its phrases.
  const phrases = splitTags(tags.trim().replace(/[.,\s]+$/, '')).filter((tag) => {
    const key = keyOf(tag);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  let tempo = false;
  const rest = phrases.filter((tag) => {
    if (NO_VOICE.test(tag)) return false;
    if (TEMPO.test(tag)) {
      if (tempo) return false;
      tempo = true;
    }
    return true;
  });
  if (instrumental) {
    const kept = rest.filter((tag) => !LANGUAGE.test(tag) && !isVoice(tag) && !SINGER_LIKE.test(tag));
    const chosen = given ?? leadOf(kept, true) ?? fallbackMelody(kept);
    // "piano" beside the lead "piano melody" is the same instrument said twice.
    const bare = chosen === null ? '' : keyOf(chosen.replace(/\s+melody$/i, ''));
    const others = chosen === null ? kept : kept.filter((tag) => keyOf(tag) !== keyOf(chosen) && keyOf(tag) !== bare);
    // YuE2's instrumental form, which B-Sides writes itself (Owen, 2026-10-11: "b-sides should handle
    // this"; Crucible passes tags through): it ends with a full stop (skills/yue2-music/instrumental/
    // scripts/instrumental.py, YuE 18a07bb6). Never empty: there is always a melody (fallbackMelody).
    return `${joinTags(['Instrumental', ...(chosen === null ? [] : [chosen]), ...others, ...NO_VOICE_CLAUSE])}.`;
  }
  const language = rest.find((tag) => LANGUAGE.test(tag)) ?? 'English';
  const words = rest.filter((tag) => !LANGUAGE.test(tag));
  const chosen = given ?? leadOf(words, false);
  // One lead: any other voice would ask YuE2 for a second singer.
  const others = chosen === null ? words : words.filter((tag) => !isVoice(tag) && keyOf(tag) !== keyOf(chosen));
  return joinTags([language, ...(chosen === null ? [] : [chosen]), ...others]);
}

/** The value the request sends: one comma-separated line. */
export function joinTags(tags: readonly string[]): string {
  return tags.join(', ');
}

/** The picked tags `tag` contradicts, each with why. Empty when it clashes with none. */
export function clashesWith(tag: string, picked: readonly string[], conflicts: ConflictMap): TagConflict[] {
  const rules = conflicts[tag.toLowerCase()] ?? [];
  return rules.filter((rule) => picked.some((other) => other.toLowerCase() === rule.tag.toLowerCase()));
}

/** The tooltip for a clash: "Conflicts with fast (one pace), 140 BPM (one tempo)". */
export function clashText(clashes: readonly TagConflict[]): string {
  return clashes.length === 0 ? '' : `Conflicts with ${clashes.map((c) => `${c.tag} (${c.why})`).join(', ')}`;
}
