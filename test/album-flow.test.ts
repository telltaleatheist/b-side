import { expect, test } from 'bun:test';

import { AlbumMaker, type AlbumHooks, type AlbumTrackParams } from '../shared/core/albums';
import type { Lyricist, SongToWrite } from '../shared/core/lyricist';
import type { TextModel } from '../shared/core/text-model';
import type { AlbumAsk, AlbumMeta, SongPage } from '../shared/types';

const MODEL = 'qwen3.5-4b-bside';
const page = {
  suggestions: [{ group: 'Genre', tags: ['folk', 'pop'] }],
  tagModel: MODEL,
  tagModelReason: null,
} as unknown as SongPage;

interface Sent { tag: string; model: string; user: string; system: string }

/** A Crucible that answers every v2 task, recording what each call sent. */
function fakeServer(failLyricsAt: number | null = null) {
  const sent: Sent[] = [];
  let lyricsCalls = 0;
  let tracksWritten = 0;
  const chat = async (options: { model: string; messages: { role: string; content: string }[]; responseFormat: { json_schema: { schema: any } } }) => {
    const user = options.messages[1]!.content;
    const tag = user.split('\n')[0]!;
    sent.push({ tag, model: options.model, user, system: options.messages[0]!.content });
    if (tag === '[concept]') return { finishReason: 'stop', content: JSON.stringify({ title: 'Spotted', artist: 'The Elegies', blurb: 'Ripening.' }) };
    if (tag === '[ideas]') {
      const n = options.responseFormat.json_schema.schema.properties.tracks.minItems as number;
      const tracks = Array.from({ length: n }, () => ({ title: `Song ${++tracksWritten}`, idea: `idea ${tracksWritten}` }));
      return { finishReason: 'stop', content: JSON.stringify({ tracks }) };
    }
    if (tag === '[core]') return { finishReason: 'stop', content: JSON.stringify({ core: ['indie folk', 'melancholic'] }) };
    if (tag === '[turns]') {
      const n = options.responseFormat.json_schema.schema.properties.turns.minItems as number;
      return { finishReason: 'stop', content: JSON.stringify({ turns: Array.from({ length: n }, () => ({ lead: 'soft female voice', more: ['80 BPM'] })) }) };
    }
    if (tag === '[lyrics]') {
      lyricsCalls += 1;
      if (lyricsCalls === failLyricsAt) throw new Error('the server went away');
      return { finishReason: 'stop', content: JSON.stringify({ lyrics: '[verse]\nla\n\n[chorus]\nla' }) };
    }
    if (tag === '[album title]') return { finishReason: 'stop', content: JSON.stringify({ title: 'Brown at the Edges' }) };
    if (tag === '[artist]') return { finishReason: 'stop', content: JSON.stringify({ artist: 'The Peel' }) };
    if (tag === '[cover]') return { finishReason: 'stop', content: JSON.stringify({ coverPrompt: 'a bowl of fruit at dusk' }) };
    if (tag === '[track titles]') return { finishReason: 'stop', content: JSON.stringify({ titles: ['Counter Light'] }) };
    throw new Error(`unexpected task ${tag}`);
  };
  const session = {
    id: 'ses-1',
    chat,
    models: async () => [{ id: MODEL, installed: true, resident: true }],
    playground: async () => [],
    close: async () => undefined,
  };
  const client = { ...session, session: async () => session, closeSession: async () => undefined };
  return { sent, client };
}

