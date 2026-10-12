import { expect, test } from 'bun:test';

import { ownIdea, ownTracks, withSections } from '../shared/own-words';

test('own words split into tracks on ---, a "# Name" line names one, the words kept exactly', () => {
  const text = '# The Swing\r\nHow do you like to go up in a swing,\r\n  Up in the air so blue?\r\n\r\n---\r\n\r\njust a paragraph,   with odd spacing\r\n---\r\n\r\n';
  expect(ownTracks(text)).toEqual([
    { title: 'The Swing', lyrics: 'How do you like to go up in a swing,\n  Up in the air so blue?' },
    { title: null, lyrics: 'just a paragraph,   with odd spacing' },
  ]);
  expect(ownTracks('   \n---\n')).toEqual([]);
});

test('section tags only when asked: stanzas are verses, a returning stanza the chorus, no word changed', () => {
  const poem = 'One line\nTwo line\n\nRefrain here\nagain\n\nThree line\n\nRefrain here\nagain';
  expect(withSections(poem)).toBe('[Verse]\nOne line\nTwo line\n\n[Chorus]\nRefrain here\nagain\n\n[Verse]\nThree line\n\n[Chorus]\nRefrain here\nagain');
  expect(withSections('[verse]\nalready tagged')).toBe('[verse]\nalready tagged');
  expect(withSections('a plain paragraph')).toBe('[Verse]\na plain paragraph');
  expect(ownIdea('[Verse]\nA\nB')).toBe('A / B');
});
