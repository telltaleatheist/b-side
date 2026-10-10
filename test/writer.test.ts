import { expect, test } from 'bun:test';
import { CrucibleRefused, type CrucibleClient } from '@crucible/client';

import { chooseWriter, installWriter } from '../shared/core/albums';

/** A stand-in client: only what chooseWriter and installWriter call. */
function fake(parts: Record<string, unknown>): CrucibleClient {
  return parts as unknown as CrucibleClient;
}

const record = (row: Record<string, unknown> | null) => ({ classes: row === null ? [] : [{ capability: 'generate', route: 'local', ...row }] });

test("the writer is Crucible's own pick for generate", async () => {
  let asked: unknown;
  const client = fake({ capability: async (_o: unknown, sizing: unknown) => { asked = sizing; return record({ enabled: true, selected: 'qwen3.5-0.8b', reason: 'fits' }); } });
  expect(await chooseWriter(client)).toBe('qwen3.5-0.8b');
  expect(asked).toEqual({ class: 'generate' });
});

test('a server with no writer says why, in its words', async () => {
  const client = fake({ capability: async () => record({ enabled: false, selected: '', reason: 'no model fits a 2 GiB card' }) });
  await expect(chooseWriter(client)).rejects.toThrow('no model fits a 2 GiB card');
});

test('an installed writer needs nothing', async () => {
  let loads = 0;
  const client = fake({ models: async () => [{ id: 'w', installed: true }], loadModel: async () => { loads += 1; return 'j'; } });
  await installWriter(client, 'w', async () => undefined);
  expect(loads).toBe(0);
});

test('a missing writer is installed through install-on-submit, its task followed to the end', async () => {
  const states = ['running', 'running', 'done'];
  const said: string[] = [];
  const client = fake({
    models: async () => [{ id: 'w', installed: false }],
    loadModel: async () => { throw new CrucibleRefused(409, 'installing', 'installing w', { task_id: 't1', reason: 'installing', message: 'pulling w', progress: null }); },
    task: async () => ({ state: states.shift(), message: 'pulling w 40%', error: null }),
  });
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => realTimeout(fn, 0)) as typeof setTimeout;
  try {
    await installWriter(client, 'w', async (detail) => { said.push(detail); });
  } finally {
    globalThis.setTimeout = realTimeout;
  }
  expect(said).toEqual(['pulling w 40%', 'pulling w 40%']);
  expect(states).toEqual([]);
});

test('a failed install is a refusal with the server\'s reason', async () => {
  const client = fake({
    models: async () => [{ id: 'w', installed: false }],
    loadModel: async () => { throw new CrucibleRefused(409, 'installing', 'x', { task_id: 't1', reason: 'installing', message: 'm', progress: null }); },
    task: async () => ({ state: 'failed', message: null, error: { code: 'pull_failed', message: 'disk full' } }),
  });
  await expect(installWriter(client, 'w', async () => undefined)).rejects.toThrow('disk full');
});

test('a cover is painted only by an image model the server has ready', async () => {
  const { chooseCoverModel } = await import('../shared/core/albums');
  const pages = (standing: string) => fake({ playground: async () => [{ jobType: 'audio', standing: 'ready', id: 'yue2-3b' }, { jobType: 'image', standing, id: 'img' }] });
  expect(await chooseCoverModel(pages('ready'))).toBe('img');
  // Installable but not installed: no multi-GB download for a cover; the standard cover stands.
  expect(await chooseCoverModel(pages('download'))).toBeNull();
  expect(await chooseCoverModel(pages('unavailable'))).toBeNull();
  expect(await chooseCoverModel(fake({ playground: async () => [{ jobType: 'audio', standing: 'ready', id: 'yue2-3b' }] }))).toBeNull();
});
