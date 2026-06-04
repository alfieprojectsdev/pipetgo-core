/**
 * ITA 2023 dispute window — clients have 14 days from order completion
 * to open a dispute. Constant lives in the domain layer so slice code
 * does not inline magic numbers.
 */

export const DISPUTE_WINDOW_DAYS = 14

/**
 * Returns true if `now` falls within DISPUTE_WINDOW_DAYS of `completedAt`.
 * Pure (no I/O); accepts an explicit `now` for deterministic unit testing.
 * A null completedAt is not accepted here — callers guard that case first (ref: DL-010).
 * A `completedAt` in the future (clock skew / malformed timestamp) is NOT within the
 * window — the elapsed time must be non-negative as well as within the bound.
 */
export function isWithinDisputeWindow(completedAt: Date, now: Date): boolean {
  const windowMs = DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const elapsedMs = now.getTime() - completedAt.getTime()
  return elapsedMs >= 0 && elapsedMs <= windowMs
}
