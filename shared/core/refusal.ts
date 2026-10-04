/**
 * refusal — every failure becomes a `RefusalView` with the server's own code.
 *
 * The SDK raises one error type per failure and carries the server's `code` and
 * `message`; B-Side raises `Refusal` for its own (no server, bad input). This is
 * where any of them is turned into what the screen shows. The desktop adds the
 * installer's own two (electron/refusal.ts), which never run on the phone.
 */
import {
  CrucibleAuthError,
  CrucibleConnectionError,
  CrucibleError,
  CrucibleNotACrucible,
  CruciblePairingError,
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  CrucibleVersionError,
} from '@crucible/client';

import type { RefusalView } from '../types';

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

/** The SDK's errors and B-Side's own; anything else is null, for the caller to name. */
export function crucibleRefusalOf(error: unknown): RefusalView | null {
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
  // Pairing by address: `invalid_address`, `connection_unreachable`, `not_crucible`, `pairing_unavailable`, ...
  if (error instanceof CrucibleConnectionError) return { code: error.code, message: error.message };
  if (error instanceof CrucibleError) return { code: 'crucible_error', message: error.message };
  return null;
}

export function refusalOf(error: unknown): RefusalView {
  const known = crucibleRefusalOf(error);
  if (known !== null) return known;
  if (error instanceof Error) return { code: 'error', message: error.message };
  return { code: 'error', message: String(error) };
}
