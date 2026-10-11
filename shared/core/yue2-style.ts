/**
 * yue2-style — YuE2's own guidance for its style text, verbatim, for a writer that reads it
 * (Claude). Owen, 2026-10-10: "we can probably provide the style skill directly to the ai that's
 * called". Only the part of the yue2-music skill about the style text: the rest of the skill is
 * about running YuE2 (setup, covers, score editing), which a tag writer does not need.
 * B-Sides' own model learns this in training instead (Training pc 1, v3): it holds no long prompt.
 *
 * Source: github.com/multimodal-art-projection/YuE, skills/yue2-music at rev 18a07bb6
 * (SKILL.md, references/generation-and-covers.md, assets/prompt.json, instrumental/SKILL.md,
 * instrumental/assets/example-style.txt). Copyright (c) 2026 the YuE2 authors, Apache License 2.0.
 */
export const YUE2_STYLE_GUIDE = [
  "YuE2's own guidance for the style text (the yue2-music skill, by the YuE2 authors, Apache-2.0):",
  '- "Put genre, instruments, vocal character, language and intended tempo in `style`; put section tags and actual words in `lyrics`."',
  '- "`tags` is an alias for `style`." "There is no request field for ... `bpm`, `negative_prompt` ..." "Put tempo and meter in the ABC and describe them consistently in the style."',
  '- "Do not paste your own replacement instruction into the style prompt."',
  '- "Use supported chord cores and describe voicing choices in the style prompt": harmony is described in the style.',
  '- For an instrumental: "A simple style description is enough."',
  'Its examples, verbatim:',
  '- "English, warm piano pop, expressive female voice, acoustic piano, rounded bass and light drums, lyrical memorable melody, unhurried phrasing, 88 BPM"',
  '- "English, warm female vocal, contemporary pop, 96 BPM, piano, rounded electric bass, restrained drums, clear diction"',
  '- "English, intimate female jazz vocal, relaxed 88 BPM, piano, tenor saxophone, upright bass, brushed drums, no guitar, spacious modern harmony, natural English phrasing"',
  '- "Instrumental, expressive chamber string ensemble, lyrical violin melody, warm viola and cello accompaniment, G major, 96 BPM, a repeated opening phrase followed by a short gentle ending, natural concert hall acoustics, no vocals, no singing, no choir, no spoken words."',
  '- "Instrumental, warm solo piano, lyrical and gentle, no vocals"',
  'Write tags in that spirit: short descriptive phrases, none contradicting another, one tempo, and no more of them than the examples use (they run 4 to 11 phrases in all): leave a list short or empty rather than fill it. B-Sides lays out the final line itself: the language first; for an instrumental, "Instrumental" first and the no-vocals phrases last.',
].join('\n');

/**
 * YuE2's own guidance for the lyrics, verbatim, for Claude's lyrics call (Owen, 2026-10-11: each call
 * gets the part of the skill that is about what it writes; the name and cover calls get none). Same
 * source: SKILL.md, assets/prompt.json, references/editing-workflows.md "Adapt lyrics for singing".
 */
export const YUE2_LYRICS_GUIDE = [
  "YuE2's own guidance for the lyrics (the yue2-music skill, by the YuE2 authors, Apache-2.0):",
  '- "Put section tags and actual words in `lyrics`. Keep implementation notes out of lyrics." No notes, directions or explanations: every line is sung.',
  '- "Check syllable count, lexical stress, consonant density on short notes, comfortable vowels on held notes and breathing spaces ... matching the total number of syllables alone is insufficient."',
  'Its example lyrics, verbatim (short lines of about 7 syllables, rhymed in couplets):',
  '[Verse]',
  'Neon fades along the lane',
  'Footsteps keep the time of rain',
  'Fold the night and leave it here',
  'Morning has a sky to clear',
  '',
  '[Chorus]',
  'Let the day come into view',
  'Every road begins with you',
  'Hold a little room for light',
  'We will sing beyond the night',
].join('\n');

/** The text calls that write a style (tags, an album's core, its tracks' turns): the guide goes with them. */
export const STYLE_TASKS: readonly string[] = ['[describe]', '[album]', '[tracks]'];