function fakeAlbum(ask: AlbumAsk, server: ReturnType<typeof fakeServer>, claude: { text: TextModel | null; words?: TextModel | null; lyricist: Lyricist | null } | null = null) {
  let stored: AlbumMeta = {
    artist: '', blurb: '', cover: null, ask, plan: null, stage: 'planning', sent: 0, madeS: 0,
    refusal: null, server: 'pc', writer: null,
  };
  let lastId = '';
  const names: string[] = [];
  const renamed: Array<[string, string]> = [];
  /** Tracks sent to the server, as sent; `flying` of them not landed yet. */
  const rendered: Array<{ track: number; params: AlbumTrackParams }> = [];
  const flight = { flying: 0 };
  const hooks: AlbumHooks = {
    meta: async (id) => { lastId = id; return stored; },
    update: async (_id, next, name) => { stored = next; if (name) names.push(name); },
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
    renameSong: async (_id, from, to) => { renamed.push([from, to]); },
    makingOn: async () => [lastId],
    claude: () => claude,
  };
  return { maker: new AlbumMaker(hooks), meta: () => stored, names, renamed, rendered, flight, set: (change: Partial<AlbumMeta>) => { stored = { ...stored, ...change }; } };
}

async function settle(maker: AlbumMaker, id: string): Promise<void> {
  for (let i = 0; i < 200 && maker.writing(id); i += 1) await new Promise((rest) => setTimeout(rest, 2));
}

test('a 90-minute sung album on the server alone: the words, then the sound, then the cover, then [lyrics] per track', async () => {
  const server = fakeServer();
  const album = fakeAlbum({ description: 'sad songs about bananas', tags: [], minutes: 90, sung: true, lyrics: 'a banana going brown' }, server);
  album.maker.start('a');
  await settle(album.maker, 'a');
  const tags = server.sent.map((call) => call.tag);
  expect(tags.slice(0, 9)).toEqual(['[concept]', '[ideas]', '[ideas]', '[ideas]', '[core]', '[turns]', '[turns]', '[turns]', '[cover]']);
  expect(tags.slice(9).every((tag) => tag === '[lyrics]')).toBe(true);
  expect(tags.length).toBe(9 + 45);
  expect(server.sent.every((call) => call.model === MODEL)).toBe(true);
  // Each later batch of ideas is told every title so far, numbered.
  const second = server.sent[2]!;
  expect(second.system).toContain('tracks 16-30 of 45');
  expect(second.user).toContain('Already on the album: 1. "Song 1"; 2. "Song 2"');
  expect(second.user).not.toContain('16. "');
  // [turns] is told each track's title and what it is about.
  expect(server.sent[5]!.user).toContain('1. "Song 1": idea 1');
  // [lyrics] carries the track's full tags (its lead first, then core + turn) and the brief.
  expect(server.sent[9]!.user).toBe('[lyrics]\nAlbum: "Spotted" by The Elegies. Ripening.\nAbout: sad songs about bananas\nThe lyrics: a banana going brown\nSong: "Song 1" (soft female voice, indie folk, melancholic, 80 BPM)');
  const meta = album.meta();
  expect(meta.plan!.tracks.length).toBe(45);
  expect(meta.plan!.tracks[0]!.idea).toBe('idea 1');
  expect(meta.plan!.coverPrompt).toBe('a bowl of fruit at dusk');
  expect(meta.plan!.tracks.every((track) => track.lyrics === '[Verse]\nla\n\n[Chorus]\nla')).toBe(true);
  expect(meta.writer).toBe(MODEL);
  expect(meta.soundBy).toBe(MODEL);
  expect(meta.stage).toBe('making');
  expect(album.names).toContain('Spotted');
});

test('an instrumental album writes no lyrics', async () => {
  const server = fakeServer();
  const album = fakeAlbum({ description: '', tags: [], minutes: 30, sung: false }, server);
  album.maker.start('b');
  await settle(album.maker, 'b');
  expect(server.sent.map((call) => call.tag)).toEqual(['[concept]', '[ideas]', '[core]', '[turns]', '[cover]']);
  expect(server.sent[0]!.user).toBe('[concept]\nSurprise me.');
  expect(album.meta().plan!.tracks.every((track) => track.lyrics === null && track.tags.endsWith('instrumental'))).toBe(true);
});

