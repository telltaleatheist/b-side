/**
 * crucible-install-door — the one seam every install surface in B-Side uses.
 *
 * Ported from Foundry (app/electron/crucible-install-door.ts). Crucible's
 * Windows tray has an install door that can be WATCHED, not only driven
 * (crucible PHASE19 §2.6): `GET /install` answers whether an engine move is
 * running and how the last one ended, `GET /install/events` replays the last
 * 200 events and then follows, `POST /install` is Try again.
 * `@crucible/bootstrap` carries those as `installStatus()`, `watchInstall()` and
 * `requestHostInstall()`, and this file is the whole of what B-Side knows about
 * them. The move outlives a button press — the tray runs it, a restart can
 * happen in the middle — so a window that opens later ASKS where it got to
 * rather than having had to be listening.
 *
 * What is B-Side's and not the SDK's: the ROWS. The tray names its own steps;
 * {@link rowForHostStep} folds them into the five a person reads.
 *
 * One install per computer, so the state here is the module's: who is
 * listening, whether this process is driving a run, and the follow in flight.
 */
import {
  BootstrapRefusal,
  hostInstalled,
  installStatus,
  processRunner,
  requestHostInstall,
  watchInstall,
  type HostEvent,
  type InstallStatus,
  type JobTypeRequest,
  type Runner,
} from '@crucible/bootstrap';

import { connectInstalled, driveCrucibleInstall } from './crucible-install';
import { Refusal, refusalOf } from './refusal';
import type { ServerRegistry } from '../shared/core/servers';
import type {
  CrucibleInstallEvent,
  CrucibleInstallOutcome,
  CrucibleInstallRowId,
  CrucibleInstallStatus,
} from '../shared/crucible-install-wire';

/**
 * Which row one of the tray's steps belongs to (`crucible/host/installer.py`'s
 * step names):
 *
 *   host                                           → Installing Crucible
 *   wsl-state, import-distro, guest-ready,
 *   guest-install, migrate-config, lan-door,
 *   stop-windows-server, switch-pairing            → Setting up the Linux engine
 *   install-job-types                              → Preparing what B-Side needs
 *   prepare-weights, migrate-weights               → Moving models to the Linux engine
 *
 * NULL for a name this build does not know: the row on screen does not move,
 * and the step's lines land on whatever row is running. Inventing a row from
 * the step's identifier would put `switch-pairing` in front of a person.
 */
export function rowForHostStep(name: string): CrucibleInstallRowId | null {
  if (name === 'host') return 'install';
  if (name === 'install-job-types') return 'job-types';
  if (name === 'prepare-weights' || name === 'migrate-weights') return 'models';
  const MOVE = [
    'wsl-state', 'import-distro', 'guest-ready', 'guest-install',
    'migrate-config', 'lan-door', 'stop-windows-server', 'switch-pairing',
  ];
  return MOVE.includes(name) ? 'linux-engine' : null;
}

/** The outcome file (§2.2), as the bridge spells it. */
function readOutcome(status: InstallStatus): CrucibleInstallOutcome | null {
  const outcome = status.outcome;
  if (outcome === null) return null;
  return {
    state: outcome.state,
    code: outcome.code,
    sentence: outcome.sentence,
    at: outcome.at,
    release: outcome.release,
    attempts: outcome.attempts,
  };
}

/**
 * A retry is the same move again, so it asks for the same job types the install
 * asked for (`echo`: see crucible-install.ts) and the release the outcome
 * records — asking the channel here would turn Try again into an upgrade nobody
 * pressed a button for.
 */
const RETRY_JOB_TYPES: readonly JobTypeRequest[] = ['echo'];

/** Everyone listening right now (the desktop window, through ipc.ts). */
const watchers = new Set<(event: CrucibleInstallEvent) => void>();
/**
 * Everyone told when a move this process only FOLLOWED has ended. The tray's own
 * `done` is dropped (see `relay`), so without this a window watching a move the
 * tray started would go on saying it is running after it stopped.
 */
const settledWatchers = new Set<() => void>();
/** Whether this process is driving a run (an install or a retry). */
let running = false;
/** The follow in flight, so a second window opening does not open a second stream onto one move. */
let following: Promise<unknown> | null = null;
/** The second row's one-shot, reset per run (see `windowsEngineUp`). */
let windowsEngineSeen = false;

function emit(event: CrucibleInstallEvent): void {
  for (const watcher of [...watchers]) watcher(event);
}

/**
 * The tray's events, translated. Two kinds are not passed straight through:
 *
 *   - its `done` is DROPPED: it means the MOVE finished, and B-Side's `done`
 *     means the whole sequence did (started, registered, measured), which the
 *     run emits itself — forwarding the tray's would skip rows still to come;
 *   - a `step` may emit two of ours: nothing in the tray's stream announces
 *     "Starting the Windows engine", but its first move step proves that engine
 *     is up (§2.8), so that row is drawn and closed on that proof.
 *
 * An event kind this build does not know (`unknown`, the SDK's carrier for a
 * newer tray) is said in the log and not drawn.
 */
function relay(event: HostEvent): void {
  switch (event.event) {
    case 'step': {
      const row = rowForHostStep(event.data.name);
      if (row === null) return;
      if (row === 'linux-engine') windowsEngineUp();
      emit({ event: 'step', row, jobType: null });
      return;
    }
    case 'progress':
      emit({ event: 'progress', bytesDone: event.data.bytes_done, bytesTotal: event.data.bytes_total, file: event.data.file });
      return;
    case 'state':
      emit({ event: 'state', code: event.data.code, sentence: event.data.sentence, action: event.data.action });
      return;
    case 'line':
      emit({ event: 'line', text: event.data.text, stream: event.data.stream });
      return;
    case 'failed':
      emit({ event: 'failed', code: event.data.code, message: event.data.message });
      return;
    case 'done':
      return;
    case 'unknown':
      console.log(`[crucible] the install door sent a "${event.kind}" event this B-Side does not know; not drawn.`);
      return;
  }
}

