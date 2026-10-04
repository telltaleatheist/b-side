import { expect, test } from 'bun:test';

import { rowForHostStep } from '../electron/crucible-install-door';
import { installationSteps, releaseToInstall, type CrucibleReleaseSources } from '../electron/crucible-install';
import { readUninstallDocument } from '../electron/crucible-uninstall';
import {
  applyInstallEvent,
  initialInstallRows,
  type CrucibleInstallEvent,
  type CrucibleInstallRow,
} from '../shared/crucible-install-wire';
import { uninstallStoppedTheEngine } from '../shared/uninstall-wire';

function sources(latest: string, running: string | null): CrucibleReleaseSources {
  return { latest: async () => latest, running: async () => running };
}

// ── which release ────────────────────────────────────────────────────────────

test('nothing running here: the channel latest is installed', async () => {
  expect(await releaseToInstall(sources('1.0.99', null))).toBe('1.0.99');
});

test('a newer channel than the running Crucible is installed, compared number by number', async () => {
  expect(await releaseToInstall(sources('1.0.10', '1.0.9'))).toBe('1.0.10');
});

test('the same release as the running Crucible is refused by name: nothing to install', async () => {
  await expect(releaseToInstall(sources('1.0.99', '1.0.99'))).rejects.toMatchObject({ code: 'crucible_already_latest' });
});

test('an older channel than the running Crucible is refused by name: never a downgrade', async () => {
  await expect(releaseToInstall(sources('1.0.98', '1.0.99'))).rejects.toMatchObject({ code: 'install_older_than_running' });
  await expect(releaseToInstall(sources('1.0.9', '1.0.10'))).rejects.toMatchObject({ code: 'install_older_than_running' });
});

test('a version that is not three numbers is refused, not sorted to one end', async () => {
  await expect(releaseToInstall(sources('latest', '1.0.99'))).rejects.toMatchObject({ code: 'release_channel_unreadable' });
});

test('the channel is asked before anything else, and its refusal is the one raised', async () => {
  let askedRunning = false;
  const failing: CrucibleReleaseSources = {
    latest: async () => {
      throw Object.assign(new Error('could not read the release channel'), { code: 'release_channel_unreadable' });
    },
    running: async () => {
      askedRunning = true;
      return null;
    },
  };
  await expect(releaseToInstall(failing)).rejects.toMatchObject({ code: 'release_channel_unreadable' });
  expect(askedRunning).toBe(false);
});

// ── the rows ─────────────────────────────────────────────────────────────────

test('the platform decides which rows exist', () => {
  expect(installationSteps('win32').map((step) => step.id)).toEqual(['install', 'windows-engine', 'linux-engine', 'job-types', 'models']);
  expect(installationSteps('darwin').map((step) => step.id)).toEqual(['install']);
  expect(installationSteps('linux').map((step) => step.id)).toEqual(['install']);
  expect(installationSteps('other')).toEqual([]);
});

test("the tray's steps fold into the five rows, and a step this build does not know moves nothing", () => {
  expect(rowForHostStep('host')).toBe('install');
  for (const step of ['wsl-state', 'import-distro', 'guest-ready', 'guest-install', 'migrate-config', 'lan-door', 'stop-windows-server', 'switch-pairing']) {
    expect(rowForHostStep(step)).toBe('linux-engine');
  }
  expect(rowForHostStep('install-job-types')).toBe('job-types');
  expect(rowForHostStep('prepare-weights')).toBe('models');
  expect(rowForHostStep('migrate-weights')).toBe('models');
  expect(rowForHostStep('some-new-step')).toBeNull();
});

function play(rows: CrucibleInstallRow[], events: CrucibleInstallEvent[]): CrucibleInstallRow[] {
  return events.reduce(applyInstallEvent, rows);
}

const states = (rows: readonly CrucibleInstallRow[]): Record<string, string> =>
  Object.fromEntries(rows.map((row) => [row.id, row.state]));

test('a Windows install fills its rows in order, and lines and bytes land on the running row', () => {
  const start = initialInstallRows(installationSteps('win32'));
  const midway = play(start, [
    { event: 'step', row: 'install', jobType: null },
    { event: 'line', text: 'host: downloading', stream: 'stdout' },
    { event: 'step', row: 'windows-engine', jobType: null },
    { event: 'step', row: 'linux-engine', jobType: null },
    { event: 'progress', bytesDone: 500, bytesTotal: 1000, file: 'rootfs.tar' },
    { event: 'state', code: 'wsl_ready', sentence: 'WSL2 is ready.', action: 'run' },
  ]);
  expect(states(midway)).toEqual({ install: 'done', 'windows-engine': 'done', 'linux-engine': 'running', 'job-types': 'waiting', models: 'waiting' });
  const linux = midway.find((row) => row.id === 'linux-engine');
  expect(linux?.bytesDone).toBe(500);
  expect(linux?.detail).toBe('WSL2 is ready.');
  expect(midway.find((row) => row.id === 'install')?.detail).toBe('host: downloading');
  // Pure: the rows it was given are untouched.
  expect(states(start).install).toBe('waiting');

  const done = play(midway, [{ event: 'done', backend: 'cuda-linux' }]);
  expect(states(done)).toEqual({ install: 'done', 'windows-engine': 'done', 'linux-engine': 'done', 'job-types': 'skipped', models: 'skipped' });
});

