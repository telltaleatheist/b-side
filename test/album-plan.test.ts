import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { nodeDisk } from '../electron/node-disk';
import { TemplateStore } from '../shared/core/album-templates';
import { AlbumMaker, trackSong, type AlbumHooks, type AlbumTrackParams } from '../shared/core/albums';
import { plannedAlbum } from '../shared/core/hub-core';
import type { Lyricist, SongToWrite } from '../shared/core/lyricist';
import type { AlbumAsk, AlbumMeta, AlbumTrackPlan, SongPage } from '../shared/types';

// Make → Album's "I want to plan it" (Victoria, 2026-10-12): song by song, each track sung exactly
// as written, written from a brief, or left blank; sung or instrumental and its lead track by track;
// three ways to take the tags; templates by name on the hub.

const MODEL = 'qwen3.5-4b-bside';
const page = { suggestions: [], tagModel: MODEL, tagModelReason: null, length: true } as unknown as SongPage;

function fakeServer() {
  const sent: { tag: string; user: string; system: string }[] = [];
  let ideas = 0;
  const chat = async (options: { messages: { content: string }[]; responseFormat: { json_schema: { schema: any } } }) => {
    const user = options.messages[1]!.content;
    const tag = user.split('\n')[0]!;
    sent.push({ tag, user, system: options.messages[0]!.content });
    const answer = (value: unknown) => ({ finishReason: 'stop', content: JSON.stringify(value) });
    if (tag === '[concept]') return answer({ title: 'Verses', artist: 'The Readers', blurb: 'Poems, sung.' });
    if (tag === '[ideas]') {
      const n = options.responseFormat.json_schema.schema.properties.tracks.minItems as number;
      return answer({ tracks: Array.from({ length: n }, () => ({ title: `Idea ${++ideas}`, idea: `about ${ideas}` })) });
    }
    if (tag === '[core]') return answer({ core: ['indie folk', 'warm'] });
    if (tag === '[turns]') {
      const n = options.responseFormat.json_schema.schema.properties.turns.minItems as number;
      const instrumental = !/the ONE singer/.test(options.messages[0]!.content);
      return answer({ turns: Array.from({ length: n }, () => ({ lead: instrumental ? 'flute melody' : 'soft female voice', more: ['brushed drums', '80 BPM'] })) });
    }
    if (tag === '[lyrics]') return answer({ lyrics: '[verse]\nserver words\n\n[chorus]\nla' });
    if (tag === '[cover]') return answer({ coverPrompt: 'a lamp on a desk' });
    if (tag === '[song name]') return answer({ title: 'Named For It' });
    throw new Error(`unexpected task ${tag}`);
  };
  const session = { id: 's', chat, models: async () => [{ id: MODEL, installed: true, resident: true }], playground: async () => [], close: async () => undefined };
  return { sent, client: { ...session, session: async () => session, closeSession: async () => undefined } };
}

function fakeLyricist() {
  const asked: SongToWrite[] = [];
  const lyricist: Lyricist = { name: 'claude', write: async (song) => { asked.push(song); return `[Verse]\nwritten for ${song.title}`; } };
  return { asked, lyricist };
}

function fakeAlbum(ask: AlbumAsk, server: ReturnType<typeof fakeServer>, lyricist: Lyricist | null = null) {
  let stored: AlbumMeta = { artist: '', blurb: '', cover: null, ask, plan: null, stage: 'planning', sent: 0, madeS: 0, refusal: null, server: 'pc', writer: null };
  const rendered: { track: number; params: AlbumTrackParams }[] = [];
  const flight = { flying: 0 };
  const hooks: AlbumHooks = {
    meta: async () => stored,
    update: async (_id, next) => { stored = next; },
    server: () => ({ name: 'pc', url: 'http://pc:7100', token: 't' }) as never,
    client: () => server.client as never,
    page: async () => page,
    paint: async () => 'c.png',
    removeCover: async () => undefined,
    render: (_id, track, _server, params) => { rendered.push({ track, params }); flight.flying += 1; },
    inFlight: () => flight.flying,
    retitle: async () => undefined,
    cancelInFlight: async () => undefined,
    made: async () => [],
    flyingTracks: () => [],
    renameSong: async () => undefined,
    makingOn: async () => ['a'],
    claude: () => (lyricist === null ? null : { text: null, words: null, lyricist }),
  };
  const maker = new AlbumMaker(hooks);
  return {
    maker, rendered, flight, meta: () => stored,
    /** Land every track the album sends, until it is done. */
    async finish(): Promise<void> {
      for (let i = 0; i < 100 && stored.stage === 'making'; i += 1) {
        if (flight.flying === 0) break;
        flight.flying -= 1;
        await maker.landed('a', 200);
      }
    },
  };
}

