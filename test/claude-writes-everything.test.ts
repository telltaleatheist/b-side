import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { nodeDisk } from '../electron/node-disk';
import { Refusal } from '../shared/core/refusal';
import * as crucible from '../shared/core/crucible';
import { HubCore } from '../shared/core/hub-core';
import type { Lyricist } from '../shared/core/lyricist';
import * as textModel from '../shared/core/text-model';
import type { TextModel } from '../shared/core/text-model';
import type { AlbumMeta, HubPreferences, SongPage } from '../shared/types';

// Owen, 2026-11-06: "we should switch fully over to claude -p for now until i retrain the model".
// A computer with Claude Code writes the sound and the words through it, so nothing there loads a
// server text model; a phone, without it, is as it was. These drive the hub's real routes with a
// fake Claude and a fake Crucible; `claude -p` itself is only exercised on a real computer.

const THE_PAGE: Partial<SongPage> = {
  model: 'yue2-3b', name: 'YuE2', standing: 'ready', available: true, reason: null, instrumental: true,
  suggestions: [{ group: 'Genre', tags: ['folk'] }], conflicts: {}, tagModel: 'qwen3.5-4b', tagModelReason: null,
};
const page = THE_PAGE as SongPage;

const FIELDS = {
  language: 'English', genre: ['folk'], mood: ['warm'], vocal: ['soft female voice'], instruments: ['guitar'],
  sound: ['vintage sound'], bpm: 80, instrumental: false, lyrics: '[verse]\nla la',
};

/** What Claude answers each call with, by its task tag; every call is recorded. */
function fakeClaudeText(tags: string[]): TextModel {
  let written = 0;
  return {
    name: 'claude-sonnet-5-5',
    ask: async (request) => {
      tags.push(request.tag);
      const schema = request.schema as { properties?: Record<string, { minItems?: number }> };
      const answers: Record<string, unknown> = {
        '[concept]': { title: 'Spotted', artist: 'The Elegies', blurb: 'Ripening.' },
        '[ideas]': { tracks: Array.from({ length: schema.properties?.['tracks']?.minItems ?? 0 }, () => ({ title: `Song ${++written}`, idea: `idea ${written}` })) },
        '[core]': { core: ['indie folk', 'melancholic'] },
        '[turns]': { turns: Array.from({ length: schema.properties?.['turns']?.minItems ?? 0 }, () => ({ lead: 'soft female voice', more: ['80 BPM'] })) },
        '[cover]': { coverPrompt: 'a bowl of fruit at dusk' },
        '[song name]': { title: 'Named For Its Words' },
      };
      return { content: JSON.stringify(answers[request.tag] ?? FIELDS), truncated: false };
    },
  };
}

const LYRICS = '[verse]\nla la\n\n[chorus]\nla';

let root: string;
let cores: HubCore[];
let claudeTags: string[];
let lyricsWritten: number;
let checks: number;
let serverSessions: number;
let serverChats: number;
let serverText: ReturnType<typeof spyOn>;
let serverInstall: ReturnType<typeof spyOn>;
let logs: string[];

function claudeOption(): NonNullable<ConstructorParameters<typeof HubCore>[0]['claude']> {
  const lyricist: Lyricist = {
    name: 'claude-sonnet-5-5',
    write: async () => { lyricsWritten += 1; return LYRICS; },
    writeTitled: async () => { lyricsWritten += 1; return { lyrics: LYRICS, title: 'Named By Claude' }; },
  };
  return { text: fakeClaudeText(claudeTags), lyricist, check: async () => { checks += 1; } };
}

async function hub(kind: 'desktop' | 'phone', claude = kind === 'desktop' ? claudeOption() : undefined): Promise<HubCore> {
  let vault: string | null = null;
  const core = new HubCore({
    disk: nodeDisk,
    vault: { where: 'memory', read: async () => vault, write: async (text) => { vault = text; } },
    dataDir: path.join(root, 'data'),
    takeLimits: { perClient: { desktop: 10, web: 10, ios: 10 }, bytes: 1e9 },
    clientName: 'b-sides-test',
    fetchAudio: async () => 0,
    info: { app: 'b-side', version: '0.0.0', hostname: 'test' },
    sink: { send: () => undefined, broadcast: () => undefined, isClosed: () => false },
    ...(claude === undefined ? {} : { claude }),
  });
  await core.open(path.join(root, 'library'));
  await core.registry.add({ name: 'pc', url: 'http://127.0.0.1:9', token: null });
  cores.push(core);
  return core;
}

