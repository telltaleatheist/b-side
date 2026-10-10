import { expect, test } from 'bun:test';

import { AlbumMaker, type AlbumHooks } from '../shared/core/albums';
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
    if (tag === '[album]') {
      return { finishReason: 'stop', content: JSON.stringify({ title: 'Spotted', artist: 'The Elegies', blurb: 'Ripening.', coverPrompt: 'a banana', core: 'indie folk, melancholic' }) };
    }
    if (tag === '[tracks]') {
      const n = options.responseFormat.json_schema.schema.properties.tracks.minItems as number;
      const tracks = Array.from({ length: n }, () => ({ title: `Song ${++tracksWritten}`, turn: 'soft female voice, 80 BPM' }));
      return { finishReason: 'stop', content: JSON.stringify({ tracks }) };
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

function fakeAlbum(ask: AlbumAsk, server: ReturnType<typeof fakeServer>, claude: { text: TextModel; lyricist: Lyricist } | null = null) {
  let stored: AlbumMeta = {
    artist: '', blurb: '', cover: null, ask, plan: null, stage: 'planning', sent: 0, madeS: 0,
    refusal: null, server: 'pc', writer: null,
  };
  const names: string[] = [];
  const renamed: Array<[string, string]> = [];
  const hooks: AlbumHooks = {
    meta: async () => stored,
    update: async (_id, next, name) => { stored = next; if (name) names.push(name); },
    server: () => ({ name: 'pc', url: 'http://pc:7100', token: 't' }) as never,
    client: () => server.client as never,
    page: async () => page,
    paint: async () => 'c.png',
    removeCover: async () => undefined,
    render: () => undefined,
    inFlight: () => 0,
    retitle: async () => undefined,
    cancelInFlight: async () => undefined,
    made: async () => [],
    flyingTracks: () => [],
    renameSong: async (_id, from, to) => { renamed.push([from, to]); },
    claude: () => claude,
  };
  return { maker: new AlbumMaker(hooks), meta: () => stored, names, renamed, set: (change: Partial<AlbumMeta>) => { stored = { ...stored, ...change }; } };
}

async function settle(maker: AlbumMaker, id: string): Promise<void> {
  for (let i = 0; i < 200 && maker.writing(id); i += 1) await new Promise((rest) => setTimeout(rest, 2));
}

test('a 90-minute sung album: [album], then [tracks] three times fifteen, then [lyrics] per track, all on the tag model', async () => {
  const server = fakeServer();
  const album = fakeAlbum({ description: 'sad songs about bananas', tags: [], minutes: 90, sung: true, lyrics: 'a banana going brown' }, server);
  album.maker.start('a');
  await settle(album.maker, 'a');
  const tags = server.sent.map((call) => call.tag);
  expect(tags.slice(0, 4)).toEqual(['[album]', '[tracks]', '[tracks]', '[tracks]']);
  expect(tags.slice(4).every((tag) => tag === '[lyrics]')).toBe(true);
  expect(tags.length).toBe(4 + 45);
  expect(server.sent.every((call) => call.model === MODEL)).toBe(true);
  // Each later batch is told every title so far, numbered.
  const second = server.sent[2]!;
  expect(second.system).toContain('Write tracks 16-30 of 45, in order.');
  expect(second.user).toContain('Already on the album: 1. "Song 1"; 2. "Song 2"');
  expect(second.user).toContain('15. "Song 15"');
  expect(second.user).not.toContain('16. "');
  expect(server.sent[1]!.user).not.toContain('Already on the album');
  // [lyrics] carries the track's full tags (core + turn) and the brief.
  expect(server.sent[4]!.user).toBe('[lyrics]\nAlbum: "Spotted" by The Elegies. Ripening.\nAbout: sad songs about bananas\nThe lyrics: a banana going brown\nSong: "Song 1" (indie folk, melancholic, soft female voice, 80 BPM)');
  const meta = album.meta();
  expect(meta.plan!.tracks.length).toBe(45);
  expect(meta.plan!.trackCount).toBe(45);
  expect(meta.plan!.tracks.every((track) => track.lyrics === '[verse]\nla\n\n[chorus]\nla')).toBe(true);
  expect(meta.writer).toBe(MODEL);
  expect(meta.stage).toBe('making');
  expect(album.names).toContain('Spotted');
});

test('an instrumental album writes no lyrics', async () => {
  const server = fakeServer();
  const album = fakeAlbum({ description: '', tags: [], minutes: 30, sung: false }, server);
  album.maker.start('b');
  await settle(album.maker, 'b');
  expect(server.sent.map((call) => call.tag)).toEqual(['[album]', '[tracks]']);
  expect(server.sent[0]!.user).toBe('[album]\nSurprise me.');
  expect(album.meta().plan!.tracks.every((track) => track.lyrics === null && track.tags.endsWith('instrumental'))).toBe(true);
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
  // No new [album] or [tracks]: the concept and the list were kept; only the 13 missing lyrics.
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

test('with Claude writing, every text call is Claude\'s and the server is never asked to write or hold anything', async () => {
  const server = fakeServer();
  let sessions = 0;
  (server.client as { session: () => Promise<unknown> }).session = async () => { sessions += 1; return {}; };
  const texts: string[] = [];
  const asked: SongToWrite[] = [];
  // Claude answers the same calls B-Sides' model does: replay the fake server's own answers.
  const text: TextModel = {
    name: 'claude-sonnet-5-5',
    ask: async (request) => {
      texts.push(request.tag);
      const answer = await (server.client as unknown as { chat: (o: unknown) => Promise<{ content: string }> }).chat({
        model: 'x', responseFormat: { json_schema: { schema: request.schema } }, messages: [{ content: request.system }, { content: `${request.tag}\n${request.user}` }],
      });
      return { content: answer.content, truncated: false };
    },
  };
  const lyricist: Lyricist = { name: 'claude-sonnet-5-5', write: async (song) => { asked.push(song); return '[intro]\noh\n[verse]\nla la\n[pre-chorus]\nhey\n[chorus]\nyeah'; } };
  const album = fakeAlbum({ description: 'sad songs about bananas', tags: [], minutes: 30, sung: true, lyrics: 'a banana going brown' }, server, { text, lyricist });
  album.maker.start('f');
  await settle(album.maker, 'f');
  expect(texts).toEqual(['[album]', '[tracks]']);
  expect(sessions).toBe(0);
  expect(asked.length).toBe(15);
  expect(asked[2]!.album!.at).toBe(2);
  expect(asked[2]!.album!.tracks.length).toBe(15);
  expect(asked[0]!.brief).toBe('a banana going brown');
  expect(asked[0]!.tags).toBe('indie folk, melancholic, soft female voice, 80 BPM');
  // Laid out for YuE: every section on its own line, a blank line before each after the first.
  expect(album.meta().plan!.tracks[0]!.lyrics).toBe('[intro]\noh\n\n[verse]\nla la\n\n[pre-chorus]\nhey\n\n[chorus]\nyeah');
  expect(album.meta().writer).toBe('claude-sonnet-5-5');
  expect(album.meta().lyricsBy).toBe('claude-sonnet-5-5');
  expect(album.meta().stage).toBe('making');
});