async function make(ask: AlbumAsk, lyricist: Lyricist | null = null) {
  const server = fakeServer();
  const album = fakeAlbum(ask, server, lyricist);
  album.maker.start('a');
  for (let i = 0; i < 200 && album.maker.writing('a'); i += 1) await new Promise((rest) => setTimeout(rest, 2));
  return { server, album };
}

const ask = (plan: AlbumTrackPlan, change: Partial<AlbumAsk> = {}): AlbumAsk => ({ description: 'poems', tags: ['folk'], minutes: 15, sung: true, plan, ...change });
const poem = 'How do you like to go up in a swing,\nUp in the air so blue?';

// ── the request ──────────────────────────────────────────────────────────────

test('a plan is 1 to 45 songs; outside that it is refused by name', () => {
  expect(() => plannedAlbum({ tagMode: 'vibe', tracks: [] }, true, false, false)).toThrow(expect.objectContaining({ code: 'plan_empty' }));
  expect(() => plannedAlbum({ tagMode: 'vibe', tracks: Array.from({ length: 46 }, () => ({})) }, true, false, false)).toThrow(expect.objectContaining({ code: 'plan_many' }));
  expect(plannedAlbum({ tagMode: 'vibe', tracks: [{}] }, true, false, false).tracks).toEqual([{}]);
  expect(plannedAlbum({ tagMode: 'vibe', tracks: Array.from({ length: 45 }, () => ({})) }, true, false, false).tracks.length).toBe(45);
});

test('a plan refuses nonsense by name and track, and never cuts', () => {
  const one = (track: Record<string, unknown>, sung = true) => () => plannedAlbum({ tagMode: 'vibe', tracks: [{}, track] }, sung, false, false);
  expect(one({ lyrics: 'x'.repeat(6001) })).toThrow(expect.objectContaining({ code: 'plan_lyrics_long', message: expect.stringContaining('Song 2') }));
  expect(one({ brief: 'x'.repeat(2001) })).toThrow(expect.objectContaining({ code: 'plan_brief_long' }));
  expect(one({ title: 'x'.repeat(121) })).toThrow(expect.objectContaining({ code: 'plan_title_long' }));
  expect(one({ lyrics: poem, brief: 'a swing' })).toThrow(expect.objectContaining({ code: 'plan_lyrics_and_brief' }));
  expect(one({ lyrics: poem }, false)).toThrow(expect.objectContaining({ code: 'plan_lyrics_instrumental' }));
  expect(one({ lyrics: poem, sung: false })).toThrow(expect.objectContaining({ code: 'plan_lyrics_instrumental' }));
  expect(one({ tags: 'folk' })).toThrow(expect.objectContaining({ code: 'body_invalid' }));
  expect(() => plannedAlbum({ tagMode: 'loud', tracks: [{}] }, true, false, false)).toThrow(expect.objectContaining({ code: 'body_invalid' }));
});

test('a plan keeps lyrics exactly, tags only per song, and a track\'s own sung and lead', () => {
  const words = '\r\n\n  Indented first line\r\nsecond line  \n\n';
  const per = plannedAlbum({ tagMode: 'per-song', tracks: [{ title: '  The   Swing ', lyrics: words, tags: [' piano ', ''] }, { sung: false, lead: 'cello', brief: 'a storm' }, { sung: true }] }, true, false, false);
  expect(per.tracks).toEqual([
    { title: 'The Swing', lyrics: '  Indented first line\nsecond line', tags: ['piano'] },
    { brief: 'a storm', sung: false, lead: 'cello' },
    {},
  ]);
  const vibe = plannedAlbum({ tracks: [{ tags: ['piano'] }] }, true, false, true);
  expect(vibe).toEqual({ tagMode: 'exact', tracks: [{}] });
  // Section tags only when asked, and no word changed.
  expect(plannedAlbum({ tagMode: 'vibe', tracks: [{ lyrics: 'one\n\ntwo' }] }, true, true, false).tracks[0]!.lyrics).toBe('[Verse]\none\n\n[Verse]\ntwo');
});

