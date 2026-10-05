/**
 * crucible-local — the Crucible on THIS computer: is there one, is it running,
 * and does B-Sides use it.
 *
 * Ported from Foundry (app/electron/crucible-pairing.ts, crucible-start.ts and
 * the local half of crucible-registry.ts). Crucible owns all of it and B-Sides
 * only asks:
 *
 *   - Crucible's installation record and its own `crucible local status`
 *     (`@crucible/bootstrap`'s `localStatus`) say whether it is installed and
 *     running, and `startLocal` starts its managed service;
 *   - the PAIRING FILE (`@crucible/client`'s `readPairingFile`) is the
 *     connection Crucible published on this computer — the same one line a
 *     person would paste — so using the Crucible here needs nobody to copy a
 *     token (crucible PHASE15-HOST §3.6).
 *
 * An absent pairing file is a FACT ("no Crucible published a connection
 * here"), never a reason to guess an address.
 *
 * Desktop-only: these run on the computer B-Sides runs on, for its window, over
 * the preload bridge (electron/ipc.ts). The token read here goes straight into
 * the server registry and is never logged or answered to the window.
 */
import { localStatus, startLocal } from '@crucible/bootstrap';
import { CruciblePairingError, cruciblePairingPath, readPairingFile, type Pairing } from '@crucible/client';

import { probe } from '../shared/core/crucible';
import { Refusal } from './refusal';
import type { ServerRegistry } from '../shared/core/servers';
import type {
  CrucibleFault,
  CrucibleStartResult,
  InstallPlatform,
  LocalCrucibleState,
  LocalCrucibleView,
} from '../shared/crucible-install-wire';
import type { ServerView } from '../shared/types';

export function installPlatform(): InstallPlatform {
  const platform = process.platform;
  return platform === 'win32' || platform === 'darwin' || platform === 'linux' ? platform : 'other';
}

// ─────────────────────────────────────────────────────────────────────────────
// The pairing file
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the read found. Three answers, one more than the SDK's `Pairing | null`:
 * `absent` is the ordinary state of a computer with no Crucible; `refused` is a
 * file that exists and cannot be read, which is somebody's to fix and carries
 * the SDK's sentence (which already elides the token).
 */
export type PairingFileRead =
  | { readonly found: 'pairing'; readonly pairing: Pairing; readonly path: string }
  | { readonly found: 'absent'; readonly path: string }
  | { readonly found: 'refused'; readonly message: string; readonly path: string };

