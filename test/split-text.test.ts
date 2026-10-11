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
    language: 'English', genre: ['indie pop'], mood: ['melancholic'], lead: 'soft female voice',
    instruments: ['synth pads', 'piano'], sound: ['lo-fi'], bpm: 72, instrumental: false,
  }, asked);
  const described = await describeSound(sound, page, 'rainy night drive', false, 'feeling lost');
  expect(described.tags).toEqual(['English', 'indie pop', 'melancholic', 'soft female voice', 'synth pads', 'piano', 'lo-fi', '72 BPM']);
  expect(described.lead).toBe('soft female voice');
  expect(described.lyrics).toBeNull();
  expect(asked[0]!.tag).toBe('[sound]');
  expect(asked[0]!.user).toBe('rainy night drive\nThe lyrics will be about: feeling lost');
  expect(JSON.stringify(asked[0]!.schema)).not.toContain('lyrics');
});

test('an instrumental single has no singer, whatever the model answered', async () => {
  const sound = answering({
    language: 'English', genre: ['ambient'], mood: ['calm'], lead: 'airy female voice', instruments: ['piano'], sound: [], bpm: 70, instrumental: false,
  });
  const described = await describeSound(sound, page, 'calm piano', true, '');
  expect(described.instrumental).toBe(true);
  expect(described.tags).not.toContain('airy female voice');
  // A voice is never an instrumental's lead: its first instrument carries the melody instead.
  expect(described.lead).toBe('piano melody');
});

test("a single song's lead is one phrase, as the writer named it; an instrumental's is \"<instrument> melody\" (Owen, 2026-10-11)", async () => {
  const asked: TextRequest[] = [];
  const metal = answering({
    language: 'English', genre: ['heavy metal'], mood: ['dark'], lead: 'searing lead guitar', instruments: ['distorted guitar', 'double-kick drums'], sound: [], bpm: 140, instrumental: true,
  }, asked);
  const described = await describeSound(metal, page, 'dark metal', true, '');
  expect(described.lead).toBe('searing lead guitar');
  expect(described.tags).toEqual(['English', 'heavy metal', 'dark', 'searing lead guitar', 'distorted guitar', 'double-kick drums', '140 BPM']);
  expect(JSON.stringify(asked[0]!.schema)).toContain('"lead"');
  expect(JSON.stringify(asked[0]!.schema)).not.toContain('"vocal"');
  expect(asked[0]!.system).toContain('the instrument that plays the melody');
  // "violin" named as the lead: sent as "violin melody", and not said twice among the instruments.
  const strings = answering({ language: 'English', genre: ['ambient'], mood: ['calm'], lead: 'violin', instruments: ['violin', 'harp'], sound: [], bpm: 70, instrumental: true });
  const lyrical = await describeSound(strings, page, 'calm strings', true, '');
  expect(lyrical.lead).toBe('violin melody');
  expect(lyrical.tags).toEqual(['English', 'ambient', 'calm', 'violin melody', 'harp', '70 BPM']);
  // A sung song with no lead named is left to its tags.
  const none = answering({ language: 'English', genre: ['synth pop'], mood: ['happy'], lead: '', instruments: ['piano'], sound: [], bpm: 100, instrumental: false });
  expect((await describeSound(none, page, 'synth pop', false, '')).lead).toBeUndefined();
});

test("an album's core: the person's own tags with no call, else the sound writer's phrases", async () => {
  const asked: TextRequest[] = [];
  const sound = answering({ core: ['indie folk', 'melancholic', 'warm acoustic guitar'] }, asked);
  const ask = { description: 'sad songs', tags: [] as string[], minutes: 30, sung: true };
  expect(await writeCore(sound, ask, { title: 'Spotted', blurb: '' }, page)).toBe('indie folk, melancholic, warm acoustic guitar');
  expect(await writeCore(sound, { ...ask, tags: ['lo-fi', 'jazz'] }, { title: 'Spotted', blurb: '' }, page)).toBe('lo-fi, jazz');
  expect(asked.length).toBe(1);
});

test('turns: one lead and its other phrases per track in order, joined; the tracks are named with what they are about', async () => {
  const asked: TextRequest[] = [];
  const sound = answering({ turns: [{ lead: 'warm male voice', more: ['tender', '72 BPM'] }, { lead: 'soft female vocal', more: ['brighter', 'mandolin', '96 BPM'] }] }, asked);
  const turns = await writeTurns(sound, true, 'indie folk', [{ title: 'One', idea: 'a kitchen at dawn' }, { title: 'Two' }], page);
  expect(turns).toEqual([{ lead: 'warm male voice', more: 'tender, 72 BPM' }, { lead: 'soft female vocal', more: 'brighter, mandolin, 96 BPM' }]);
  expect(asked[0]!.user).toBe('Core: indie folk\n1. "One": a kitchen at dawn\n2. "Two"');
});

test("turns' lead (Owen, 2026-10-11): an instrumental's as a melody, never a voice; the person's own on every track; one voice at most", async () => {
  const asked: TextRequest[] = [];
  const instrumental = answering({ turns: [{ lead: 'cello', more: ['brooding', 'soft female voice', '70 BPM'] }, { lead: 'airy female voice', more: ['harp melody', 'calm'] }] }, asked);
  const turns = await writeTurns(instrumental, false, 'ambient', [{ title: 'One' }, { title: 'Two' }], page);
  expect(turns).toEqual([{ lead: 'cello melody', more: 'brooding, 70 BPM' }, { lead: 'harp melody', more: 'calm' }]);
  expect(asked[0]!.system).toContain('the ONE instrument that carries the melody');
  // The person's lead is every track's, and the writer is told it.
  const theirs: TextRequest[] = [];
  const sung = answering({ turns: [{ lead: 'raspy male vocal', more: ['female vocal', 'gritty', '120 BPM'] }] }, theirs);
  expect(await writeTurns(sung, true, 'rock', [{ title: 'One' }], page, 'gritty male voice')).toEqual([{ lead: 'gritty male voice', more: 'gritty, 120 BPM' }]);
  expect(theirs[0]!.system).toContain('Every track\'s lead is "gritty male voice"');
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
  // An answer in the older shape (a list a track) still reads: its first voice is the lead.
  const [turn] = await writeTurns(sound, true, "children's pop, kids choir", [{ title: 'Crash Like Thunder, Zeus!' }], page);
  expect(turn).toEqual({ lead: 'playful female vocal', more: "children's pop, piano, thunderous drums" });
});

test('an instrumental single names what carries its melody', async () => {
  const sound = answering({ language: 'English', genre: ['ambient'], mood: ['calm'], lead: '', instruments: ['piano', 'strings'], sound: [], bpm: 70, instrumental: true });
  const described = await describeSound(sound, page, 'calm piano', true, '');
  expect(described.tags).toContain('piano melody');
  expect(described.lead).toBe('piano melody');
});

test('a song made without a name is named from its sound and words, never a list of its tags (Owen, 2026-10-11)', async () => {
  const asked: TextRequest[] = [];
  const named = await nameSong(answering({ title: 'Iron at Dawn' }, asked), '', ['heavy metal', 'epic', 'dark'], '[Verse]\nWe ride at first light');
  expect(named).toBe('Iron at Dawn');
  expect(asked[0]!.system).toContain('You name a song');
  expect(asked[0]!.user).toContain('Lyrics:\n[Verse]\nWe ride at first light');
});
