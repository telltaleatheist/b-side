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
export const VOICE_TAG = /\b(vocals?|voices?|vocalists?|singing|sung|singers?|choir|choral|rap|rapping|a cappella|crooner|duets?|[a-z]+-part harmon(?:y|ies))\b/i;

/**
 * The tags without any that asks for a voice (Owen, 2026-10-08: instrumental
 * means no voice). "Instrumental" and "no vocals" themselves are kept.
 */
export function withoutVoice(tags: readonly string[]): string[] {
  return tags.filter((tag) => /^(instrumental|no vocals|no singing)$/i.test(tag.trim()) || !VOICE_TAG.test(tag));
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
