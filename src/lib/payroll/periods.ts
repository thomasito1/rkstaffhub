/**
 * Semimonthly pay-period generator — Rafa's ruling (Aug 2026), superseding
 * whatever convention the seed used before it: periods are the calendar
 * halves 1st–15th and 16th–end-of-month, paid on the 20th (for 1–15) and the
 * 5th of the FOLLOWING month (for 16–EOM). This is deliberately decoupled
 * from `overtime.ts`'s FLSA engine — that module only ever takes a plain
 * `[periodStart, periodEnd]` string range and has no opinion on how those
 * bounds were chosen, so it needs no changes for this ruling; confirmed by
 * reading it end to end, not just assumed (see PROGRESS.md).
 *
 * Pure, Firebase-free, symlink-safe into `functions/` (same shape as
 * `overtime.ts`/`payrollRows.ts`).
 */

function parseIsoDate(isoDate: string): { year: number; month: number; day: number } {
  const parts = isoDate.split('-').map(Number)
  return { year: parts[0] ?? 0, month: parts[1] ?? 1, day: parts[2] ?? 1 }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** The number of days in `month` (1-indexed) of `year`. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

export interface SemimonthlyPeriodBounds {
  startDate: string
  endDate: string
  payDate: string
}

/** The semimonthly period (and its pay date) that `isoDate` falls within. */
export function semimonthlyPeriodForDate(isoDate: string): SemimonthlyPeriodBounds {
  const { year, month, day } = parseIsoDate(isoDate)

  if (day <= 15) {
    return {
      startDate: `${year}-${pad2(month)}-01`,
      endDate: `${year}-${pad2(month)}-15`,
      payDate: `${year}-${pad2(month)}-20`,
    }
  }

  const lastDay = daysInMonth(year, month)
  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  return {
    startDate: `${year}-${pad2(month)}-16`,
    endDate: `${year}-${pad2(month)}-${pad2(lastDay)}`,
    payDate: `${nextYear}-${pad2(nextMonth)}-05`,
  }
}

/** The period's own `startDate` as its Firestore document id — matches this codebase's existing `weekId`-as-doc-id convention. */
export function periodIdForDate(isoDate: string): string {
  return semimonthlyPeriodForDate(isoDate).startDate
}

/**
 * The pay date for an existing period, given its own `startDate` — a
 * computed DISPLAY value (Workshop header, CSV exports), never stored on
 * the `PayPeriod` doc itself, so it can never drift from the one true rule
 * above.
 */
export function payDateForPeriod(startDate: string): string {
  return semimonthlyPeriodForDate(startDate).payDate
}

/** The period immediately following the one ending on `currentEndDate` (must be a real period end — the 15th or the last day of its month). */
export function nextSemimonthlyPeriod(currentEndDate: string): SemimonthlyPeriodBounds {
  const { year, month, day } = parseIsoDate(currentEndDate)

  if (day === 15) {
    return semimonthlyPeriodForDate(`${year}-${pad2(month)}-16`)
  }

  const nextMonth = month === 12 ? 1 : month + 1
  const nextYear = month === 12 ? year + 1 : year
  return semimonthlyPeriodForDate(`${nextYear}-${pad2(nextMonth)}-01`)
}
