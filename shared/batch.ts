/**
 * batch — the seeds for "Generate N in a row", as the Crucible playground assigns them.
 *
 * A fixed seed becomes seed, seed+1, ... so a run is not one song N times
 * (capped at the server's largest seed); with no seed every job is sent without
 * one and the server draws a fresh one for each.
 */

/** The largest seed the server takes (2^32 - 1). */
export const MAX_SEED = 4294967295;

/** The most jobs one press sends. */
export const MAX_BATCH = 20;

/** `count` clamped to 1..MAX_BATCH; anything that is not a number is 1. */
export function batchCount(count: number): number {
  if (!Number.isFinite(count)) return 1;
  return Math.max(1, Math.min(MAX_BATCH, Math.floor(count)));
}

/** One seed per job, in submission order; null means "let the server choose". */
export function batchSeeds(seed: number | null, count: number): (number | null)[] {
  const total = batchCount(count);
  return Array.from({ length: total }, (_, index) =>
    seed === null ? null : Math.min(seed + index, MAX_SEED),
  );
}
