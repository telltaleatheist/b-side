/**
 * crucible-uninstall — remove Crucible from this computer, through Crucible's
 * own uninstall plan.
 *
 * Ported from Foundry (app/electron/crucible-uninstall.ts). The work is the
 * installed CLI's (`crucible uninstall --json`, crucible
 * `docs/INSTALL-UNINSTALL.md` §6); `@crucible/bootstrap`'s
 * `localUninstallCommand` builds its invocation from the installation record,
 * and this file runs it twice — a dry run that touches nothing, then the same
 * flags for real — and reads the one JSON document it prints
 * (shared/uninstall-wire.ts).
 *
 * The door is offered only for a Crucible B-Sides can PROVE is this computer's:
 * Crucible's own installation record here. Never for a registry entry as such.
 *
 * Desktop-only, over the preload bridge.
 */
import { localUninstallCommand, processRunner, readLocalInstallation } from '@crucible/bootstrap';

import { pairingFileRead } from './crucible-local';
import { Refusal } from './refusal';
import type { ServerRegistry } from '../shared/core/servers';
import {
  uninstallStoppedTheEngine,
  type CrucibleUninstallAvailability,
  type CrucibleUninstallCode,
  type CrucibleUninstallFlags,
  type CrucibleUninstallKept,
  type CrucibleUninstallPlan,
  type CrucibleUninstallRefusal,
  type CrucibleUninstallRun,
  type CrucibleUninstallStep,
} from '../shared/uninstall-wire';

/**
 * A dry run reads a few directories; a real run stops a service and deletes
 * them. Two ceilings, because one number that fitted both would cut a real
 * uninstall off mid-delete or leave a dry run spinning for ten minutes.
 */
const DRY_RUN_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 600_000;

function refuse(code: CrucibleUninstallCode, sentence: string): Refusal {
  return new Refusal(code, sentence);
}

/** May the door be drawn, and what would it run. Reads only. */
export async function uninstallAvailability(registry: ServerRegistry): Promise<CrucibleUninstallAvailability> {
  let installed;
  try {
    installed = readLocalInstallation();
  } catch (err) {
    return refused('uninstall_not_available', err instanceof Error ? err.message : String(err));
  }
  if (installed === null) {
    return refused('uninstall_not_available', 'Crucible has no installation record on this computer, so there is nothing here B-Sides can remove.');
  }
  // The B-Sides server whose address AND token are the ones Crucible published here: the one whose token dies with it.
  const pairing = await pairingFileRead();
  const server = pairing.found === 'pairing' ? registry.atAddress(pairing.pairing.url) : null;
  const via = installed.platform === 'win32' ? 'windows-host' : 'server-pack';
  return {
    available: true,
    why: 'Crucible published its installation and uninstall controls on this computer.',
    via,
    server: server !== null && pairing.found === 'pairing' && server.token === pairing.pairing.token ? server.name : null,
    code: null,
    wslTooOffered: via === 'windows-host',
  };
}

function refused(code: CrucibleUninstallCode, why: string): CrucibleUninstallAvailability {
  return { available: false, why, via: null, server: null, code, wslTooOffered: false };
}

/** The plan, unperformed. Nothing is touched. */
export function uninstallDryRun(registry: ServerRegistry, flags: CrucibleUninstallFlags): Promise<CrucibleUninstallPlan> {
  return invokeUninstall(registry, flags, true);
}

/**
 * The same flags, performed — and the one thing B-Sides does that the verb
 * cannot: the token always goes with an uninstall (`remove-config` is
 * unconditional), so a run that stopped the engine leaves B-Sides' server for it
 * holding a dead credential, and that server is removed. Read off the PLAN, not
 * the exit code: a fatal `stop_failed` is a run where other steps happened and
 * the engine did not stop.
 */
export async function uninstallPerform(registry: ServerRegistry, flags: CrucibleUninstallFlags): Promise<CrucibleUninstallRun> {
  const availability = await uninstallAvailability(registry);
  const plan = await invokeUninstall(registry, flags, false);
  if (availability.server === null || !uninstallStoppedTheEngine(plan)) return { plan, unregistered: null };
  await registry.remove(availability.server);
  console.log(`[crucible] removed "${availability.server}": its engine was uninstalled from this computer and its token went with it.`);
  return { plan, unregistered: availability.server };
}