// ── the album ────────────────────────────────────────────────────────────────

test('exact lyrics are sent verbatim, titles kept, and an all-exact album asks no lyricist', async () => {
  const lyricist: Lyricist = { name: 'claude', write: async () => { throw new Error('never asked'); } };
  const { server, album } = await make(ask({ tagMode: 'vibe', tracks: [{ title: 'The Swing', lyrics: poem }, { lyrics: 'a plain paragraph, sung as it is.' }] }), lyricist);
  expect(server.sent.map((call) => call.tag)).not.toContain('[lyrics]');
  expect(server.sent.map((call) => call.tag)).not.toContain('[ideas]');
  const tracks = album.meta().plan!.tracks;
  expect(tracks.map((track) => track.title)).toEqual(['The Swing', 'Named For It']);
  expect(album.meta().lyricsBy).toBe('you');
  await album.finish();
  expect(album.rendered.map((each) => each.params.lyrics)).toEqual([poem, 'a plain paragraph, sung as it is.']);
  expect(album.meta().stage).toBe('done');
});

test('brief and blank tracks go to the lyricist, told the brief and every title on the album', async () => {
  const { asked, lyricist } = fakeLyricist();
  const { server, album } = await make(ask({
    tagMode: 'vibe',
    tracks: [{ title: 'Kept', lyrics: poem }, { brief: 'a lighthouse keeper retiring' }, {}, { title: 'Given Name' }],
  }), lyricist);
  // The blank track is planned as a generated one is, alone, told the titles so far.
  const ideas = server.sent.filter((call) => call.tag === '[ideas]');
  expect(ideas.length).toBe(1);
  expect(ideas[0]!.user).toContain('"Kept"');
  expect(ideas[0]!.user).toContain('"Named For It"');
  const tracks = album.meta().plan!.tracks;
  expect(tracks.map((track) => track.title)).toEqual(['Kept', 'Named For It', 'Idea 1', 'Given Name']);
  expect(asked.map((song) => song.title)).toEqual(['Named For It', 'Idea 1', 'Given Name']);
  expect(asked[0]!.idea).toBe('a lighthouse keeper retiring');
  expect(asked[1]!.idea).toBe('about 1');
  // The album's variety rules: each is told the whole track list and its place in it.
  expect(asked[0]!.album).toMatchObject({ tracks: ['Kept', 'Named For It', 'Idea 1', 'Given Name'], at: 1 });
  expect(tracks[0]!.lyrics).toBe(poem);
  expect(tracks[1]!.lyrics).toBe('[Verse]\nwritten for Named For It');
});

test("the server's model writes a brief track's words to its brief (no Claude)", async () => {
  const { server } = await make(ask({ tagMode: 'vibe', tracks: [{ title: 'Keeper', brief: 'a lighthouse keeper retiring' }] }, { lyrics: 'wry' }));
  const lyrics = server.sent.find((call) => call.tag === '[lyrics]')!;
  expect(lyrics.user).toContain('The lyrics: a lighthouse keeper retiring');
});

test('the three tag modes: the general vibe, exactly the tags, and tags set for each song', async () => {
  const tracks = [{ title: 'One', lyrics: poem, tags: ['solo piano'] }, { title: 'Two', lyrics: poem }];
  const tagsOf = async (tagMode: AlbumTrackPlan['tagMode']) => {
    const { album } = await make(ask({ tagMode, tracks }, tagMode === 'exact' ? { exactTags: true } : {}));
    await album.finish();
    return album.rendered.map((each) => each.params.tags);
  };
  // Vibe: each varies on the album's tags, with the writer's lead and additions.
  expect(await tagsOf('vibe')).toEqual(['soft female voice, folk, brushed drums, 80 BPM', 'soft female voice, folk, brushed drums, 80 BPM']);
  // Exact: the album's tags, only a tempo added.
  expect(await tagsOf('exact')).toEqual(['folk, 80 BPM', 'folk, 80 BPM']);
  // Per song: the track's own tags reach its request (only a tempo added); one without keeps the album's.
  expect(await tagsOf('per-song')).toEqual(['solo piano, 80 BPM', 'folk, 80 BPM']);
});

