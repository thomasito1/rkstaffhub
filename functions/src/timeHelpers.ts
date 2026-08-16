/**
 * Restaurant-timezone instant math for `tradeScheduled.ts`'s 48h direct-trade
 * expiry sweep (`instantAtShiftStart`, half of its `min(expiresAt, shift
 * start)` rule).
 *
 * A deliberate small duplicate of `availabilityHelpers.ts`'s own
 * `instantAtRestaurantWallClock` (itself a deliberate duplicate of
 * `src/lib/deadlines.ts`) — NOT the "one shared implementation" case, for the
 * same reason already documented there: this is pure calendar/timezone math
 * with no Firebase-free src/lib home that both this package and the client
 * can import across the `functions/` build-root boundary. Keep the two-pass
 * DST resolution byte-for-byte identical if either ever changes.
 */

const RESTAURANT_TZ = 'America/New_York'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const HH_MM = /^\d{2}:\d{2}$/

function parseIsoDate(isoDate: string): { year: number; month: number; day: number } {
  if (!ISO_DATE.test(isoDate)) {
    throw new Error(`Expected an ISO date "YYYY-MM-DD", got "${isoDate}"`)
  }
  const [y, m, d] = isoDate.split('-')
  return { year: Number(y), month: Number(m), day: Number(d) }
}

function parseHhMm(hhmm: string): { hour: number; minute: number } {
  if (!HH_MM.test(hhmm)) {
    throw new Error(`Expected an "HH:mm" time, got "${hhmm}"`)
  }
  const [h, m] = hhmm.split(':')
  return { hour: Number(h), minute: Number(m) }
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

/** The instant at which the restaurant's wall clock reads the given date+time — two-pass DST resolution. */
export function instantAtRestaurantWallClock(isoDate: string, hour: number, minute: number): Date {
  const { year, month, day } = parseIsoDate(isoDate)
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  const firstGuess = naiveUtc - tzOffsetMsAt(naiveUtc)
  return new Date(naiveUtc - tzOffsetMsAt(firstGuess))
}

/** A shift's own start instant, from its restaurant-local `date` + "HH:mm" `startTime`. */
export function instantAtShiftStart(date: string, startTime: string): Date {
  const { hour, minute } = parseHhMm(startTime)
  return instantAtRestaurantWallClock(date, hour, minute)
}