export async function pairingFileRead(): Promise<PairingFileRead> {
  const file = await cruciblePairingPath();
  try {
    const pairing = await readPairingFile();
    return pairing === null ? { found: 'absent', path: file } : { found: 'pairing', pairing, path: file };
  } catch (err) {
    // A file we can see and cannot read is not "you have no Crucible": that
    // answer would offer to install a second one over the one that is here.
    const message = err instanceof CruciblePairingError
      ? `${file}: ${err.message}`
      : `${file} could not be read: ${err instanceof Error ? err.message : String(err)}`;
    return { found: 'refused', message, path: file };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Running or not
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `crucible local status`, in the distinctions B-Sides acts on (see
 * `LocalCrucibleState`). `localStatus` answers `broken` rather than throwing for
 * every fault it anticipated, so a throw is a status document that could not be
 * obtained — `broken` too, with the reason.
 */
export async function localState(): Promise<LocalCrucibleState> {
  try {
    const status = await localStatus();
    switch (status.state) {
      case 'absent':
      case 'stopped':
      case 'unreachable':
      case 'unhealthy':
      case 'running':
        return { kind: status.state, why: status.detail };
      case 'wrong_service':
      case 'unauthorized':
      case 'broken':
        return { kind: 'problem', fault: status.state, why: status.detail, what: faultWords(status.state) };
      default:
        // A word this build has not heard of is NAMED: the Crucible here is newer than B-Sides.
        return {
          kind: 'problem',
          fault: 'broken',
          what: faultWords('broken'),
          why: `Crucible reported a state this version of B-Sides does not know: "${String(status.state)}". `
            + 'B-Sides may be older than the Crucible on this computer.',
        };
    }
  } catch (err) {
    return {
      kind: 'problem',
      fault: 'broken',
      why: err instanceof Error ? err.message : String(err),
      what: faultWords('broken'),
    };
  }
}

/**
 * The three installation faults, each in its own words, because each is a
 * different thing for a person to do. (Foundry's `crucibleFaultWords`.)
 */
function faultWords(fault: CrucibleFault): string {
  switch (fault) {
    case 'wrong_service':
      return 'Another program is answering on the address Crucible was set up on, so B-Sides cannot reach it. '
        + 'Close that program, or open Crucible and let it pair again.';
    case 'unauthorized':
      return 'Crucible is running and refused the credentials it published on this computer. That happens when '
        + 'it was reinstalled or paired afresh since; open Crucible and let it pair again.';
    case 'broken':
      return 'Crucible is on this computer, but the record it publishes for other programs is missing, unreadable, '
        + 'or written by a version B-Sides cannot read. Open Crucible and let its installer repair it; nothing in '
        + 'B-Sides can do that from here.';
  }
}

/** What this computer has, for the setup card. Reads only: nothing is started or written. */
export async function localView(registry: ServerRegistry): Promise<LocalCrucibleView> {
  const [state, read] = await Promise.all([localState(), pairingFileRead()]);
  let published: LocalCrucibleView['published'] = null;
  if (read.found === 'pairing') {
    const registered = registry.atAddress(read.pairing.url);
    published = {
      name: read.pairing.name,
      url: read.pairing.url,
      registeredAs: registered?.name ?? null,
      active: registered !== null && registry.views().some((view) => view.name === registered.name && view.active),
    };
  }
  return {
    platform: installPlatform(),
    state,
    published,
    publishedRefusal: read.found === 'refused' ? read.message : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Using it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register the Crucible this computer published and make it the one B-Sides
 * uses. Refuses by name when nothing was published (there is nothing to use)
 * or the file cannot be read.
 */
export async function useLocal(
  registry: ServerRegistry,
): Promise<{ name: string; published: string; servers: ServerView[] }> {
  const read = await pairingFileRead();
  if (read.found === 'absent') {
    throw new Refusal(
      'no_local_crucible',
      `No Crucible has published a connection on this computer (nothing at ${read.path}). Install one here, or add a server from its pairing line.`,
    );
  }
  if (read.found === 'refused') throw new Refusal('local_pairing_unreadable', read.message);
  const used = await registry.usePublished(read.pairing);
  console.log(`[crucible] using "${used.name}" at ${read.pairing.url}, published in ${read.path}`);
  return { ...used, published: read.pairing.name };
}

/**
 * After an engine move B-Sides only followed (the tray ran it by itself), the
 * server B-Sides ALREADY has at the published address takes the published token:
 * the pairing file is the token's one owner, and a move can rewrite it. Nothing
 * is added and nothing is made active — that stays a person's press. Answers
 * whether anything changed.
 */
export async function refreshPublished(registry: ServerRegistry): Promise<boolean> {
  const read = await pairingFileRead();
  if (read.found !== 'pairing') return false;
  const registered = registry.atAddress(read.pairing.url);
  if (registered === null || registered.token === read.pairing.token) return false;
  await registry.update(registered.name, { name: registered.name, url: registered.url, token: read.pairing.token });
  console.log(`[crucible] "${registered.name}" took the token Crucible published after its engine move`);
  return true;
}

/**
 * Start Crucible's managed service (it stays running after B-Sides closes), then
 * use it. Answered with Crucible's own sentence: "started", "still coming up"
 * and "nothing here to start" are all facts somebody should read.
 */
export async function startAndUse(registry: ServerRegistry): Promise<CrucibleStartResult & { servers: ServerView[] | null }> {
  const status = await startLocal();
  if (status.state !== 'running') return { started: false, detail: status.detail, servers: null };
  const used = await useLocal(registry);
  return { started: true, detail: status.detail, servers: used.servers };
}

/**
 * The version of the Crucible answering on this computer, or null when there is
 * none (no pairing file: the ordinary state of a fresh install).
 *
 * A file that cannot be read, or an engine that will not say its version, is
 * RAISED, not null: "there is no server here" and "the server here would not say
 * what it is" are different facts, and installing over the second blind is what
 * the never-older gate exists to stop.
 */
export async function runningCrucibleVersion(): Promise<string | null> {
  const read = await pairingFileRead();
  if (read.found === 'absent') return null;
  if (read.found === 'refused') throw new Refusal('install_precheck_failed', read.message);
  try {
    const answered = await probe({ name: read.pairing.name, url: read.pairing.url, token: read.pairing.token });
    return answered.version;
  } catch (err) {
    throw new Refusal(
      'install_precheck_failed',
      `This computer publishes a Crucible at ${read.pairing.url} and it did not say what version it is `
        + `(${err instanceof Error ? err.message : String(err)}). Nothing is installed over a Crucible that cannot be read; `
        + 'start it (or restart this computer) and try again.',
    );
  }
}
