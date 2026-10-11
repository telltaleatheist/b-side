import { expect, test } from 'bun:test';

import { freshLine, wornWords } from '../shared/core/fresh-names';

test('the words recent names lean on, plurals as one', () => {
  expect(wornWords(['Iron Cathedral Burning', 'Crowns of Ash', 'The Ashen Crown', 'Cathedral of Iron', 'Velvet Morning']))
    .toEqual(['iron', 'cathedral', 'crown']);
});

test('the line names the worn words and two different sparks', () => {
  let n = 0;
  const line = freshLine(['Velvet Rain', 'Velvet Hours'], () => (n++ === 0 ? 0 : 0.5));
  expect(line).toContain('velvet');
  expect(line).toContain('crown');
  const spark = line.split('loosely: ')[1] ?? '';
  const [a, b] = spark.replace(/\.$/, '').split(', ');
  expect(a).not.toBe(b);
});