test('a failure fails the running row with its message and skips the rest', () => {
  const rows = play(initialInstallRows(installationSteps('win32')), [
    { event: 'step', row: 'install', jobType: null },
    { event: 'failed', code: 'host_not_installed', message: 'install.ps1 exited 9' },
  ]);
  expect(states(rows)).toEqual({ install: 'failed', 'windows-engine': 'skipped', 'linux-engine': 'skipped', 'job-types': 'skipped', models: 'skipped' });
  expect(rows[0]?.detail).toBe('install.ps1 exited 9');
});

test('a step for a row this platform does not have is dropped, not appended', () => {
  const rows = play(initialInstallRows(installationSteps('darwin')), [
    { event: 'step', row: 'install', jobType: null },
    { event: 'step', row: 'windows-engine', jobType: null },
  ]);
  expect(rows.map((row) => row.id)).toEqual(['install']);
  expect(states(rows).install).toBe('running');
});

test('job types are children of their row, one running at a time', () => {
  const rows = play(initialInstallRows(installationSteps('win32')), [
    { event: 'step', row: 'job-types', jobType: 'audio' },
    { event: 'line', text: 'pip: collecting torch', stream: 'stdout' },
    { event: 'step', row: 'job-types', jobType: 'llm' },
  ]);
  const jobs = rows.find((row) => row.id === 'job-types');
  expect(jobs?.children).toEqual([
    { jobType: 'audio', state: 'done', detail: 'pip: collecting torch' },
    { jobType: 'llm', state: 'running', detail: null },
  ]);
});

// ── the uninstall plan ───────────────────────────────────────────────────────

const PLAN = {
  dry_run: false,
  home: 'C:\\Users\\x\\AppData\\Local\\Crucible',
  platform: 'win32',
  mechanism: 'startup',
  backend_kind: null,
  purge_weights: false,
  wsl_too: false,
  steps: [
    { name: 'stop-engine', what: 'Stop the engine', action: 'stop', target: 'pid 42', done: true, refused: null },
    { name: 'weights:audio', what: 'Keep the models', action: 'keep', target: 'C:\\w', bytes: 2048, done: false, refused: null },
    { name: 'keep-unknown:notes.txt', what: 'A file Crucible did not write', action: 'keep', target: 'C:\\n', bytes: 10, done: false,
      refused: { code: 'home_not_empty', message: 'not ours', fatal: false }, detail: ['line one'] },
  ],
  kept: { weights_bytes: 2048, paths: ['C:\\w'] },
  removed_bytes: 0,
  ok: true,
};

test('the uninstall document is read field for field; an absent size is null, not zero', () => {
  const plan = readUninstallDocument(JSON.stringify(PLAN));
  expect(plan.backendKind).toBeNull();
  expect(plan.steps.map((step) => step.name)).toEqual(['stop-engine', 'weights:audio', 'keep-unknown:notes.txt']);
  expect(plan.steps[0]?.bytes).toBeNull();
  expect(plan.steps[1]?.bytes).toBe(2048);
  expect(plan.steps[2]?.refused).toEqual({ code: 'home_not_empty', message: 'not ours', fatal: false });
  expect(plan.steps[2]?.detail).toEqual(['line one']);
  expect(plan.kept).toEqual({ weightsBytes: 2048, paths: ['C:\\w'] });
  expect(uninstallStoppedTheEngine(plan)).toBe(true);
  expect(uninstallStoppedTheEngine({ ...plan, steps: plan.steps.map((step) => ({ ...step, done: false })) })).toBe(false);
});

function thrownCode(work: () => unknown): string | null {
  try {
    work();
  } catch (error) {
    return (error as { code?: string }).code ?? null;
  }
  return null;
}

test('a plan missing a field it always carries is refused by name, never defaulted', () => {
  const { ok: _ok, ...withoutOk } = PLAN;
  expect(() => readUninstallDocument(JSON.stringify(withoutOk))).toThrow(/"ok"/);
  expect(thrownCode(() => readUninstallDocument(JSON.stringify(withoutOk)))).toBe('uninstall_unreadable');
  expect(thrownCode(() => readUninstallDocument('not json'))).toBe('uninstall_unreadable');
  expect(thrownCode(() => readUninstallDocument(JSON.stringify({ ...PLAN, kept: { weights_bytes: 1 } })))).toBe('uninstall_unreadable');
});
