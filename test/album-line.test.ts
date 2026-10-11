import { expect, test } from 'bun:test';

import { AlbumMaker, albumLine, type AlbumHooks } from '../shared/core/albums';
import type { AlbumMeta, AlbumOrder, SinglesOrder } from '../shared/types';

/**
 * Several albums making their music on one server (Victoria, 2026-10-11: "In some cases, it's
 * nice to complete an entire album before moving on to the next. In other cases, I want to flip
 * back and forth between albums or back and forth between generating an album and an individual
 * song"). The fake server renders in the order tracks are sent, as Crucible's queue does.
 */
function fakeServer(ids: string[], albums: AlbumOrder = 'one', singles: SinglesOrder = 'turn', titles = ['One', 'Two', 'Three', 'Four']) {
  const tracks = titles.map((title) => ({ title, tags: 'folk', lyrics: null }));
  const stored = new Map<string, AlbumMeta & { createdAt: string }>();
  ids.forEach((id, at) => stored.set(id, {
    artist: 'A', blurb: '', cover: 'c.png', ask: { description: '', tags: [], minutes: 10, sung: false },
    plan: { title: id, artist: 'A', blurb: '', coverPrompt: '', tracks }, stage: 'making', sent: 0, madeS: 0,
    refusal: null, server: 'pc', writer: 'w', createdAt: `2026-10-11T00:00:0${at}.000Z`,
  }));
  /** On the server now, oldest first: "<album><track>". */
  const queue: string[] = [];
  /** Every track sent, in order. */
  const sent: string[] = [];
  const state = { albums, singles, waiting: 0 };
  const hooks: AlbumHooks = {
    meta: async (id) => stored.get(id) ?? null,
    update: async (id, next) => { stored.set(id, { ...(stored.get(id) as AlbumMeta & { createdAt: string }), ...next }); },
    server: () => ({ name: 'pc', url: 'http://pc:7100', token: 't' }) as never,
    client: () => { throw new Error('no server in this test'); },
    page: async () => null,
    paint: async () => 'c.png',
    removeCover: async () => undefined,
    render: (id, track) => { queue.push(`${id}${track}`); sent.push(`${id}${track}`); },
    inFlight: (id) => queue.filter((job) => job.startsWith(id)).length,
    retitle: async () => undefined,
    cancelInFlight: async () => undefined,
    made: async () => [],
    flyingTracks: (id) => queue.filter((job) => job.startsWith(id)).map((job) => Number(job.slice(-1))),
    renameSong: async () => undefined,
    makingOn: async () => albumLine(
      [...stored.entries()].filter(([, meta]) => meta.stage === 'making').map(([id, meta]) => ({ id, createdAt: meta.createdAt, album: meta })),
      state.albums,
    ).map((album) => album.id),
    order: () => ({ albums: state.albums, singles: state.singles }),
    singlesWaiting: () => state.waiting,
    claude: () => null,
  };
  const maker = new AlbumMaker(hooks);
  /** The track at the front of the server's queue lands: still listed while it is filed, as in the hub. */
  const land = async (seconds = 150): Promise<string> => {
    const job = queue[0] as string;
    const id = job.slice(0, -1);
    const at = Number(job.slice(-1));
    // A remake lands in its old take's place (the hub's fileAlbumTrack): the old one was 150 s.
    const remade = stored.get(id)?.remakes?.some((each) => each.at === at) === true ? { at, replacedS: 150 } : undefined;
    await maker.landed(id, seconds, remade);
    queue.shift();
    return job;
  };
  /** Land everything, sending more as each lands, until the server has nothing left. */
  const drain = async (): Promise<void> => {
    for (let i = 0; i < 40 && queue.length > 0; i += 1) await land();
  };
  const set = (id: string, change: Partial<AlbumMeta>): void => { stored.set(id, { ...(stored.get(id) as AlbumMeta & { createdAt: string }), ...change }); };
  return { maker, queue, sent, state, land, drain, set, meta: (id: string) => stored.get(id) as AlbumMeta };
}

test('one album at a time: the first album keeps two tracks on the server and finishes before the next begins', async () => {
  const server = fakeServer(['a', 'b']);
  await server.maker.next('pc');
  expect(server.queue).toEqual(['a0', 'a1']);
  await server.drain();
  expect(server.sent).toEqual(['a0', 'a1', 'a2', 'a3', 'b0', 'b1', 'b2', 'b3']);
  expect(server.meta('a').stage).toBe('done');
  expect(server.meta('b').stage).toBe('done');
});

test('take turns: the albums send a track each in turn, and never more than two at once between them', async () => {
  const server = fakeServer(['a', 'b'], 'turns');
  await server.maker.next('pc');
  expect(server.queue).toEqual(['a0', 'b0']);
  await server.drain();
  expect(server.sent).toEqual(['a0', 'b0', 'a1', 'b1', 'a2', 'b2', 'a3', 'b3']);
  expect(server.meta('a').stage).toBe('done');
  expect(server.meta('b').stage).toBe('done');
});

