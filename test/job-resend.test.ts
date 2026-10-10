import { expect, test } from 'bun:test';
import { CrucibleUnreachable, type CrucibleClient } from '@crucible/client';

import type { Disk } from '../shared/core/disk';
import { JobRunner } from '../shared/core/jobs';
import type { JobView } from '../shared/types';

const disk: Disk = {
  mkdir: async () => undefined, list: async () => null, readText: async () => null, writeText: async () => undefined,
  exists: async () => false, move: async () => undefined, copy: async () => undefined, remove: async () => undefined,
};

/**
 * A server that goes down with every song it is given: each job's stream drops, and asked
 * afterwards the job reads as `status` (interrupted by the restart, or removed from the line).
 */
function crashingServer(status: Record<string, unknown>) {
  let submitted = 0;
  const client = {
    submit: async () => `j${++submitted}`,
    events: async function* () { throw new CrucibleUnreachable('http://pc:7100', 'the server went away'); },
    job: async () => ({ status: 'interrupted', error: null, removal: null, ...status }),
  } as unknown as CrucibleClient;
  return { client, submitted: () => submitted };
}

async function run(status: Record<string, unknown>): Promise<{ submitted: number; ended: JobView[] }> {
  const server = crashingServer(status);
  const ended: JobView[] = [];
  const runner = new JobRunner(
    { publish: () => undefined, ended: (job) => { ended.push(job); }, land: async () => { throw new Error('nothing lands'); }, server: () => ({}) as never },
    disk, 'pending.json', async () => 0, () => server.client,
  );
  runner.generate({ name: 'pc', url: 'http://pc:7100', token: 't' } as never, { id: 'album:a', kind: 'desktop' }, { params: { tags: 'folk' }, count: 1 }, 'flac', { id: 'a', track: 11 });
  for (let i = 0; i < 200 && ended.length === 0; i += 1) await new Promise((rest) => setTimeout(rest, 5));
  return { submitted: server.submitted(), ended };
}

test('a song the server restarted under is sent again, twice, then fails by name', async () => {
  const { submitted, ended } = await run({ status: 'interrupted' });
  expect(submitted).toBe(3);
  expect(ended[0]?.phase).toBe('failed');
  expect(ended[0]?.refusal?.code).toBe('job_interrupted');
});

test('a song the restart took off the line (read after the stream dropped) is sent again too', async () => {
  const { submitted, ended } = await run({ status: 'removed', removal: { reason: 'server_restart', message: 'the server restarted', waitedS: null, at: '' } });
  expect(submitted).toBe(3);
  expect(ended[0]?.refusal?.code).toBe('removed_server_restart');
});

test("a song removed for the person's own reasons is not sent again", async () => {
  const { submitted, ended } = await run({ status: 'removed', removal: { reason: 'operator', message: 'an operator removed it', waitedS: 4, at: '' } });
  expect(submitted).toBe(1);
  expect(ended[0]?.refusal?.code).toBe('removed_operator');
});