test('a mixed album: each track sung or instrumental on its own, its own lead, the lyricist only for sung tracks', async () => {
  const { asked, lyricist } = fakeLyricist();
  const { album } = await make(ask({
    tagMode: 'vibe',
    tracks: [
      { title: 'Sung Poem', lyrics: poem },
      { title: 'Interlude', sung: false, brief: 'waves at night', lead: 'cello' },
      { title: 'Written', brief: 'a train' },
      { title: 'Blank Instrumental', sung: false },
      { title: 'Own Singer', brief: 'a fox', lead: 'gritty male voice' },
    ],
  }, { lead: 'warm female voice' }), lyricist);
  expect(asked.map((song) => song.title)).toEqual(['Written', 'Own Singer']);
  await album.finish();
  const sent = album.rendered.map((each) => each.params);
  expect(sent.map((params) => params.instrumental)).toEqual([false, true, false, true, false]);
  expect(sent[1]!.lyrics).toBeUndefined();
  expect(sent[3]!.lyrics).toBeUndefined();
  // Leads: the album's for its sung tracks, a track's own where it has one, the writer's for an
  // instrumental the album's singer cannot lead.
  expect(sent.map((params) => params.lead)).toEqual(['warm female voice', 'cello melody', 'warm female voice', 'flute melody', 'gritty male voice']);
  expect(sent[1]!.tags).toBe('cello melody, folk, brushed drums, 80 BPM, instrumental');
  // Each instrumental gets its planning set when sent to the server.
  expect(trackSong(sent[1]!, 1, page).planning_set).toBeDefined();
  expect(trackSong(sent[0]!, 0, page).planning_set).toBeUndefined();
});

test('a planned album makes every song, whatever its minutes, and cannot be extended', async () => {
  const tracks = Array.from({ length: 12 }, (_, at) => ({ title: `Poem ${at + 1}`, lyrics: poem }));
  const { album } = await make(ask({ tagMode: 'vibe', tracks }, { minutes: 1 }));
  await album.finish();
  expect(album.rendered.length).toBe(12);
  expect(album.meta().stage).toBe('done');
  await expect(album.maker.extend('a')).rejects.toMatchObject({ code: 'album_planned' });
});

test('an album in your own words (older clients) still sings every track exactly', async () => {
  const ownWords = Array.from({ length: 10 }, (_, at) => ({ title: at === 0 ? null : `Poem ${at + 1}`, lyrics: `${poem} ${at}` }));
  const { server, album } = await make({ description: 'poems', tags: ['folk'], minutes: 15, sung: true, ownWords });
  expect(server.sent.map((call) => call.tag)).not.toContain('[lyrics]');
  expect(album.meta().plan!.tracks[0]!.title).toBe('Named For It');
  await album.finish();
  expect(album.rendered.map((each) => each.params.lyrics)).toEqual(ownWords.map((track) => track.lyrics));
  await expect(album.maker.extend('a')).rejects.toMatchObject({ code: 'album_own_words' });
});

// ── templates ────────────────────────────────────────────────────────────────

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-templates-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('templates are saved by name, listed, loaded whole and deleted, and kept on disk', async () => {
  const store = new TemplateStore(nodeDisk, dir, () => Date.UTC(2026, 9, 12));
  const plan: AlbumTrackPlan = { tagMode: 'per-song', tracks: [{ title: 'The Swing', lyrics: poem, tags: ['piano'] }, { sung: false, lead: 'cello' }] };
  const body = { description: 'poems for children', tags: ['folk'], lead: '', sung: true, plan };
  expect(await store.save('  Poems ', body)).toEqual([{ name: 'Poems', savedAt: '2026-10-12T00:00:00.000Z', tracks: 2 }]);
  await store.save('Atlas', { ...body, plan: { tagMode: 'vibe', tracks: [{}] } });
  expect((await store.list()).map((t) => t.name)).toEqual(['Atlas', 'Poems']);
  const reopened = new TemplateStore(nodeDisk, dir);
  expect(await reopened.get('Poems')).toEqual({ ...body, name: 'Poems', savedAt: '2026-10-12T00:00:00.000Z' });
  expect((await reopened.remove('Atlas')).map((t) => t.name)).toEqual(['Poems']);
  await expect(reopened.get('Atlas')).rejects.toMatchObject({ code: 'template_missing' });
  await expect(reopened.save(' ', body)).rejects.toMatchObject({ code: 'template_name' });
});
