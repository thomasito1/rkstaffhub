/**
 * Availability deadline math — spec §5's Thursday 23:59 ET lock.
 *
 * A deliberate small duplicate of `src/lib/deadlines.ts`'s `isAvailabilityLocked`/
 * `availabilityDeadlineFor` and their own dependencies, NOT a case the "one
 * shared implementation" ruling (`tradeEligibility.ts`) covers — deadlines.ts
 * imports `RESTAURANT_TZ`/`weekIdFor` from `src/lib/format.ts`, which itself
 * imports `intlLocale` from `src/i18n` (react-i18next bootstrapping) at module
 * top level. That has no business running at a Cloud Function's cold start,
 * and deadlines.ts is otherwise pure calendar/timezone math — the same
 * reasoning `punchHelpers.ts`'s `weekIdForIsoDate` duplicate already
 * documents. Keep these byte-for-byte identical to deadlines.ts's versions
 * if either ever changes; `deadlines.test.ts` is these functions' real test
 * coverage.
 */

const RESTAURANT_TZ = 'America/New_York'
const DEADLINE_HOUR = 23
const DEADLINE_MINUTE = 59
/** Days back from a week's Monday to the previous week's Thursday. */
const DAYS_BACK_TO_PREV_THURSDAY = 4
const MS_PER_DAY = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function parseIsoDate(isoDate: string): { year: number; month: number; day: number } {
  if (!ISO_DATE.test(isoDate)) {
    throw new Error(`Expected an ISO date "YYYY-MM-DD", got "${isoDate}"`)
  }
  const [y, m, d] = isoDate.split('-')
  return { year: Number(y), month: Number(m), day: Number(d) }
}

function addDaysToIsoDate(isoDate: string, days: number): string {
  const { year, month, day } = parseIsoDate(isoDate)
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY)
  return shifted.toISOString().slice(0, 10)
}

const tzFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: RESTAURANT_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

/** How far the restaurant's wall clock is ahead of UTC at a given instant, in ms. */
function tzOffsetMsAt(instantMs: number): number {
  const parts = tzFormatter.formatToParts(new Date(instantMs))
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type)
    if (!part) throw new Error(`Intl did not return a "${type}" part for ${RESTAURANT_TZ}`)
    return Number(part.value)
  }
  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  )
  return asUtc - instantMs
}

/** The instant at which the restaurant's wall clock reads the given date+time — two-pass DST resolution, see deadlines.ts. */
function instantAtRestaurantWallClock(isoDate: string, hour: number, minute: number): Date {
  const { year, month, day } = parseIsoDate(isoDate)
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  const firstGuess = naiveUtc - tzOffsetMsAt(naiveUtc)
  return new Date(naiveUtc - tzOffsetMsAt(firstGuess))
}

/** Availability for `weekId` locks at Thursday 23:59 ET of the PRECEDING week (spec §5). */
export function availabilityDeadlineFor(weekId: string): Date {
  return instantAtRestaurantWallClock(
    addDaysToIsoDate(weekId, -DAYS_BACK_TO_PREV_THURSDAY),
    DEADLINE_HOUR,
    DEADLINE_MINUTE,
  )
}

/** Locked from the deadline instant onward (`now >= deadline`), inclusive — same boundary as deadlines.ts. */
export function isAvailabilityLocked(weekId: string, now: Date): boolean {
  return now.getTime() >= availabilityDeadlineFor(weekId).getTime()
}
