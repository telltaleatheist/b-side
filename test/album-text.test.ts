import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import {
  albumPrompt, albumUser, ALBUM_SCHEMA, artistPrompt, artistUser, batches, coverPrompt, coverUser, LYRICS_SCHEMA,
  lyricsPrompt, lyricsUser, oneSchema, titlePrompt, titlesPrompt, titlesSchema, titlesUser, titleUser, tracksPrompt,
  tracksSchema, tracksUser, aboutOf,
} from '../shared/core/album-text';
import { trackTags } from '../shared/core/albums';
import { tagPrompt } from '../shared/core/describe';
import type { AlbumAsk, SongPage } from '../shared/types';

/**
 * The v2 model was trained on exactly the strings orpheus-finetune's tasks.py renders; this fixture is
 * that rendering (tools/v2-contract-fixtures.py). Every builder must match it byte for byte.
 */
const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'v2-contract.json'), 'utf8'));
const page = { suggestions: (fixture.page as [string, string[]][]).map(([group, tags]) => ({ group, tags })) } as unknown as SongPage;

test('the single-task prompts and schemas are the contract', () => {
  expect(lyricsPrompt()).toBe(fixture.lyricsPrompt);
  expect(titlePrompt()).toBe(fixture.titlePrompt);
  expect(artistPrompt()).toBe(fixture.artistPrompt);
  expect(titlesPrompt(5)).toBe(fixture.titlesPrompt5);
  expect(coverPrompt()).toBe(fixture.coverPrompt);
  expect(ALBUM_SCHEMA).toEqual(fixture.schemas.album);
  expect(LYRICS_SCHEMA).toEqual(fixture.schemas.lyrics);
  expect(oneSchema('title')).toEqual(fixture.schemas.title);
  expect(titlesSchema(5)).toEqual(fixture.schemas.titles5);
});

test('[describe] keeps its v1 prompt', () => {
  expect(tagPrompt(page, false)).toBe(fixture.describe.tagPrompt);
  expect(tagPrompt(page, true)).toBe(fixture.describe.tagPromptInstr);
});

for (const c of fixture.cases as Array<Record<string, any>>) {
  test(`contract case ${c.id}`, () => {
    const ask = c.ask as AlbumAsk;
    const album = c.album;
    expect(albumPrompt(ask, c.count, page)).toBe(c.albumPrompt);
    expect(albumUser(ask)).toBe(c.albumUser);
    expect(batches(c.count)).toEqual(c.batches);
    const titles = Array.from({ length: c.count }, (_, at) => `Track ${at + 1}`);
    for (const batch of c.tracks) {
      expect(tracksPrompt(ask.sung, album.core, batch.first, batch.last, c.count, page)).toBe(batch.prompt);
      expect(tracksUser(ask, album, titles.slice(0, batch.first - 1))).toBe(batch.user);
      expect(tracksSchema(batch.last - batch.first + 1)).toEqual(batch.schema);
    }
    const tags = trackTags(album.core, 'soft female voice, 68 BPM', ask.sung);
    expect(tags).toBe(c.trackTags);
    expect(lyricsUser(album, 'Counter Light', tags, aboutOf(ask), ask.sung && ask.lyrics ? ask.lyrics : '')).toBe(c.lyricsUser);
    expect(titleUser(ask, album, ['Spotted at the Edges'])).toBe(c.titleUser);
    expect(titleUser(ask, album, [])).toBe(c.titleUserNoAvoid);
    expect(artistUser(ask, album, [])).toBe(c.artistUser);
    expect(artistUser(ask, album, ['The Fruit Bowl Elegies'])).toBe(c.artistUserAvoid);
    expect(titlesUser(ask, album, 5, ['Track 1', 'Track 2'])).toBe(c.titlesUser);
    expect(coverUser(ask, album)).toBe(c.coverUser);
  });
}