test("the person's own tags are the core: no [core] call", async () => {
  const server = fakeServer();
  const album = fakeAlbum({ description: '', tags: ['lo-fi', 'jazz'], minutes: 30, sung: false }, server);
  album.maker.start('t');
  await settle(album.maker, 't');
  expect(server.sent.map((call) => call.tag)).toEqual(['[concept]', '[ideas]', '[turns]', '[cover]']);
  expect(album.meta().plan!.core).toBe('lo-fi, jazz');
});

test('a lyrics call that fails stops the album where it is; Continue writes only what is missing', async () => {
  const server = fakeServer(3);
  const album = fakeAlbum({ description: 'x', tags: [], minutes: 30, sung: true }, server);
  album.maker.start('c');
  await settle(album.maker, 'c');
  expect(album.meta().stage).toBe('failed');
  expect(album.meta().plan!.tracks.filter((track) => track.lyrics !== null).length).toBe(2);
  const before = server.sent.length;
  await album.maker.resume('c');
  await settle(album.maker, 'c');
  const again = server.sent.slice(before).map((call) => call.tag);
  // Nothing written again: the names, the sound and the cover were kept; only the 13 missing lyrics.
  expect(again).toEqual(Array(13).fill('[lyrics]'));
  expect(album.meta().stage).toBe('making');
});

test('regenerate writes one piece again on the tag model, with the context the contract names', async () => {
  const server = fakeServer();
  const album = fakeAlbum({ description: 'sad songs about bananas', tags: [], minutes: 30, sung: false }, server);
  album.maker.start('d');
  await settle(album.maker, 'd');
  album.set({ sent: 3 });
  const before = server.sent.length;

  await album.maker.regenerate('d', 'title');
  expect(album.meta().plan!.title).toBe('Brown at the Edges');
  expect(album.names).toContain('Brown at the Edges');
  const titleCall = server.sent[before]!;
  expect(titleCall.user).toBe('[album title]\nAbout: sad songs about bananas\nSound: indie folk, melancholic\nSung: no (instrumental)\nNot these: Spotted');

  await album.maker.regenerate('d', 'artist');
  expect(album.meta().artist).toBe('The Peel');

  // A made track (place 1 < sent): the plan and its song are renamed together; the rest of the album is avoided.
  await album.maker.regenerate('d', 'track', 1);
  expect(album.meta().plan!.tracks[1]!.title).toBe('Counter Light');
  expect(album.renamed).toEqual([['Song 2', 'Counter Light']]);
  const titlesCall = server.sent.find((call) => call.tag === '[track titles]')!;
  expect(titlesCall.system).toContain('exactly 1 titles');
  expect(titlesCall.user).toContain('Not these: Song 1; Song 2; Song 3');

  // No image model on this server: the description is new, and the album keeps the standard cover.
  await album.maker.regenerate('d', 'cover');
  expect(album.meta().plan!.coverPrompt).toBe('a bowl of fruit at dusk');
  expect(album.meta().coverState).toBe('no_model');
  expect(server.sent.every((call) => call.model === MODEL)).toBe(true);
});

test('regenerate refuses while the album is still being written', async () => {
  const server = fakeServer();
  const album = fakeAlbum({ description: 'x', tags: [], minutes: 30, sung: true }, server);
  album.maker.start('e');
  await expect(album.maker.regenerate('e', 'title')).rejects.toThrow('still being written');
  await settle(album.maker, 'e');
});

/** Claude answering the same calls: the fake server's own answers, replayed, each call's tag recorded. */
function fakeClaude(server: ReturnType<typeof fakeServer>, texts: string[]): TextModel {
  return {
    name: 'claude-sonnet-5-5',
    ask: async (request) => {
      texts.push(request.tag);
      const answer = await (server.client as unknown as { chat: (o: unknown) => Promise<{ content: string }> }).chat({
        model: 'x', responseFormat: { json_schema: { schema: request.schema } }, messages: [{ content: request.system }, { content: `${request.tag}\n${request.user}` }],
      });
      return { content: answer.content, truncated: false };
    },
  };
}