function call(core: HubCore, method: string, template: string, body: Record<string, unknown> = {}, params: Record<string, string> = {}): Promise<unknown> {
  const found = core.routes.find((each) => each.method === method && each.template === template);
  if (found === undefined) throw new Error(`no route ${method} ${template}`);
  return Promise.resolve(found.handler({ params, body: async () => body, client: () => ({ id: 'desktop', kind: 'desktop' }) } as never));
}

const preferences = (core: HubCore) => call(core, 'GET', '/api/preferences') as Promise<HubPreferences>;
const preferencesFile = () => path.join(root, 'data', 'preferences.json');
function store(stored: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(preferencesFile(), JSON.stringify(stored));
}
const movedLines = () => logs.filter((line) => line.includes('Writing moved to Claude Code'));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bside-claude-writes-'));
  cores = [];
  claudeTags = [];
  lyricsWritten = 0;
  checks = 0;
  serverSessions = 0;
  serverChats = 0;
  logs = [];
  spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
  spyOn(crucible, 'songPage').mockImplementation(async () => page);
  // Anything that would load or ask the server's text model is counted, and answers like Claude would.
  serverInstall = spyOn(crucible, 'startInstall').mockImplementation(async () => null);
  serverText = spyOn(textModel, 'crucibleText').mockImplementation(() => fakeClaudeText([]));
  spyOn(crucible, 'installModel').mockImplementation(async () => undefined as never);
  spyOn(crucible, 'clientFor').mockImplementation(() => ({
    session: async () => { serverSessions += 1; throw new Error('the album opened a session on the server'); },
    chat: async () => { serverChats += 1; throw new Error('the server was asked to write'); },
  }) as never);
});

afterEach(async () => {
  mock.restore();
  fs.rmSync(root, { recursive: true, force: true });
});

function expectServerUntouched(): void {
  expect(serverText).toHaveBeenCalledTimes(0);
  expect(serverInstall).toHaveBeenCalledTimes(0);
  expect(serverSessions).toBe(0);
  expect(serverChats).toBe(0);
}

test('a fresh desktop: Claude writes the sound and the words', async () => {
  const prefs = await preferences(await hub('desktop'));
  expect([prefs.writer, prefs.lyricist]).toEqual(['claude', 'claude']);
  expect(movedLines()).toEqual([]);
});

test('a desktop with the old choice saved moves to Claude once, with one log line, and the file says so', async () => {
  store({ songFormat: 'flac', albumSpaceGb: 4, writer: 'bside', lyricist: 'claude', textSplit: 2 });
  const prefs = await preferences(await hub('desktop'));
  expect([prefs.writer, prefs.lyricist]).toEqual(['claude', 'claude']);
  // The rest of what they chose stands.
  expect([prefs.songFormat, prefs.albumSpaceGb]).toEqual(['flac', 4]);
  expect(movedLines().length).toBe(1);
  expect(movedLines()[0]).toContain('from bside/claude');
  const saved = JSON.parse(fs.readFileSync(preferencesFile(), 'utf8')) as HubPreferences;
  expect([saved.writer, saved.lyricist, saved.textSplit]).toEqual(['claude', 'claude', 3]);

  await hub('desktop');
  expect(movedLines().length).toBe(1);
});

test('a saved lyricist on the server moves too, so nothing there loads a text model', async () => {
  store({ writer: 'bside', lyricist: 'bside', textSplit: 2 });
  const prefs = await preferences(await hub('desktop'));
  expect([prefs.writer, prefs.lyricist]).toEqual(['claude', 'claude']);
  expect(movedLines()[0]).toContain('from bside/bside');
});