test('take turns: a track landing for one album gives the turn to whichever album is due, not back to itself', async () => {
  const server = fakeServer(['a', 'b', 'c'], 'turns');
  await server.maker.next('pc');
  expect(server.queue).toEqual(['a0', 'b0']);
  // a0 lands: c has never sent, so the room is c's.
  await server.land();
  expect(server.queue).toEqual(['b0', 'c0']);
  await server.land();
  expect(server.queue).toEqual(['c0', 'a1']);
});

test('take turns: a failed track frees the room for the album whose turn it is', async () => {
  const server = fakeServer(['a', 'b', 'c'], 'turns');
  await server.maker.next('pc');
  // b0 fails on the server: its job has ended, so it is no longer listed.
  server.queue.splice(server.queue.indexOf('b0'), 1);
  await server.maker.failed('b', null);
  expect(server.queue).toEqual(['a0', 'c0']);
});

test('make this next, one at a time: the album ahead sends no more, its tracks on the server finish first', async () => {
  const server = fakeServer(['a', 'b']);
  await server.maker.next('pc');
  await server.maker.makeNext('b');
  // Two of a's tracks are already on the server: b waits for room, not for a to finish.
  expect(server.queue).toEqual(['a0', 'a1']);
  await server.land();
  expect(server.queue).toEqual(['a1', 'b0']);
  await server.drain();
  expect(server.sent).toEqual(['a0', 'a1', 'b0', 'b1', 'b2', 'b3', 'a2', 'a3']);
  expect(server.meta('a').stage).toBe('done');
});

test('make this next, taking turns: the chosen album has the very next turn, then turns go on as before', async () => {
  const server = fakeServer(['a', 'b', 'c'], 'turns');
  await server.maker.next('pc');
  expect(server.queue).toEqual(['a0', 'b0']);
  // c is due next; b is chosen instead.
  await server.maker.makeNext('b');
  await server.land();
  expect(server.queue).toEqual(['b0', 'b1']);
  await server.land();
  expect(server.queue).toEqual(['b1', 'c0']);
});

test('single songs go next: albums keep one track on the server, and send none while a single waits', async () => {
  const server = fakeServer(['a'], 'one', 'next');
  await server.maker.next('pc');
  expect(server.queue).toEqual(['a0']);
  // A single is sent: a0 is rendering, and nothing more of the album goes in ahead of it.
  server.state.waiting = 1;
  await server.land();
  expect(server.queue).toEqual([]);
  expect(server.meta('a').stage).toBe('making');
  // The single is made: the album carries on.
  server.state.waiting = 0;
  await server.maker.next('pc');
  expect(server.queue).toEqual(['a1']);
});

test('single songs take their turn: albums keep two tracks on the server whether or not a single waits', async () => {
  const server = fakeServer(['a']);
  server.state.waiting = 1;
  await server.maker.next('pc');
  expect(server.queue).toEqual(['a0', 'a1']);
});

test('two fills at once never send the same track twice', async () => {
  const server = fakeServer(['a']);
  await Promise.all([server.maker.next('pc'), server.maker.next('pc'), server.maker.next('pc')]);
  expect(server.sent).toEqual(['a0', 'a1']);
});

// ── Make this track again (Victoria, 2026-10-11) ──────────────────────────────

const keep = { fresh: false, song: 'old-take', keep: null };

test('a finished album makes only the track asked for again, then is done again: no unmade track past its length', async () => {
  // Six planned, four fill the ten minutes: Five and Six were never meant to be made.
  const server = fakeServer(['a'], 'one', 'turn', ['One', 'Two', 'Three', 'Four', 'Five', 'Six']);
  await server.maker.next('pc');
  await server.drain();
  expect(server.meta('a').stage).toBe('done');
  expect(server.meta('a').sent).toBe(4);
  await server.maker.remake('a', 1, keep);
  expect(server.meta('a')).toMatchObject({ stage: 'making', remakeOnly: 'done', redo: [] });
  expect(server.queue).toEqual(['a1']);
  // The new take is 50 s shorter than the old one: the album is now short of its length, and
  // still makes nothing else.
  await server.land(100);
  expect(server.queue).toEqual([]);
  expect(server.sent.slice(4)).toEqual(['a1']);
  expect(server.meta('a')).toMatchObject({ stage: 'done', remakeOnly: null, remakes: [], sent: 4, madeS: 550 });
});

test('a stopped album makes its remake and stays stopped; its lost tracks are not made with it', async () => {
  const server = fakeServer(['a']);
  await server.maker.next('pc');
  await server.land();
  await server.maker.stop('a');
  server.queue.length = 0;
  server.set('a', { redo: [1] });
  await server.maker.remake('a', 0, keep);
  expect(server.queue).toEqual(['a0']);
  await server.land();
  expect(server.meta('a')).toMatchObject({ stage: 'stopped', remakeOnly: null, redo: [1] });
});

