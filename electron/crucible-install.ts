/**
 * crucible-install — install Crucible on this computer, from one button.
 *
 * Ported from Foundry (app/electron/crucible-install.ts). Owen: "We need to be
 * able to install crucible on the computer through the electron app setup
 * page". B-Side is for other people too, so a person with no Crucible presses
 * one button and ends with Crucible installed, running, and the server B-Side
 * uses — and is never shown a command (crucible PHASE19 §0: "a command a person
 * could run is a step the app should be running").
 *
 * The installer and every native/WSL decision are Crucible's
 * (`@crucible/bootstrap`). What is B-Side's:
 *
 *   1. WHICH release: the channel's promoted latest, and never an older one than
 *      is running here (`releaseToInstall`);
 *   2. the rows a person watches (`installationSteps`), and the narration into
 *      them (`driveCrucibleInstall`, fed to the door in crucible-install-door.ts);
 *   3. the tail: start the service, register the server Crucible published, make
 *      it the one in use, and check the engine answering is the one installed.
 *
 * WHICH JOB TYPES: `echo` only, as Foundry asks. A Crucible serves nothing until
 * a type is enabled, and enabling `audio` here would make the first install
 * build YuE2's environment before the person has seen the app. Crucible installs
 * a type the moment a job asks for one (install-on-submit: a `409 installing`
 * that B-Side's job runner already follows, electron/jobs.ts), so the first
 * Generate is what fetches the song model — and the studio says so.
 */
import {
  compareReleases,
  hostInstalled,
  install,
  installStatus,
  latestRelease,
  processRunner,
  startLocal,
  TERMINAL_OUTCOME_STATES,
  type HostEvent,
  type Runner,
} from '@crucible/bootstrap';

import { probe } from './crucible';
import { installPlatform, runningCrucibleVersion, useLocal } from './crucible-local';
import { Refusal } from './refusal';
import type { ServerRegistry } from './servers';
import { machineSentence } from './system-probe';
import type {
  CrucibleInstallEvent,
  CrucibleInstallPlan,
  CrucibleInstallStep,
  InstallPlatform,
} from '../shared/crucible-install-wire';

// ─────────────────────────────────────────────────────────────────────────────
// Which release
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two facts the never-older gate compares, each from its own source. An
 * interface so a test can put a channel at one version in front of an engine at
 * another; there is no second implementation.
 */
export interface CrucibleReleaseSources {
  /** What the channel calls latest (`releases/latest`: the PROMOTED release, not the newest tag). */
  latest(): Promise<string>;
  /** The version of the Crucible answering on this computer, or null when there is none. */
  running(): Promise<string | null>;
}

/**
 * The real pair. `latestRelease` is the SDK's: no cache and no fallback — a
 * channel that will not answer is `release_channel_unreadable`, never a quieter
 * install of whatever version the vendored library happens to be.
 */
export function processReleaseSources(running: () => Promise<string | null>): CrucibleReleaseSources {
  return { latest: () => latestRelease(), running };
}

/**
 * Which release to install, or the refusal that says not to (crucible
 * `docs/INSTALL-UNINSTALL.md` §6.5.3). Four answers and no fifth:
 *
 *   nothing running  → the channel's latest
 *   channel newer    → the channel's latest
 *   channel equal    → `crucible_already_latest`
 *   channel older    → `install_older_than_running`
 *
 * There is no force. One Crucible per computer, and other apps (Foundry,
 * BookForge) may be using it: the way back from a newer one is Crucible's own
 * rollback, never a button in an app.
 */
export async function releaseToInstall(sources: CrucibleReleaseSources): Promise<string> {
  const latest = await sources.latest();
  const running = await sources.running();
  if (running === null) return latest;
  const order = compareReleases(latest, running);
  if (order < 0) {
    throw new Refusal(
      'install_older_than_running',
      `The newest Crucible release is ${latest} and Crucible ${running} is already running on this computer; `
        + 'B-Side never installs an older Crucible over a newer one.',
    );
  }
  if (order === 0) {
    throw new Refusal(
      'crucible_already_latest',
      `Crucible ${running} is running on this computer and it is the newest release, so there is nothing to install. `
        + 'Use it instead.',
    );
  }
  return latest;
}

// ─────────────────────────────────────────────────────────────────────────────
// The rows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The progress list (crucible PHASE19 §3.1) for this platform, every row
 * waiting. The PLATFORM decides which rows exist, not the events: a Mac has no
 * Windows engine and no Linux guest to move into, so it has neither row.
 *
 * On Windows the native engine answers within seconds and Crucible's tray then
 * moves it into a Linux (WSL2) guest behind it (§2.8): two facts a person
 * watching wants separately, so two rows. The last two rows are the tray's too;
 * elsewhere only the first ever runs, and `done` skips the rest.
 */
export function installationSteps(platform: InstallPlatform): CrucibleInstallStep[] {
  if (platform === 'other') return [];
  const rows: CrucibleInstallStep[] = [{
    id: 'install',
    title: 'Installing Crucible',
    detail: 'Crucible installs its own runtime and the service that keeps it running.',
  }];
  if (platform === 'win32') {
    rows.push({
      id: 'windows-engine',
      title: 'Starting the Windows engine',
      detail: 'This engine answers within seconds and keeps answering while the rest happens.',
    }, {
      id: 'linux-engine',
      title: 'Setting up the Linux engine',
      detail: 'Crucible sets this up by itself. Windows may ask for permission, and may ask for a restart.',
    }, {
      id: 'job-types',
      title: 'Preparing what B-Side needs',
      detail: 'The song model itself downloads with your first song.',
    }, {
      id: 'models',
      title: 'Moving models to the Linux engine',
      detail: 'Any models the Windows engine already holds are copied across.',
    });
  }
  return rows;
}

