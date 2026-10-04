/**
 * refusal — the shared core's (shared/core/refusal.ts), plus the desktop's
 * installer: `@crucible/bootstrap` (installing Crucible on this computer) raises
 * its own two, which the phone never loads.
 */
import { BootstrapRefusal, LocalInstallationError } from '@crucible/bootstrap';

import { crucibleRefusalOf, Refusal } from '../shared/core/refusal';
import type { Outcome, RefusalView } from '../shared/types';

export { Refusal };

export function refusalOf(error: unknown): RefusalView {
  const known = crucibleRefusalOf(error);
  if (known !== null) return known;
  // Installing Crucible on this computer: the installer's own names (`release_channel_unreadable`,
  // `host_unreachable`, `step_failed`, ...) and its sentences, which already say what to do.
  if (error instanceof BootstrapRefusal || error instanceof LocalInstallationError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) return { code: 'error', message: error.message };
  return { code: 'error', message: String(error) };
}

/** Run `work` and answer the bridge with its value or its refusal. */
export async function answer<T>(work: () => Promise<T> | T): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, refusal: refusalOf(error) };
  }
}
