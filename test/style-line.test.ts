import { expect, test } from 'bun:test';

import { styleLine, undeclaredLanguage } from '../shared/tags';

test("YuE2's official examples come through unchanged (sung) or with the full no-voice ending (instrumental)", () => {
  const sung = 'English, warm piano pop, expressive female voice, acoustic piano, rounded bass and light drums, lyrical memorable melody, unhurried phrasing, 88 BPM';
  expect(styleLine(sung, false)).toBe(sung);
  const jazz = 'English, intimate female jazz vocal, relaxed 88 BPM, piano, tenor saxophone, upright bass, brushed drums, no guitar, spacious modern harmony, natural English phrasing';
  expect(styleLine(jazz, false)).toBe(jazz);
  expect(styleLine('Instrumental, warm solo piano, lyrical and gentle, no vocals', true))
    .toBe('Instrumental, warm solo piano, lyrical and gentle, no vocals, no singing, no choir, no spoken words');
});

test('an instrumental drops its language and every voice, starts with Instrumental, keeps one tempo, and ends with the no-voice clause', () => {
  // Victoria's job 91e56049cc: "English" first, two tempos, "instrumental" last.
  const merged = 'English, hip hop, boom bap, playful, gritty male vocal, drums, bass, sampled strings, 95 BPM, female, 90 BPM, chiptune lead, instrumental';
  expect(styleLine(merged, true)).toBe('Instrumental, hip hop, boom bap, playful, drums, bass, sampled strings, 95 BPM, chiptune lead, no vocals, no singing, no choir, no spoken words');
});

test('a sung line puts the language first, keeps one tempo, and loses any instrumental phrase', () => {
  expect(styleLine('contemporary pop, 96 BPM, warm female vocal, English, piano, 100 BPM, no vocals, piano', false))
    .toBe('English, contemporary pop, 96 BPM, warm female vocal, piano');
});

test('a sung line that names no language gets English first; one that names another keeps it', () => {
  expect(styleLine('boom bap, playful, male rapper, 92 BPM', false)).toBe('English, boom bap, playful, male rapper, 92 BPM');
  expect(styleLine('city pop, Japanese, female vocal, 110 BPM', false)).toBe('Japanese, city pop, female vocal, 110 BPM');
  expect(styleLine('Chinese, ballad, 70 BPM', false)).toBe('Chinese, ballad, 70 BPM');
  expect(styleLine('boom bap, Spanish, 92 BPM', true)).toBe('Instrumental, boom bap, 92 BPM, no vocals, no singing, no choir, no spoken words');
});

test('any language keeps its place first; English goes in only when none is named', () => {
  expect(styleLine('afrobeat, Swahili, joyful, 104 BPM', false)).toBe('Swahili, afrobeat, joyful, 104 BPM');
  expect(styleLine('tango, Spanish lyrics, 120 BPM', false)).toBe('Spanish lyrics, tango, 120 BPM');
  expect(styleLine('bossa nova, Brazilian Portuguese, 90 BPM', false)).toBe('Brazilian Portuguese, bossa nova, 90 BPM');
});

test("a language YuE2 does not declare is named for the Studio's note; English and Chinese are not", () => {
  expect(undeclaredLanguage('Spanish, tango, 120 BPM')).toBe('Spanish');
  expect(undeclaredLanguage('Japanese lyrics, city pop')).toBe('Japanese lyrics');
  expect(undeclaredLanguage('English, pop')).toBeNull();
  expect(undeclaredLanguage('Mandarin, ballad')).toBeNull();
  expect(undeclaredLanguage('pop, 90 BPM')).toBeNull();
});