/**
 * The second row ("Starting the Windows engine"), drawn once per run by
 * whichever proof arrives first: the tray's first move step (`relay`), or the
 * run getting past the installer on a computer that had no move at all. A row
 * that went `running` again after it was `done` would be the list going
 * backwards under somebody watching it.
 */
function windowsEngineUp(): void {
  if (windowsEngineSeen) return;
  windowsEngineSeen = true;
  emit({ event: 'step', row: 'windows-engine', jobType: null });
}

export interface CrucibleInstallDoor {
  /** Is a move running here, and how did the last one end? */
  status(): Promise<CrucibleInstallStatus>;
  /** Hear every event. Answers the detach. */
  watch(onEvent: (event: CrucibleInstallEvent) => void): () => void;
  /** Hear that a followed move (one this process did not drive) has ended, so it is asked about again. */
  onSettled(listener: () => void): () => void;
  /**
   * Make sure there is something to hear: join the tray's event stream when a
   * move is running that this process did not start (the ordinary case — the
   * tray starts moves by itself). Idempotent, and it never starts a move.
   */
  attach(): void;
  /** Install Crucible on this computer, narrating into every watcher. */
  install(): Promise<void>;
  /**
   * §2.5's Try again — the same move once more, then B-Side's server follows
   * whatever connection it left. Offered only on `cannot` or `failed`.
   */
  retry(): Promise<void>;
}

/**
 * A second press while a run is going is refused BEFORE it touches anything.
 * Letting it through to the run's own guard would emit `failed` onto the rows of
 * the run that is still going, and its `finally` would clear `running` under it
 * (Foundry's door, which this is ported from, does both).
 */
function refuseWhileRunning(): void {
  if (running) {
    throw new Refusal('install_running', 'Crucible is already being installed on this computer; its progress is shown here.');
  }
}

/**
 * The door over `@crucible/bootstrap`. `runner` is the SDK's own seam and the
 * only one this adds.
 *
 * Off Windows, or on Windows before Crucible's host is installed, there IS no
 * door: `status` answers "nothing running, nothing recorded" rather than asking
 * a tray that does not exist (which would refuse `host_unreachable`, a true and
 * useless sentence about a computer nobody has installed anything on). An
 * installed tray that will not answer is still raised by name.
 */
export function crucibleInstallDoor(registry: ServerRegistry, runner: Runner = processRunner()): CrucibleInstallDoor {
  const hasDoor = (): boolean => runner.platform === 'win32' && hostInstalled(runner);
  return {
    status: async () => {
      if (!hasDoor()) return { running, outcome: null };
      const answered = await installStatus({}, runner);
      return { running: answered.running || running, outcome: readOutcome(answered) };
    },
    watch: (onEvent) => {
      watchers.add(onEvent);
      return () => {
        watchers.delete(onEvent);
      };
    },
    onSettled: (listener) => {
      settledWatchers.add(listener);
      return () => {
        settledWatchers.delete(listener);
      };
    },
    attach: () => {
      // Not while this process is driving: a second reader would put every event on the rows twice.
      if (running || following !== null || !hasDoor()) return;
      windowsEngineSeen = false;
      following = watchInstall({ onEvent: relay }, runner)
        .catch((error: unknown) => {
          // Said, not drawn: a dropped stream is this process losing sight of a
          // move that is very likely still going. The next status() attaches again.
          console.error(`[crucible] lost the install event stream: ${refusalOf(error).message}`);
        })
        .finally(() => {
          following = null;
          for (const listener of [...settledWatchers]) listener();
        });
    },
    install: async () => {
      refuseWhileRunning();
      running = true;
      windowsEngineSeen = false;
      try {
        await driveCrucibleInstall(registry, { event: emit, hostEvent: relay, windowsEngineUp }, runner);
      } catch (error) {
        const refusal = refusalOf(error);
        emit({ event: 'failed', code: refusal.code, message: refusal.message });
        throw error;
      } finally {
        running = false;
      }
    },
    retry: async () => {
      refuseWhileRunning();
      running = true;
      windowsEngineSeen = false;
      try {
        const outcome = (await installStatus({}, runner)).outcome;
        if (outcome === null) {
          throw new BootstrapRefusal(
            'host_install_failed',
            'This computer has no record of an engine move, so there is nothing to try again. Install Crucible here first.',
          );
        }
        try {
          await requestHostInstall({ release: outcome.release, jobTypes: RETRY_JOB_TYPES, onEvent: relay }, runner);
        } catch (error) {
          // 409 is a race this door wins by waiting: the tray started the same
          // move a moment before the press. Every other refusal is raised.
          if (!(error instanceof BootstrapRefusal) || error.code !== 'host_install_running') throw error;
          await watchInstall({ onEvent: relay }, runner);
        }
        // The move may have switched the published connection to the Linux
        // engine, so it is read again and B-Side's server follows it.
        const line = (text: string): void => emit({ event: 'line', text, stream: 'stdout' });
        emit({ event: 'done', backend: await connectInstalled(registry, '', line) });
      } catch (error) {
        const refusal = refusalOf(error);
        emit({ event: 'failed', code: refusal.code, message: refusal.message });
        throw error;
      } finally {
        running = false;
      }
    },
  };
}
