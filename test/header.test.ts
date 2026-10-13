import { expect, test } from 'bun:test';
import { settleSong, songJob, SEND_HEADER } from '../shared/core/jobs';
import { headerOf, HEADER_FROM, KEYS } from '../shared/header';
import { versionAtLeast } from '../shared/core/strip';

test('the key, meter and tempo the tags state, as Crucible 2.0.13 takes them (Victoria, 2026-10-13)', () => {
  expect(headerOf('bassoon, pizzicato strings, A minor, waltz, 64 BPM')).toEqual({ key: 'Am', meter: '3/4', bpm: 64 });
  expect(headerOf('F# minor, 6/8, 120 BPM')).toEqual({ key: 'F#m', meter: '6/8', bpm: 120 });
  expect(headerOf('Bb major, 3/4')).toEqual({ key: 'Bb', meter: '3/4' });
  expect(headerOf('key of E minor, 90bpm')).toEqual({ key: 'Em', bpm: 90 });
  expect(headerOf('C sharp minor')).toEqual({ key: 'C#m' });
  expect(headerOf('E flat major')).toEqual({ key: 'Eb' });
});

test('nothing the tags do not say outright, and nothing YuE2 cannot take', () => {
  expect(headerOf('folk, E, dorian mode, 30 BPM')).toEqual({});
  // Keys YuE2's scores never use (G# major, Fb) are left out rather than sent to be refused.
  expect(headerOf('G# major')).toEqual({});
  expect(headerOf('300 BPM, 17/4')).toEqual({});
  expect(KEYS).toHaveLength(30);
});

test('an instrumental on a server with the header fields sends them only once SEND_HEADER is on', () => {
  const params = settleSong({ tags: 'cello melody, A minor, waltz, 64 BPM, instrumental', instrumental: true, seed: 7 });
  const wire = songJob(params, 'mp3', 'k', undefined, false, false, true).params as Record<string, unknown>;
  if (SEND_HEADER) {
    expect(wire['key']).toBe('Am');
    expect(wire['meter']).toBe('3/4');
    expect(wire['bpm']).toBe(64);
  } else {
    expect(wire).not.toHaveProperty('key');
  }
  // Never without the server's fields.
  expect(songJob(params, 'mp3', 'k').params).not.toHaveProperty('key');
});

test('the header needs Crucible 2.0.14: 2.0.13 lists the fields but refuses them', () => {
  expect(versionAtLeast('2.0.13', HEADER_FROM)).toBe(false);
  expect(versionAtLeast('2.0.14', HEADER_FROM)).toBe(true);
  expect(versionAtLeast('2.1.0', HEADER_FROM)).toBe(true);
  expect(versionAtLeast('2.0.14.dev1', HEADER_FROM)).toBe(true);
});