test('with Claude writing both the words and the sound, the server is never asked to write or hold anything', async () => {
  const server = fakeServer();
  let sessions = 0;
  (server.client as { session: () => Promise<unknown> }).session = async () => { sessions += 1; return {}; };
  const texts: string[] = [];
  const asked: SongToWrite[] = [];
  const claude = fakeClaude(server, texts);
  const lyricist: Lyricist = { name: 'claude-sonnet-5-5', write: async (song) => { asked.push(song); return '[intro]\noh\n[verse]\nla la\n[pre-chorus]\nhey\n[chorus]\nyeah'; } };
  const album = fakeAlbum({ description: 'sad songs about bananas', tags: [], minutes: 30, sung: true, lyrics: 'a banana going brown' }, server, { text: claude, words: claude, lyricist });
  album.maker.start('f');
  await settle(album.maker, 'f');
  expect(texts).toEqual(['[concept]', '[ideas]', '[core]', '[turns]', '[cover]']);
  expect(sessions).toBe(0);
  expect(asked.length).toBe(15);
  expect(asked[2]!.album!.at).toBe(2);
  expect(asked[2]!.album!.tracks.length).toBe(15);
  expect(asked[2]!.idea).toBe('idea 3');
  expect(asked[0]!.brief).toBe('a banana going brown');
  expect(asked[0]!.tags).toBe('soft female voice, indie folk, melancholic, 80 BPM');
  // Laid out for YuE: every section on its own line, a blank line before each after the first.
  expect(album.meta().plan!.tracks[0]!.lyrics).toBe('[Intro]\noh\n\n[Verse]\nla la\n\n[Pre-Chorus]\nhey\n\n[Chorus]\nyeah');
  expect(album.meta().writer).toBe('claude-sonnet-5-5');
  expect(album.meta().lyricsBy).toBe('claude-sonnet-5-5');
  expect(album.meta().stage).toBe('making');
});

test('Claude writes the words and the server the sound (Owen, 2026-10-11)', async () => {
  const server = fakeServer();
  const texts: string[] = [];
  const asked: SongToWrite[] = [];
  const claude = fakeClaude(server, texts);
  const lyricist: Lyricist = { name: 'claude-sonnet-5-5', write: async (song) => { asked.push(song); return '[verse]\na\nb\nc\nd\n[chorus]\ne\nf\ng\nh'; } };
  const album = fakeAlbum({ description: 'sad songs about bananas', tags: [], minutes: 30, sung: true }, server, { text: null, words: claude, lyricist });
  album.maker.start('s');
  await settle(album.maker, 's');
  expect(texts).toEqual(['[concept]', '[ideas]']);
  // Claude's calls go through the fake too, under model "x": the server's own are the sound.
  expect(server.sent.filter((call) => call.model === MODEL).map((call) => call.tag)).toEqual(['[core]', '[turns]', '[cover]']);
  expect(asked.length).toBe(15);
  expect(album.meta().writer).toBe('claude-sonnet-5-5');
  expect(album.meta().soundBy).toBe(MODEL);
  expect(album.meta().lyricsBy).toBe('claude-sonnet-5-5');
  expect(album.meta().stage).toBe('making');
});

// ── Make this track again (Victoria, 2026-10-11) ──────────────────────────────

