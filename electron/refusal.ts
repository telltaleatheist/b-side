/**
 * refusal — every failure becomes a `RefusalView` with the server's own code.
 *
 * The SDK raises one error type per failure and carries the server's `code` and
 * `message`; the playground routes (which the SDK has no helper for) raise
 * `PlaygroundRefusal` the same way. This is the one place either is turned into
 * what the screen shows.
 */
import {
  CrucibleAuthError,
  CrucibleError,
  CrucibleNotACrucible,
  CruciblePairingError,
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  CrucibleVersionError,
} from '@crucible/client';

import type { Outcome, RefusalView } from '../shared/types';

/** A refusal B-Side raises itself (no server, bad input), or one read off a playground route. */
export class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

export function refusalOf(error: unknown): RefusalView {
  if (error instanceof Refusal) return { code: error.code, message: error.message };
  if (error instanceof CrucibleRefused || error instanceof CrucibleServerError) {
    return { code: error.code, message: error.serverMessage };
  }
  if (error instanceof CrucibleAuthError) {
    return { code: error.code, message: `${error.serverMessage} (the token for this server is wrong or missing)` };
  }
  if (error instanceof CrucibleVersionError) {
    return { code: error.code, message: error.serverMessage };
  }
  if (error instanceof CrucibleUnreachable) return { code: 'unreachable', message: error.message };
  if (error instanceof CrucibleNotACrucible) return { code: 'not_a_crucible', message: error.message };
  if (error instanceof CruciblePairingError) return { code: 'invalid_pairing', message: error.message };
  if (error instanceof CrucibleError) return { code: 'crucible_error', message: error.message };
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
