/**
 * uninstall-wire — `crucible uninstall --json`, mirrored for the desktop window.
 *
 * Ported from Foundry (app/shared/uninstall-wire.ts). crucible
 * `docs/INSTALL-UNINSTALL.md` §6.3 prints ONE JSON document, and `--dry-run`
 * prints the same document unperformed, so there is no second description of
 * the work to drift. This is that document field for field in camelCase:
 * nothing dropped, nothing computed (`kept.weightsBytes` and `removedBytes` are
 * the server's sums, not ours). Main reads it (electron/crucible-uninstall.ts),
 * the window draws it. Desktop-only, like the install.
 *
 * ABSENT IS NULL, MISSING IS A REFUSAL. `bytes` is optional in §6.3 ("absent
 * when the target is not a path — which is not zero"), so it is `number | null`.
 * A field the document always carries and did not is `uninstall_unreadable`: a
 * plan with an invented `ok` says the wrong thing about a machine somebody is
 * about to change.
 *
 * Step NAMES and ACTIONS are strings, not unions: two of §6.3's name shapes are
 * open (`weights:<catalog kind>`, `keep-unknown:<file>`), so a new one is a row
 * that reads oddly, never a plan that will not parse. Every row is drawn and
 * nothing switches on one — except `stop-engine` / `wsl-guest`, which say the
 * engine's token is gone (see `uninstallStoppedTheEngine`).
 *
 * No token is in this shape: `remove-config` deletes the file that holds it and
 * never echoes it.
 */

/**
 * Which command will be run, chosen by what is on this computer: the Windows
 * host pack (whose CLI also drives the engine in the WSL guest), or the server
 * pack on macOS/Linux.
 */
export type CrucibleUninstallVia = 'windows-host' | 'server-pack';

/**
 * May the door be drawn at all. Owen's ruling, carried from Foundry: the door
 * only for a server B-Sides can PROVE is this computer's — Crucible's own
 * installation record here — never for a registry entry as such (an address of
 * 127.0.0.1 is no proof: a tunnel puts somebody else's card there).
 *
 * `server` is the B-Sides server whose address and token match the connection
 * Crucible published here, or null. After a real run that stopped the engine
 * its token is dead, and that server is removed from B-Sides' list.
 */
export interface CrucibleUninstallAvailability {
  readonly available: boolean;
  readonly why: string;
  readonly via: CrucibleUninstallVia | null;
  readonly server: string | null;
  /** The refusal name when `available` is false, else null. */
  readonly code: CrucibleUninstallCode | null;
  /** `--wsl-too` exists only where the Windows host drives a guest. */
  readonly wslTooOffered: boolean;
}

/**
 * B-Sides' refusal names (the same words Foundry and BookForge use for the same
 * situations). The CLI's own per-step refusals are a different layer: they
 * arrive inside the plan, in the engine's words, and are never translated.
 *
 *   uninstall_not_local          nothing on this computer proves the server is its own
 *   uninstall_not_available      no installation record, or a CLI that predates the verb
 *   uninstall_wsl_too_needs_host `--wsl-too` where nothing can drive a guest
 *   uninstall_unrun              the command never ran, or never answered
 *   uninstall_unreadable         it printed something that is not the plan
 *   uninstall_failed             it fell over and printed no plan at all
 */
export type CrucibleUninstallCode =
  | 'uninstall_not_local'
  | 'uninstall_not_available'
  | 'uninstall_wsl_too_needs_host'
  | 'uninstall_unrun'
  | 'uninstall_unreadable'
  | 'uninstall_failed';

export interface CrucibleUninstallFlags {
  readonly purgeWeights: boolean;
  /** Only where `wslTooOffered`. */
  readonly wslToo: boolean;
}

/**
 * Why a step did not happen. `fatal: false` is "there was nothing there";
 * `fatal: true` makes the plan's `ok` false WITHOUT stopping the run — every
 * other step still happened — which is why the window marks one row and never
 * says "uninstall failed".
 */
export interface CrucibleUninstallRefusal {
  readonly code: string;
  readonly message: string;
  readonly fatal: boolean;
}

export interface CrucibleUninstallStep {
  readonly name: string;
  /** One sentence for a person, the server's. */
  readonly what: string;
  /** `remove` | `stop` | `keep` today. */
  readonly action: string;
  /** The path, unit name, label, pid or distro. */
  readonly target: string;
  /** Disk the target holds, or null when the target is not a path — not zero. */
  readonly bytes: number | null;
  /** Did THIS run perform it? Always false after a dry run. */
  readonly done: boolean;
  readonly refused: CrucibleUninstallRefusal | null;
  readonly detail: readonly string[] | null;
}

export interface CrucibleUninstallKept {
  /** The sum of the kept `weights:*` steps. */
  readonly weightsBytes: number;
  readonly paths: readonly string[];
}

/** The whole document; a dry run and a real run are the same shape. */
export interface CrucibleUninstallPlan {
  readonly dryRun: boolean;
  readonly home: string;
  readonly platform: string;
  readonly mechanism: string;
  readonly backendKind: string | null;
  readonly purgeWeights: boolean;
  readonly wslToo: boolean;
  readonly steps: readonly CrucibleUninstallStep[];
  readonly kept: CrucibleUninstallKept;
  /** The sum of the remove steps that ran. 0 on a dry run. */
  readonly removedBytes: number;
  /** False when any step's refusal was fatal. */
  readonly ok: boolean;
}

/** The real run: the performed plan, and the B-Sides server removed because its token died with it. */
export interface CrucibleUninstallRun {
  readonly plan: CrucibleUninstallPlan;
  readonly unregistered: string | null;
}

/** Did this run stop the engine (and so kill its token, which `remove-config` always deletes)? */
export function uninstallStoppedTheEngine(plan: CrucibleUninstallPlan): boolean {
  return plan.steps.some((step) => (step.name === 'stop-engine' || step.name === 'wsl-guest') && step.done);
}