test('a track made again with new lyrics: Claude writes them with the album around it, the new take sings them, the plan keeps them once it lands', async () => {
  const server = fakeServer();
  const asked: SongToWrite[] = [];
  let calls = 0;
  const lyricist: Lyricist = { name: 'claude-sonnet-5-5', write: async (song) => { asked.push(song); calls += 1; return `[verse]\ntake ${calls}\n[chorus]\nships`; } };
  const claude = fakeClaude(server, []);
  const album = fakeAlbum({ description: 'the Iliad', tags: [], minutes: 30, sung: true, lyrics: 'Troy', trackLength: '3-5' }, server, { text: null, words: claude, lyricist });
  album.maker.start('g');
  await settle(album.maker, 'g');
  // Made, and done: every track on the album.
  album.set({ stage: 'done', sent: 10, madeS: 1800, redo: [] });
  album.flight.flying = 0;
  const old = album.meta().plan!.tracks[2]!.lyrics;
  const before = asked.length;

  await album.maker.remake('g', 2, { fresh: true, song: 'old-take', keep: null });
  const song = asked[before]!;
  expect(song).toMatchObject({ title: 'Song 3', about: 'the Iliad', brief: 'Troy', idea: 'idea 3' });
  expect(song.album).toMatchObject({ title: 'Spotted', artist: 'The Elegies', at: 2 });
  expect(song.album!.tracks.length).toBe(10);
  const sent = album.rendered.at(-1)!;
  expect(sent.track).toBe(2);
  expect(sent.params).toMatchObject({ tags: album.meta().plan!.tracks[2]!.tags, instrumental: false, lyrics: `[Verse]\ntake ${calls}\n\n[Chorus]\nships`, aim: { min: 180, max: 300 } });
  // Not landed yet: the plan still has the old take's words.
  expect(album.meta()).toMatchObject({ stage: 'making', remakeOnly: 'done' });
  expect(album.meta().plan!.tracks[2]!.lyrics).toBe(old);

  await album.maker.landed('g', 140, { at: 2, replacedS: 150 });
  album.flight.flying = 0;
  expect(album.meta().plan!.tracks[2]!.lyrics).toBe(`[Verse]\ntake ${calls}\n\n[Chorus]\nships`);
  expect(album.meta()).toMatchObject({ stage: 'done', remakeOnly: null, remakes: [], madeS: 1790, sent: 10 });
});

test("the same lyrics, new take: the old take's words as they stand on its song (corrected by hand), nothing written", async () => {
  const server = fakeServer();
  const album = fakeAlbum({ description: 'x', tags: [], minutes: 30, sung: true }, server);
  album.maker.start('h');
  await settle(album.maker, 'h');
  album.set({ stage: 'done', sent: 15, madeS: 1800, redo: [] });
  album.flight.flying = 0;
  const calls = server.sent.length;
  await album.maker.remake('h', 0, { fresh: false, song: 'old-take', keep: '[Chorus]\nfixed by hand' });
  expect(server.sent.length).toBe(calls);
  expect(album.rendered.at(-1)!.params.lyrics).toBe('[Chorus]\nfixed by hand');
});

test("new lyrics with no Claude (a phone): the server's model writes them, as in the album's own lyrics loop", async () => {
  const server = fakeServer();
  const album = fakeAlbum({ description: 'sad songs about bananas', tags: [], minutes: 30, sung: true }, server);
  album.maker.start('i');
  await settle(album.maker, 'i');
  album.set({ stage: 'done', sent: 15, madeS: 1800, redo: [] });
  album.flight.flying = 0;
  const calls = server.sent.length;
  await album.maker.remake('i', 4, { fresh: true, song: 'old-take', keep: null });
  expect(server.sent.slice(calls).map((call) => call.tag)).toEqual(['[lyrics]']);
  expect(server.sent.at(-1)!.user).toContain('Song: "Song 5"');
  expect(album.rendered.at(-1)!.params.lyrics).toBe('[Verse]\nla\n\n[Chorus]\nla');
});

test('a track is not made again while the album is being written', async () => {
  const server = fakeServer();
  const album = fakeAlbum({ description: 'x', tags: [], minutes: 30, sung: true }, server);
  album.maker.start('j');
  await expect(album.maker.remake('j', 0, { fresh: false, song: 's', keep: null })).rejects.toMatchObject({ code: 'album_writing' });
  await settle(album.maker, 'j');
});
