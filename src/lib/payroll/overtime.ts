/**
 * Per-workweek overtime + pay-period allocation — spec §11's own ruled
 * correctness trap: "FLSA computes overtime per WORKWEEK (>40 hrs, fixed
 * Mon–Sun), never by summing hours inside a pay period." Semimonthly
 * periods (5th/20th) never align to week boundaries, so a workweek routinely
 * straddles a period boundary — the only correct order is workweek-first,
 * THEN allocate each day's already-computed regular/OT hours to whichever
 * period that day falls in (see `PROGRESS.md`'s "Semimonthly pay periods vs.
 * per-workweek overtime" note, ruled well before this module existed).
 *
 * Pure, Firebase-free — mirrors `fulfillment.ts`/`tradeEligibility.ts`'s
 * shape (plain data in, typed results out) so it can symlink into
 * `functions/` (the CSV export Cloud Function needs the exact same math) the
 * way `tradeEligibility.ts` already does. `weekIdForIsoDate`/
 * `addDaysToIsoDate` below are a deliberate small duplicate of
 * `src/lib/deadlines.ts`'s own versions rather than an import — deadlines.ts
 * pulls in `format.ts`'s `intlLocale`/i18n bootstrap transitively, which has
 * no business running at a Cloud Function's cold start (same reasoning
 * `punchHelpers.ts`/`availabilityHelpers.ts` already document for their own
 * copies). Keep byte-for-byte identical to `deadlines.ts`'s versions if
 * either ever changes.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000

function parseIsoDate(isoDate: string): { year: number; month: number; day: number } {
  const parts = isoDate.split('-').map(Number)
  return { year: parts[0] ?? 0, month: parts[1] ?? 1, day: parts[2] ?? 1 }
}

export function addDaysToIsoDate(isoDate: string, days: number): string {
  const { year, month, day } = parseIsoDate(isoDate)
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY)
  return shifted.toISOString().slice(0, 10)
}

/** The Mon-start weekId (matching `Schedule.weekId`) that `isoDate` falls in. */
export function weekIdForIsoDate(isoDate: string): string {
  const { year, month, day } = parseIsoDate(isoDate)
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return addDaysToIsoDate(isoDate, utcDay === 0 ? -6 : 1 - utcDay)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export interface DailyHours {
  /** Restaurant-local "YYYY-MM-DD" — the calendar day a punch pair's hours are attributed to (the 'in' punch's own date; a shift crossing midnight is rare enough in this app's own hours that splitting it across two calendar days is not modeled). */
  date: string
  hours: number
}

export interface DayOtSplit {
  date: string
  regularHours: number
  otHours: number
}

export interface PeriodAllocation {
  regularHours: number
  otHours: number
}

/**
 * Splits ONE Mon-Sun workweek's daily hours into regular/OT, attributing the
 * OT portion by chronological order within the week: the first 40
 * cumulative hours are regular regardless of which day they fall on: a day
 * that crosses the 40h mark is itself split (part regular, part OT), and
 * every day after is entirely OT. Caller's responsibility to pass only ONE
 * workweek's days — see `groupDailyHoursByWorkweek`.
 */
export function splitOvertimeForWorkweek(dailyHours: DailyHours[]): DayOtSplit[] {
  const sorted = [...dailyHours].sort((a, b) => a.date.localeCompare(b.date))
  let cumulative = 0
  return sorted.map((d) => {
    const before = cumulative
    cumulative += d.hours
    const regular = Math.max(0, Math.min(d.hours, 40 - before))
    const ot = d.hours - regular
    return { date: d.date, regularHours: round2(regular), otHours: round2(ot) }
  })
}

/** Buckets arbitrary daily-hours entries by the Mon-Sun workweek each date falls in. */
export function groupDailyHoursByWorkweek(dailyHours: DailyHours[]): Map<string, DailyHours[]> {
  const map = new Map<string, DailyHours[]>()
  for (const d of dailyHours) {
    const weekId = weekIdForIsoDate(d.date)
    const list = map.get(weekId)
    if (list) list.push(d)
    else map.set(weekId, [d])
  }
  return map
}

/** Every workweek (by its Monday weekId) that overlaps `[periodStart, periodEnd]`, even partially. */
export function workweeksCoveringPeriod(periodStart: string, periodEnd: string): string[] {
  const weekIds: string[] = []
  let cursor = weekIdForIsoDate(periodStart)
  const lastWeekId = weekIdForIsoDate(periodEnd)
  while (cursor <= lastWeekId) {
    weekIds.push(cursor)
    cursor = addDaysToIsoDate(cursor, 7)
  }
  return weekIds
}

/**
 * The widened `[start, end]` date range covering every WHOLE workweek that
 * touches the period — never a partial one, since a workweek's OT split
 * cannot be computed correctly from only part of its days. Use this to
 * bound the punches query that feeds `allocateHoursToPeriod`, not the raw
 * period dates.
 */
export function workweekRangeCoveringPeriod(
  periodStart: string,
  periodEnd: string,
): { start: string; end: string } {
  const weekIds = workweeksCoveringPeriod(periodStart, periodEnd)
  const firstWeekId = weekIds[0] ?? weekIdForIsoDate(periodStart)
  const lastWeekId = weekIds[weekIds.length - 1] ?? weekIdForIsoDate(periodEnd)
  return { start: firstWeekId, end: addDaysToIsoDate(lastWeekId, 6) }
}

/**
 * The full pipeline: bucket `dailyHours` into workweeks, split OT within
 * EACH workweek independently using its COMPLETE set of days (the caller
 * must supply hours for the full `workweekRangeCoveringPeriod`, not just the
 * period's own dates), then sum the regular/OT hours whose date falls
 * within `[periodStart, periodEnd]` inclusive. This is what correctly
 * allows a single workweek's hours to split across two periods while each
 * period's own OT figure stays exactly right — proven in this module's own
 * test file against a workweek straddling a period boundary.
 */
export function allocateHoursToPeriod(
  dailyHours: DailyHours[],
  periodStart: string,
  periodEnd: string,
): PeriodAllocation {
  const byWeek = groupDailyHoursByWorkweek(dailyHours)
  let regularHours = 0
  let otHours = 0
  for (const weekDailyHours of byWeek.values()) {
    const splits = splitOvertimeForWorkweek(weekDailyHours)
    for (const s of splits) {
      if (s.date < periodStart || s.date > periodEnd) continue
      regularHours += s.regularHours
      otHours += s.otHours
    }
  }
  return { regularHours: round2(regularHours), otHours: round2(otHours) }
}
