import { expect, test } from 'bun:test';

import {
  MAX_LINES, PLANNING_SETS, PRIOR_SECONDS_PER_LINE, PlanningLyricsError, Sizing, aim, aimWindow, check, holds, namedSet, pickSet, planningLyrics, trackSet,
} from '../shared/planning-sets';
import { LENGTH_AIMS } from '../shared/types';

test('the pool is the ten sets Crucible shipped, in its order, each id once', () => {
  expect(PLANNING_SETS.map((set) => set.id)).toEqual(['lantern', 'harbor', 'meadow', 'stairwell', 'tidewater', 'ember', 'orchard', 'crossing', 'market', 'northlight']);
});

test('every set passes check, as written', () => {
  for (const set of PLANNING_SETS) expect(() => check(set.lyrics)).not.toThrow();
});

test('every set, sized to every length B-Sides offers, passes check', () => {
  for (const set of PLANNING_SETS) {
    for (const length of LENGTH_AIMS) {
      const planned = planningLyrics(set, { min: length.min, max: length.max });
      expect(() => check(planned.lyrics)).not.toThrow();
      expect(planned.id).toBe(set.id);
    }
  }
});

test("check holds a text to YuE2's rules", () => {
  expect(() => check('[Verse]\nla')).not.toThrow();
  expect(() => check('[Hook]\nla')).toThrow(PlanningLyricsError);
  expect(() => check('[Verse]\nla\n\n[verse]\nla')).toThrow(/twice in a row/);
  expect(() => check('[Verse] la')).toThrow(/line of its own/);
  expect(() => check('la\n[Verse]\nla')).toThrow(/before any section tag/);
  expect(() => check('[Intro]\n\n[Outro]')).toThrow(/no lines of words/);
  expect(() => check(`[Verse]\n${Array.from({ length: MAX_LINES + 1 }, () => 'la').join('\n')}`)).toThrow(/at most 36/);
  expect(() => check(`[Verse]\n${'a'.repeat(2001)}`)).toThrow(/characters/);
  expect(check('[Pre-Chorus]\nla\nla\r\n\r\n[Chorus]\nla').map((s) => [s.label, s.lines.length])).toEqual([['pre-chorus', 2], ['chorus', 1]]);
});

test('a short range cuts a set by whole sections, from its end', () => {
  const lantern = namedSet('lantern')!;
  const planned = planningLyrics(lantern, { min: 60, max: 120 });
  expect(planned.sections).toBeLessThan(4);
  const lines = check(planned.lyrics).reduce((sum, s) => sum + s.lines.length, 0);
  const [low, high] = aimWindow({ min: 60, max: 120 });
  expect(lines * PRIOR_SECONDS_PER_LINE).toBeGreaterThanOrEqual(low);
  expect(lines * PRIOR_SECONDS_PER_LINE).toBeLessThanOrEqual(high);
  expect(lantern.lyrics.startsWith(planned.lyrics.trimEnd())).toBe(true);
});

test('a long range grows a set by starting its body over, keeping its intro and outro at the ends', () => {
  const harbor = namedSet('harbor')!;
  const sizing = Sizing.of(harbor.lyrics);
  const n = aim(sizing, { min: 300, max: 360 });
  expect(n).toBeGreaterThan(sizing.written);
  const structure = sizing.structure(n);
  expect(structure[0]).toBe('intro');
  expect(structure.at(-1)).toBe('outro');
  for (let i = 1; i < structure.length; i += 1) expect(structure[i]).not.toBe(structure[i - 1]);
  expect(() => check(sizing.text(n))).not.toThrow();
});

test('every set sized to every offered length lands in the window, or is the size nearest it', () => {
  for (const set of PLANNING_SETS) {
    const sizing = Sizing.of(set.lyrics);
    for (const length of LENGTH_AIMS) {
      const range = { min: length.min, max: length.max };
      const n = aim(sizing, range);
      const [low, high] = aimWindow(range);
      const miss = (k: number): number => Math.max(low - sizing.lines(k) * PRIOR_SECONDS_PER_LINE, sizing.lines(k) * PRIOR_SECONDS_PER_LINE - high, 0);
      for (const other of sizing.sizes) expect(miss(n)).toBeLessThanOrEqual(miss(other));
    }
  }
});

test('a set that already fits is planned from exactly its own words', () => {
  const lantern = namedSet('lantern')!;
  // 16 lines at 8.6 s: 137.6 s, inside 2-3 minutes' window.
  expect(planningLyrics(lantern, { min: 120, max: 180 }).lyrics).toBe(lantern.lyrics);
  expect(planningLyrics(lantern, null)).toEqual({ id: 'lantern', lyrics: lantern.lyrics, sections: null });
});

test('picking is by the seed, mod the sets, and the same every time', () => {
  expect(pickSet(0).id).toBe('lantern');
  expect(pickSet(13).id).toBe('stairwell');
  expect(pickSet(4294967295).id).toBe(PLANNING_SETS[4294967295 % 10]!.id);
  expect(pickSet(123456).id).toBe(pickSet(123456).id);
  expect(trackSet(0).id).toBe('lantern');
  expect(trackSet(11).id).toBe('harbor');
});

test('a range holds the seconds inside it, either end open', () => {
  expect(holds({ min: 120, max: 180 }, 150)).toBe(true);
  expect(holds({ min: 120, max: 180 }, 190)).toBe(false);
  expect(holds({ min: null, max: 180 }, 10)).toBe(true);
  expect(aimWindow({ min: 100, max: 105 })).toEqual([102.5, 102.5]);
});
