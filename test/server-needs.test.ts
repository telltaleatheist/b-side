import { expect, test } from 'bun:test';
import { CrucibleRefused, type CatalogRow, type CrucibleClient } from '@crucible/client';

import { missingOf, moduleForBackend, ServerNeeds } from '../shared/core/server-needs';
import type { ServerNeedsView } from '../shared/types';

const row = (installed: boolean): CatalogRow => ({ kind: 'denoise', id: 'vocals-roformer', installed } as unknown as CatalogRow);

test('the module asks for the rvc environment and the vocals separator, without its generated backends', () => {
  const module = moduleForBackend('cuda-linux');
  expect(module.job_types).toEqual([{ type: 'rvc' }]);
  expect(module.subjects).toEqual([{ kind: 'denoise', id: 'vocals-roformer' }]);
  expect(module.name).toBe('b-sides');
  expect(JSON.stringify(module)).not.toContain('backends');
});

test('a Windows-native engine is asked for nothing: it has no separator', () => {
  const module = moduleForBackend('llama-windows');
  expect(module.job_types).toEqual([]);
  expect(module.subjects).toEqual([]);
});

test('missing: the model by the catalog, the environment by the job types served', () => {
  const module = moduleForBackend('mlx-darwin');
  expect(missingOf(module, [row(true)], ['denoise'])).toEqual([]);
  expect(missingOf(module, [row(false)], ['denoise'])).toEqual(['denoise vocals-roformer']);
  expect(missingOf(module, [row(true)], ['audio'])).toEqual(['the rvc environment']);
});

function fakeClient(over: Partial<Record<'catalog' | 'submitTask' | 'task', unknown>>, backend = 'cuda-linux', jobTypes = ['audio']): { client: CrucibleClient; posted: unknown[] } {
  const posted: unknown[] = [];
  const client = {
    info: async () => ({ host: { backend }, jobTypes }),
    catalog: async () => (over.catalog as CatalogRow[] | undefined) ?? [row(false)],
    submitTask: async (request: unknown) => {
      posted.push(request);
      if (over.submitTask instanceof Error) throw over.submitTask;
      return 'task-1';
    },
    task: async () => over.task ?? { state: 'done', error: null },
  } as unknown as CrucibleClient;
  return { client, posted };
}

test('a server missing the separator is posted the module and followed to done, once per run', async () => {
  const seen: ServerNeedsView[] = [];
  const needs = new ServerNeeds((view) => seen.push(view), 1);
  const { client, posted } = fakeClient({});
  await needs.ensure('pc', client);
  await needs.ensure('pc', client);
  expect(posted).toHaveLength(1);
  expect((posted[0] as { type: string }).type).toBe('module');
  expect(seen.map((view) => view.state)).toEqual(['checking', 'installing', 'ready']);
  expect(needs.of('pc')?.task).toBe('task-1');
});

test('a server that has it is not posted anything', async () => {
  const needs = new ServerNeeds(undefined, 1);
  const { client, posted } = fakeClient({ catalog: [row(true)] }, 'cuda-linux', ['audio', 'denoise']);
  await needs.ensure('pc', client);
  expect(posted).toHaveLength(0);
  expect(needs.of('pc')?.state).toBe('ready');
});

test('a busy server (409) and a failed task are said, never thrown', async () => {
  const busy = new ServerNeeds(undefined, 1);
  await busy.ensure('pc', fakeClient({ submitTask: new CrucibleRefused(409, 'task_busy', 'a task runs', null) }).client);
  expect(busy.of('pc')?.state).toBe('failed');
  expect(busy.of('pc')?.sentence).toContain('busy');
  const failed = new ServerNeeds(undefined, 1);
  await failed.ensure('pc', fakeClient({ task: { state: 'failed', error: { code: 'x', message: 'no disk' } } }).client);
  expect(failed.of('pc')?.sentence).toContain('no disk');
});

test('a held card (server_busy) is waited out: the module is posted again until taken (Victoria, 2026-10-11)', async () => {
  let tries = 0;
  const client = {
    info: async () => ({ host: { backend: 'cuda-linux' }, jobTypes: ['audio'] }),
    catalog: async () => [row(false)],
    submitTask: async () => {
      tries += 1;
      if (tries < 3) throw new CrucibleRefused(409, 'server_busy', 'this server cannot install anything right now', null);
      return 'task-1';
    },
    task: async () => ({ state: 'done', error: null }),
  } as unknown as CrucibleClient;
  const needs = new ServerNeeds(undefined, 1, 1);
  await needs.ensure('pc', client, async () => undefined);
  expect(tries).toBe(3);
  expect(needs.of('pc')?.state).toBe('ready');
});
