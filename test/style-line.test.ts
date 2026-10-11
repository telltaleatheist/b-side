import { expect, test } from 'bun:test';

import { styleLine } from '../shared/tags';

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