async function invokeUninstall(
  registry: ServerRegistry,
  flags: CrucibleUninstallFlags,
  dryRun: boolean,
): Promise<CrucibleUninstallPlan> {
  const availability = await uninstallAvailability(registry);
  if (!availability.available) throw refuse(availability.code ?? 'uninstall_not_local', availability.why);
  if (flags.wslToo && !availability.wslTooOffered) {
    throw refuse('uninstall_wsl_too_needs_host', "Only Crucible's Windows host removes the engine inside the WSL guest, and this computer has none.");
  }
  const command = localUninstallCommand({ dryRun, purgeWeights: flags.purgeWeights, wslToo: flags.wslToo });
  const result = await processRunner().run(command.argv, {
    timeoutMs: dryRun ? DRY_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS,
    env: command.env,
    cwd: command.cwd,
  });
  if (result.failure !== null) throw refuse('uninstall_unrun', `Crucible's uninstall ${result.failure}.`);
  /*
   * §6.2's exit codes: 1 is "a step failed" and is STILL A PLAN (its `ok: false`
   * names which step; the others happened), so it is read like 0. 2 is usage —
   * the CLI here predates the verb.
   */
  if (result.code === 2) {
    throw refuse(
      'uninstall_not_available',
      `The Crucible installed on this computer has no uninstall command; it is older than B-Sides needs${said(result.stderr)}`,
    );
  }
  if (result.stdout.trim() === '') {
    throw result.code === 0
      ? refuse('uninstall_unreadable', "Crucible's uninstall printed nothing at all.")
      : refuse('uninstall_failed', `Crucible's uninstall ended with code ${String(result.code)} and printed no plan${said(result.stderr)}`);
  }
  return readUninstallDocument(result.stdout);
}

function said(stderr: string): string {
  const line = stderr.trim().split(/\r?\n/)[0] ?? '';
  return line === '' ? '.' : `: ${line}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The reader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One JSON document, read into the wire. Strict about fields, open about values
 * (the split Foundry and BookForge agreed, so one plan reads the same in every
 * app): a field the document always carries and did not is
 * `uninstall_unreadable`; an optional field absent is null; an unknown step name
 * or action word is carried through and drawn.
 */
export function readUninstallDocument(text: string): CrucibleUninstallPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch (error) {
    throw refuse(
      'uninstall_unreadable',
      `Crucible's uninstall did not print a plan B-Sides can read (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  const doc = asObject(parsed, 'the plan');
  const steps = doc['steps'];
  if (!Array.isArray(steps)) throw refuse('uninstall_unreadable', "Crucible's uninstall printed a plan with no steps in it.");
  return {
    dryRun: needBoolean(doc, 'dry_run'),
    home: needString(doc, 'home'),
    platform: needString(doc, 'platform'),
    mechanism: needString(doc, 'mechanism'),
    backendKind: needNullableString(doc, 'backend_kind'),
    purgeWeights: needBoolean(doc, 'purge_weights'),
    wslToo: needBoolean(doc, 'wsl_too'),
    steps: steps.map(readStep),
    kept: readKept(doc['kept']),
    removedBytes: needNumber(doc, 'removed_bytes'),
    ok: needBoolean(doc, 'ok'),
  };
}

function readStep(raw: unknown): CrucibleUninstallStep {
  const row = asObject(raw, 'a step');
  const bytes = row['bytes'];
  const detail = row['detail'];
  return {
    name: needString(row, 'name'),
    what: needString(row, 'what'),
    action: needString(row, 'action'),
    target: needString(row, 'target'),
    // Optional, and absent is null rather than 0: the target is not a path.
    bytes: typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : null,
    done: needBoolean(row, 'done'),
    refused: readRefusal(row['refused']),
    detail: Array.isArray(detail) ? detail.filter((line): line is string => typeof line === 'string') : null,
  };
}

function readRefusal(raw: unknown): CrucibleUninstallRefusal | null {
  if (raw === undefined || raw === null) return null;
  const row = asObject(raw, 'a refusal');
  return { code: needString(row, 'code'), message: needString(row, 'message'), fatal: needBoolean(row, 'fatal') };
}

function readKept(raw: unknown): CrucibleUninstallKept {
  const row = asObject(raw, 'what the plan keeps');
  const paths = row['paths'];
  if (!Array.isArray(paths)) throw refuse('uninstall_unreadable', "Crucible's uninstall printed no list of kept paths.");
  return {
    weightsBytes: needNumber(row, 'weights_bytes'),
    paths: paths.filter((entry): entry is string => typeof entry === 'string'),
  };
}

function asObject(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw refuse('uninstall_unreadable', `Crucible's uninstall printed ${what} in a shape B-Sides cannot read.`);
  }
  return raw as Record<string, unknown>;
}

function needBoolean(row: Record<string, unknown>, key: string): boolean {
  const value = row[key];
  if (typeof value !== 'boolean') throw missing(key);
  return value;
}

function needString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw missing(key);
  return value;
}

function needNullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw missing(key);
  return value;
}

function needNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw missing(key);
  return value;
}

function missing(key: string): Refusal {
  return refuse(
    'uninstall_unreadable',
    `Crucible's uninstall printed a plan with no readable "${key}" in it, so B-Sides cannot say what it would do.`,
  );
}
