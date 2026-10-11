import { expect, test } from 'bun:test';

import { leadOf, leadPhrase, styleLine, undeclaredLanguage } from '../shared/tags';

// The lead (the one singer, or the instrument carrying an instrumental's melody) goes first after the
// language or "Instrumental" (Owen, 2026-10-11): lines that held it elsewhere now have it moved there.

test("YuE2's official examples keep their phrases, the lead (singer) first after the language; an instrumental gets the full no-voice ending", () => {
  const sung = 'English, warm piano pop, expressive female voice, acoustic piano, rounded bass and light drums, lyrical memorable melody, unhurried phrasing, 88 BPM';
  expect(styleLine(sung, false)).toBe('English, expressive female voice, warm piano pop, acoustic piano, rounded bass and light drums, lyrical memorable melody, unhurried phrasing, 88 BPM');
  const jazz = 'English, intimate female jazz vocal, relaxed 88 BPM, piano, tenor saxophone, upright bass, brushed drums, no guitar, spacious modern harmony, natural English phrasing';
  expect(styleLine(jazz, false)).toBe(jazz);
  expect(styleLine('Instrumental, warm solo piano, lyrical and gentle, no vocals', true))
    .toBe('Instrumental, warm solo piano melody, lyrical and gentle, no vocals, no singing, no choir, no spoken words');
});

test('an instrumental drops its language and every voice, starts with Instrumental and its lead, keeps one tempo, and ends with the no-voice clause', () => {
  // Victoria's job 91e56049cc: "English" first, two tempos, "instrumental" last.
  const merged = 'English, hip hop, boom bap, playful, gritty male vocal, drums, bass, sampled strings, 95 BPM, female, 90 BPM, chiptune lead, instrumental';
  expect(styleLine(merged, true)).toBe('Instrumental, chiptune lead, hip hop, boom bap, playful, drums, bass, sampled strings, 95 BPM, no vocals, no singing, no choir, no spoken words');
});

test('a sung line puts the language first, then its singer, keeps one tempo, and loses any instrumental phrase', () => {
  expect(styleLine('contemporary pop, 96 BPM, warm female vocal, English, piano, 100 BPM, no vocals, piano', false))
    .toBe('English, warm female vocal, contemporary pop, 96 BPM, piano');
});

test('a sung line that names no language gets English first; one that names another keeps it', () => {
  expect(styleLine('boom bap, playful, male rapper, 92 BPM', false)).toBe('English, male rapper, boom bap, playful, 92 BPM');
  expect(styleLine('city pop, Japanese, female vocal, 110 BPM', false)).toBe('Japanese, female vocal, city pop, 110 BPM');
  expect(styleLine('Chinese, ballad, 70 BPM', false)).toBe('Chinese, ballad, 70 BPM');
  expect(styleLine('boom bap, Spanish, 92 BPM', true)).toBe('Instrumental, piano melody, boom bap, 92 BPM, no vocals, no singing, no choir, no spoken words');
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

test('an instrumental keeps out singer-like words and plural repeats (crucible-pc-1, 2026-10-11)', () => {
  expect(styleLine('heavy metal, epic, soaring, distorted guitar, distorted guitars, anthemic chorus, 140 BPM', true))
    .toBe('Instrumental, distorted guitar melody, heavy metal, epic, 140 BPM, no vocals, no singing, no choir, no spoken words');
});

test('a sung song has exactly one lead: the one given, first after the language; every other voice goes (Owen, 2026-10-11)', () => {
  expect(styleLine('English, pop, soft female vocal, duet, piano, 96 BPM', false, 'gritty male voice'))
    .toBe('English, gritty male voice, pop, piano, 96 BPM');
  // The given lead already among the tags, a plural of it too: said once.
  expect(styleLine('Chinese, ballad, female vocals, 70 BPM', false, 'female vocal')).toBe('Chinese, female vocal, ballad, 70 BPM');
  // None given: the first voice is the lead, the second goes.
  expect(styleLine('rock, raspy male vocal, female vocal, 120 BPM', false)).toBe('English, raspy male vocal, rock, 120 BPM');
  // "children's pop" is a genre, not a second singer.
  expect(styleLine("children's pop, playful female vocal, piano", false)).toBe("English, playful female vocal, children's pop, piano");
  // Blank: the tags' own lead.
  expect(styleLine('pop, soft female voice', false, '  ')).toBe('English, soft female voice, pop');
});

test('an instrumental has exactly one lead, an instrument as "<instrument> melody", and never a voice (Owen, 2026-10-11)', () => {
  // Owen's re-render: "searing lead guitar melody" named, no voice.
  expect(styleLine('heavy metal, dark, distorted guitar, double-kick drums, 140 BPM', true, 'searing lead guitar melody'))
    .toBe('Instrumental, searing lead guitar melody, heavy metal, dark, distorted guitar, double-kick drums, 140 BPM, no vocals, no singing, no choir, no spoken words');
  // "piano" typed: sent as "piano melody", and the bare "piano" is not said twice.
  expect(styleLine('lo-fi, calm, piano, vinyl crackle, 72 BPM', true, 'piano'))
    .toBe('Instrumental, piano melody, lo-fi, calm, vinyl crackle, 72 BPM, no vocals, no singing, no choir, no spoken words');
  // A voice is never an instrumental's lead: the tags' own melody stands.
  expect(styleLine('ambient, lyrical violin melody, 70 BPM', true, 'soft female voice'))
    .toBe('Instrumental, lyrical violin melody, ambient, 70 BPM, no vocals, no singing, no choir, no spoken words');
});

test('the lead as sent: "<instrument> melody" for an instrumental unless it says melody or lead; the first lead among tags', () => {
  expect(leadPhrase('piano', true)).toBe('piano melody');
  expect(leadPhrase('lead guitar', true)).toBe('lead guitar');
  expect(leadPhrase('lyrical violin melody', true)).toBe('lyrical violin melody');
  expect(leadPhrase('female vocal', true)).toBeNull();
  expect(leadPhrase('gritty male voice', false)).toBe('gritty male voice');
  expect(leadPhrase('', false)).toBeNull();
  expect(leadOf(['English', 'pop', 'warm male vocal', 'piano'], false)).toBe('warm male vocal');
  expect(leadOf(['ambient', 'warm piano melody'], true)).toBe('warm piano melody');
  expect(leadOf(['ambient', 'piano'], true)).toBeNull();
});

test('an instrumental that names no melody gets one, so YuE2 is never left to sing it (Owen, 2026-10-11)', () => {
  expect(styleLine('soul, soulful slow ballad, emotional, piano, strings, 70 BPM', true))
    .toBe('Instrumental, piano melody, soul, soulful slow ballad, emotional, strings, 70 BPM, no vocals, no singing, no choir, no spoken words');
  expect(styleLine('heavy metal, bass guitar, double-kick drums', true))
    .toBe('Instrumental, lead guitar melody, heavy metal, bass guitar, double-kick drums, no vocals, no singing, no choir, no spoken words');
  expect(styleLine('soul, emotional', true)).toBe('Instrumental, piano melody, soul, emotional, no vocals, no singing, no choir, no spoken words');
});