test('someone who picks the server\'s model again afterwards keeps it: the move is once', async () => {
  store({ writer: 'bside', lyricist: 'claude', textSplit: 2 });
  const core = await hub('desktop');
  await call(core, 'PUT', '/api/preferences', { writer: 'bside' });
  const again = await preferences(await hub('desktop'));
  expect(again.writer).toBe('bside');
  expect(movedLines().length).toBe(1);
});

test('a desktop already on Claude has nothing to move, and says nothing', async () => {
  store({ writer: 'claude', lyricist: 'claude', textSplit: 2 });
  const before = fs.readFileSync(preferencesFile(), 'utf8');
  await hub('desktop');
  expect(movedLines()).toEqual([]);
  expect(fs.readFileSync(preferencesFile(), 'utf8')).toBe(before);
});

test('the phone is as it was: the server\'s model writes, saved choices stand, and nothing moves', async () => {
  const fresh = await preferences(await hub('phone'));
  expect([fresh.writer, fresh.lyricist]).toEqual(['bside', 'bside']);

  store({ writer: 'bside', lyricist: 'bside', textSplit: 2 });
  const before = fs.readFileSync(preferencesFile(), 'utf8');
  const core = await hub('phone');
  const stored = await preferences(core);
  expect([stored.writer, stored.lyricist]).toEqual(['bside', 'bside']);
  expect(movedLines()).toEqual([]);
  expect(fs.readFileSync(preferencesFile(), 'utf8')).toBe(before);

  // And describing there still goes to the server's model.
  await call(core, 'POST', '/api/describe', { text: 'a warm folk song' });
  expect(serverText).toHaveBeenCalledTimes(1);
  expect(claudeTags).toEqual([]);
});

test('a phone cannot be switched to Claude: refused by name', async () => {
  await expect(call(await hub('phone'), 'PUT', '/api/preferences', { writer: 'claude' })).rejects.toThrow('Claude writes only on a B-Sides computer');
});

test('a describe on a desktop never calls the server\'s text model', async () => {
  const answer = await call(await hub('desktop'), 'POST', '/api/describe', { text: 'a warm folk song' }) as { lyricsModel?: string; model?: string };
  expect(claudeTags).toEqual(['[sound]']);
  expect(lyricsWritten).toBe(1);
  expect(answer.lyricsModel).toBe('claude-sonnet-5-5');
  expectServerUntouched();
});

test('an album plan on a desktop never calls the server\'s text model', async () => {
  const core = await hub('desktop');
  const made = await call(core, 'POST', '/api/albums', { description: 'sad songs about bananas', tags: [], minutes: 30, sung: true }) as { id: string };
  const library = (core as unknown as { library: { album(id: string): Promise<AlbumMeta | null> } }).library;
  let album: AlbumMeta | null = null;
  for (let i = 0; i < 400; i += 1) {
    album = await library.album(made.id);
    if (album?.plan != null && album.plan.tracks.length === album.plan.trackCount && album.plan.coverPrompt !== '') break;
    if (album?.refusal != null) break;
    await new Promise((rest) => setTimeout(rest, 5));
  }
  expect(album?.refusal ?? null).toBeNull();
  expect(album?.plan?.tracks.length).toBeGreaterThan(0);
  expect(album?.writer).toBe('claude-sonnet-5-5');
  expect(claudeTags).toContain('[concept]');
  expect(claudeTags).toContain('[core]');
  expectServerUntouched();
});

test('Claude Code missing or signed out refuses by name, and never falls back to the server', async () => {
  for (const [code, words] of [['claude_missing', 'is not installed'], ['claude_signed_out', 'is signed out']] as const) {
    const refusing: TextModel = { name: 'claude-sonnet-5-5', ask: async () => { throw new Refusal(code, `Claude Code ${words}.`); } };
    const lyricist: Lyricist = { name: 'claude-sonnet-5-5', write: async () => LYRICS };
    fs.rmSync(path.join(root, 'data'), { recursive: true, force: true });
    const core = await hub('desktop', { text: refusing, lyricist, check: async () => undefined });
    await expect(call(core, 'POST', '/api/describe', { text: 'a warm folk song' })).rejects.toThrow(words);
    expectServerUntouched();
  }
});