test('a remake waits its turn behind an older album still being made', async () => {
  const server = fakeServer(['a', 'b']);
  server.set('b', { stage: 'done', sent: 4, madeS: 600 });
  await server.maker.next('pc');
  await server.maker.remake('b', 2, keep);
  expect(server.queue).toEqual(['a0', 'a1']);
  await server.drain();
  expect(server.sent).toEqual(['a0', 'a1', 'a2', 'a3', 'b2']);
  expect(server.meta('a').stage).toBe('done');
  expect(server.meta('b')).toMatchObject({ stage: 'done', remakeOnly: null, madeS: 600 });
});

test('in an album still being made, a remake goes before its next new track', async () => {
  const server = fakeServer(['a']);
  await server.maker.next('pc');
  await server.land();
  expect(server.queue).toEqual(['a1', 'a2']);
  await server.maker.remake('a', 0, keep);
  await server.land();
  expect(server.queue).toEqual(['a2', 'a0']);
  await server.drain();
  expect(server.sent).toEqual(['a0', 'a1', 'a2', 'a0', 'a3']);
  expect(server.meta('a')).toMatchObject({ stage: 'done', madeS: 600, remakes: [] });
});

test('a remake that fails leaves the album as it was, and says so', async () => {
  const server = fakeServer(['a']);
  await server.maker.next('pc');
  await server.drain();
  const before = server.meta('a');
  await server.maker.remake('a', 1, keep);
  // The new take fails on the server: its job has ended, so it is no longer listed.
  server.queue.length = 0;
  await server.maker.failed('a', { code: 'worker_failed', message: 'It ran out of memory.' }, 1);
  const after = server.meta('a');
  expect(after).toMatchObject({ stage: 'done', remakeOnly: null, remakes: [], redo: [], madeS: before.madeS, sent: before.sent, refusal: null });
  expect(after.remakeRefusal?.message).toBe('The new take of "Two" did not work, so the old one stays. It ran out of memory.');
  expect(after.plan).toEqual(before.plan);
  // Asked for again, the note goes.
  await server.maker.remake('a', 1, keep);
  expect(server.meta('a').remakeRefusal).toBeNull();
});

test('a remake refuses by name: a track already being made again, being made, not made, or with no take', async () => {
  const server = fakeServer(['a']);
  await server.maker.next('pc');
  await server.land();
  // a1 and a2 are on the server; a3 is not sent yet.
  await expect(server.maker.remake('a', 1, keep)).rejects.toMatchObject({ code: 'track_making' });
  await expect(server.maker.remake('a', 3, keep)).rejects.toMatchObject({ code: 'track_missing' });
  await expect(server.maker.remake('a', 0, { ...keep, song: null })).rejects.toMatchObject({ code: 'track_unmade' });
  await expect(server.maker.remake('a', 0, { ...keep, fresh: true })).rejects.toMatchObject({ code: 'track_instrumental' });
  await server.maker.remake('a', 0, keep);
  await expect(server.maker.remake('a', 0, keep)).rejects.toMatchObject({ code: 'track_remaking' });
});

test('stopping an album making only its remake drops the remake and leaves it done', async () => {
  const server = fakeServer(['a']);
  await server.maker.next('pc');
  await server.drain();
  await server.maker.remake('a', 3, keep);
  await server.maker.stop('a');
  expect(server.meta('a')).toMatchObject({ stage: 'done', remakeOnly: null, remakes: [], redo: [] });
});

test('the line: one at a time is oldest first, Make this next first; taking turns, the one sent from longest ago', () => {
  const album = (id: string, createdAt: string, lastSentAt: string | null = null, nextAt: string | null = null) => ({ id, createdAt, album: { lastSentAt, nextAt } });
  const old = album('old', '2026-10-01T00:00:00.000Z', '2026-10-11T00:00:05.000Z');
  const mid = album('mid', '2026-10-02T00:00:00.000Z', '2026-10-11T00:00:03.000Z');
  const fresh = album('new', '2026-10-03T00:00:00.000Z');
  expect(albumLine([fresh, mid, old], 'one').map((a) => a.id)).toEqual(['old', 'mid', 'new']);
  expect(albumLine([old, mid, fresh], 'turns').map((a) => a.id)).toEqual(['new', 'mid', 'old']);
  // Chosen to go next: first in either order, until (taking turns) it has had that turn.
  const chosen = { ...old, album: { ...old.album, nextAt: '2026-10-11T00:00:06.000Z' } };
  expect(albumLine([fresh, mid, chosen], 'one')[0]!.id).toBe('old');
  expect(albumLine([fresh, mid, chosen], 'turns')[0]!.id).toBe('old');
  const served = { ...chosen, album: { ...chosen.album, lastSentAt: '2026-10-11T00:00:07.000Z' } };
  expect(albumLine([fresh, mid, served], 'turns').map((a) => a.id)).toEqual(['new', 'mid', 'old']);
});
