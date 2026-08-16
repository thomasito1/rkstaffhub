/**
 * Punch-pairing → daily hours, for the payroll workshop and CSV export.
 * Pure, Firebase-free, symlink-safe into `functions/` (same reasoning as
 * `overtime.ts`).
 *
 * The pairing rule mirrors `shiftsAndTipsShared.ts`'s `buildPunchRows`
 * (client-side, UI-row-building) exactly — FIFO: walk one employee's
 * punches in timestamp order, queue each 'in', and pop the earliest queued
 * one for every 'out' encountered. An 'in' with nothing left to pair (still
 * open) contributes NOTHING — never a fabricated hours total, same
 * forgotten-clockout-safe principle CLAUDE.md/spec §8 already establish.
 * Deliberately a SEPARATE small module rather than importing that one: this
 * file needs to run inside `functions/` too, and `shiftsAndTipsShared.ts`
 * imports `@/lib/format` (i18n bootstrap), which cannot cross that boundary.
 */

export interface PunchLike {
  employeeId: string
  type: 'in' | 'out'
  /** Millis since epoch — caller converts from whatever Timestamp type it holds. */
  timestampMs: number
}

export interface DailyHours {
  date: string
  hours: number
}

/**
 * Pairs punches for ONE employee (caller filters by employeeId first) into
 * daily hours. `isoDateOfMs` is the caller's own restaurant-tz conversion —
 * this module stays timezone-agnostic on purpose, same as `overtime.ts`
 * taking pre-resolved date strings rather than doing tz math itself.
 */
export function bucketPunchesIntoDailyHours(
  punches: PunchLike[],
  isoDateOfMs: (ms: number) => string,
): DailyHours[] {
  const sorted = [...punches].sort((a, b) => a.timestampMs - b.timestampMs)
  const pending: number[] = [] // queued 'in' timestamps, FIFO
  const hoursByDate = new Map<string, number>()

  for (const punch of sorted) {
    if (punch.type === 'in') {
      pending.push(punch.timestampMs)
      continue
    }
    const inMs = pending.shift()
    if (inMs === undefined) continue // an 'out' with nothing pending — ignore, don't fabricate
    const date = isoDateOfMs(inMs)
    const hours = (punch.timestampMs - inMs) / (60 * 60 * 1000)
    hoursByDate.set(date, (hoursByDate.get(date) ?? 0) + hours)
  }

  return Array.from(hoursByDate.entries())
    .map(([date, hours]) => ({ date, hours: Math.round(hours * 100) / 100 }))
    .sort((a, b) => a.date.localeCompare(b.date))
}
