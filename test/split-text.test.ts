import { expect, test } from 'bun:test';

import { corePrompt, describeSound, ideasPrompt, nameSong, soundPrompt, turnsPrompt, writeCore, writeTurns } from '../shared/core/split-text';
import type { TextModel, TextRequest } from '../shared/core/text-model';
import type { SongPage } from '../shared/types';

const page = { suggestions: [{ group: 'Genre', tags: ['folk', 'pop'] }], conflicts: [] } as unknown as SongPage;

function answering(content: object, asked: TextRequest[] = []): TextModel {
  return { name: 'qwen3.5-4b', ask: async (request) => { asked.push(request); return { content: JSON.stringify(content), truncated: false }; } };
}

test("every sound call is told YuE2's own guidance and to keep to musical elements (no sound effects)", () => {
  for (const prompt of [soundPrompt(page, false), corePrompt(true, page), turnsPrompt(true, false, 3, page)]) {
    expect(prompt).toContain("YuE2's own guidance for the style text");
    expect(prompt).toContain('No sound effects');
  }
});

test('a single song\'s sound: YuE2\'s order, as short as its examples, and no words (the lyricist writes those)', async () => {
  const asked: TextRequest[] = [];
  const sound = answering({
    language: 'English', genre: ['indie pop'], mood: ['melancholic'], vocal: ['soft female voice'],
    instruments: ['synth pads', 'piano'], sound: ['lo-fi'], bpm: 72, instrumental: false,
  }, asked);
  const described = await describeSound(sound, page, 'rainy night drive', false, 'feeling lost');
  expect(described.tags).toEqual(['English', 'indie pop', 'melancholic', 'soft female voice', 'synth pads', 'piano', 'lo-fi', '72 BPM']);
  expect(described.lyrics).toBeNull();
  expect(asked[0]!.tag).toBe('[sound]');
  expect(asked[0]!.user).toBe('rainy night drive\nThe lyrics will be about: feeling lost');
  expect(JSON.stringify(asked[0]!.schema)).not.toContain('lyrics');
});

test('an instrumental single has no singer, whatever the model answered', async () => {
  const sound = answering({
    language: 'English', genre: ['ambient'], mood: ['calm'], vocal: ['airy female voice'], instruments: ['piano'], sound: [], bpm: 70, instrumental: false,
  });
  const described = await describeSound(sound, page, 'calm piano', true, '');
  expect(described.instrumental).toBe(true);
  expect(described.tags).not.toContain('airy female voice');
});

test("an album's core: the person's own tags with no call, else the sound writer's phrases", async () => {
  const asked: TextRequest[] = [];
  const sound = answering({ core: ['indie folk', 'melancholic', 'warm acoustic guitar'] }, asked);
  const ask = { description: 'sad songs', tags: [] as string[], minutes: 30, sung: true };
  expect(await writeCore(sound, ask, { title: 'Spotted', blurb: '' }, page)).toBe('indie folk, melancholic, warm acoustic guitar');
  expect(await writeCore(sound, { ...ask, tags: ['lo-fi', 'jazz'] }, { title: 'Spotted', blurb: '' }, page)).toBe('lo-fi, jazz');
  expect(asked.length).toBe(1);
});

test('turns: one list per track in order, each joined; the tracks are named with what they are about', async () => {
  const asked: TextRequest[] = [];
  const sound = answering({ turns: [['tender', '72 BPM'], ['brighter', 'mandolin', '96 BPM']] }, asked);
  const turns = await writeTurns(sound, true, 'indie folk', [{ title: 'One', idea: 'a kitchen at dawn' }, { title: 'Two' }], page);
  expect(turns).toEqual(['tender, 72 BPM', 'brighter, mandolin, 96 BPM']);
  expect(asked[0]!.user).toBe('Core: indie folk\n1. "One": a kitchen at dawn\n2. "Two"');
});

test('track ideas stand alone on shuffle: no intros, outros, welcomes or goodbyes (Victoria, 2026-10-11)', () => {
  expect(ideasPrompt(true, 1, 15, 15)).toContain('no song is an intro, an outro, a welcome or a');
});

test("an instrumental single is named by the words writer, quotes trimmed", async () => {
  expect(await nameSong(answering({ title: '"Glass Harbor"' }), 'calm piano', ['Instrumental', 'piano'])).toBe('Glass Harbor');
});

test("a whole style line in one turn item is split, its cut-off end dropped, one singer kept (Victoria, 2026-10-11)", async () => {
  const sound = answering({ turns: [[
    "English, children's pop, playful female vocal, g",
    "English, children's pop, wise male vocal, piano",
    'thunderous drums',
  ]] });
  const [turn] = await writeTurns(sound, true, "children's pop, kids choir", [{ title: 'Crash Like Thunder, Zeus!' }], page);
  expect(turn).toBe("children's pop, playful female vocal, piano, thunderous drums");
});

test('an instrumental single names what carries its melody', async () => {
  const sound = answering({ language: 'English', genre: ['ambient'], mood: ['calm'], vocal: [], instruments: ['piano', 'strings'], sound: [], bpm: 70, instrumental: true });
  const described = await describeSound(sound, page, 'calm piano', true, '');
  expect(described.tags).toContain('piano melody');
});

test('a song made without a name is named from its sound and words, never a list of its tags (Owen, 2026-10-11)', async () => {
  const asked: TextRequest[] = [];
  const named = await nameSong(answering({ title: 'Iron at Dawn' }, asked), '', ['heavy metal', 'epic', 'dark'], '[Verse]\nWe ride at first light');
  expect(named).toBe('Iron at Dawn');
  expect(asked[0]!.system).toContain('You name a song');
  expect(asked[0]!.user).toContain('Lyrics:\n[Verse]\nWe ride at first light');
});