export async function crucibleInstallPlan(): Promise<CrucibleInstallPlan> {
  const platform = installPlatform();
  return {
    platform,
    machine: await machineSentence(),
    steps: installationSteps(platform),
    supported: platform !== 'other',
    unsupportedWhy: platform === 'other'
      ? 'Crucible runs on Windows, macOS (Apple silicon) and Linux; there is no build for this computer. Add a server running on another computer instead.'
      : '',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three sinks a run narrates into, all owned by the door
 * (crucible-install-door.ts): `event` is B-Side's own rows; `hostEvent` is
 * Crucible's Windows tray's stream, verbatim, which the door folds into rows;
 * `windowsEngineUp` is a one-shot the door makes idempotent, because the second
 * row is finished by whichever proof arrives first.
 */
export interface InstallNarration {
  event(event: CrucibleInstallEvent): void;
  hostEvent(event: HostEvent): void;
  windowsEngineUp(): void;
}

let installing = false;

export async function driveCrucibleInstall(
  registry: ServerRegistry,
  narrate: InstallNarration,
  runner: Runner = processRunner(),
  sources: CrucibleReleaseSources = processReleaseSources(runningCrucibleVersion),
): Promise<void> {
  const line = (text: string): void => narrate.event({ event: 'line', text, stream: 'stdout' });
  if (installing) throw new Refusal('install_running', 'Crucible is already being installed on this computer; this window shows its progress.');
  if (runner.platform !== 'win32' && runner.platform !== 'darwin' && runner.platform !== 'linux') {
    throw new Refusal('install_unsupported', 'Crucible does not support this computer.');
  }
  // Taken BEFORE the first await: a gap between the check and the flag lets two
  // presses both walk the sequence (measured in Foundry, 2026-09-18).
  installing = true;
  try {
    // The gate first: a refused install is one where nothing was spawned.
    const release = await releaseToInstall(sources);
    narrate.event({ event: 'step', row: 'install', jobType: null });
    line(`Crucible ${release}`);
    /*
     * One call does both halves on Windows (PHASE19 §2.6): `install()` runs
     * Crucible's install.ps1 when its host is absent, then watches the engine
     * move the TRAY starts. On macOS and Linux there is no host; the same call
     * walks the steps on the machine itself.
     */
    await install({
      release,
      jobTypes: ['echo'],
      onLine: (text, _stream, step) => line(`${step}: ${text}`),
      onHostEvent: (event) => narrate.hostEvent(event),
    }, runner).catch(async (error: unknown) => {
      /*
       * A TERMINAL OUTCOME THAT IS NOT `done` IS NOT A FAILED INSTALL. On
       * Windows `install()` refuses with the outcome's own code when the move
       * ends `cannot` (no WSL2 here: the computer stays on the Windows engine),
       * `reboot-pending` (waiting for a person to press Restart) or `declined`,
       * and `host_install_unwitnessed` when the tray's ring no longer holds the
       * `done`. In every one Crucible IS installed, so the run carries on to
       * start and register the engine that is there, and the outcome is shown
       * as a readout. Everything else is raised — and only asked about when the
       * host exists at all, so the probe never replaces the original failure
       * with one about a tray that was never installed.
       */
      if (runner.platform !== 'win32') throw error;
      if (!hostInstalled(runner)) throw error;
      let outcome;
      try {
        outcome = (await installStatus({}, runner)).outcome;
      } catch {
        throw error;
      }
      if (outcome === null || !TERMINAL_OUTCOME_STATES.includes(outcome.state)) throw error;
      line(outcome.sentence ?? `The engine move ended as ${outcome.state}.`);
    });
    // Windows's second row, for the computer that had no move to prove it with.
    if (runner.platform === 'win32') narrate.windowsEngineUp();
    const status = await startLocal({}, runner);
    if (status.state !== 'running') throw new Refusal('crucible_not_running', status.detail);
    narrate.event({ event: 'done', backend: await connectInstalled(registry, status.name, line) });
  } finally {
    installing = false;
  }
}

/**
 * The tail of an install (and of a Try again): use the server Crucible
 * published on this computer, make it the one in use, and answer the backend
 * the engine on that address reports.
 */
export async function connectInstalled(
  registry: ServerRegistry,
  installedName: string,
  line: (text: string) => void,
): Promise<string | null> {
  const used = await useLocal(registry);
  return verifyInstalled(installedName, used, line, registry);
}

/**
 * Is the engine answering the engine we just installed?
 *
 * Everything above proves the installer finished and that SOMETHING serves on
 * the address Crucible published here — not that it is the process the
 * installer built. Two checks, said on the installer's own line feed and never
 * fatal (the engine IS installed and registered by now, and throwing would show
 * a working install as a failure):
 *
 *   1. the name Crucible's status gives against the name it published;
 *   2. the engine on the socket, asked who it is (`GET /v1/info`).
 *
 * Answers the backend the engine reported, so the last sentence can say which
 * engine is serving from a measured fact; null when nothing measured it.
 */
async function verifyInstalled(
  installedName: string,
  used: { name: string; published: string },
  onLine: (line: string) => void,
  registry: ServerRegistry,
): Promise<string | null> {
  const server = registry.get(used.name);
  if (installedName !== '' && installedName !== used.published) {
    onLine(
      `Note: Crucible installed an engine calling itself "${installedName}", but the connection it published on `
        + `this computer names "${used.published}". B-Side uses the published one.`,
    );
  }
  try {
    const answered = await probe(server);
    if (answered.name !== used.published) {
      onLine(`Note: the engine at ${server.url} calls itself "${answered.name}" rather than "${used.published}".`);
    }
    return answered.backend;
  } catch (err) {
    onLine(`Note: "${server.name}" is set up but did not answer just now: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
