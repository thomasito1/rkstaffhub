/**
 * Schedule deadlines — spec §5, §6.
 *
 * Two fixed weekly deadlines, both in RESTAURANT LOCAL TIME:
 *   • availability for the following week locks  **Thursday 23:59 America/New_York**
 *   • the following week's schedule is published **Friday 23:59 America/New_York**
 *
 * WHY THIS FILE EXISTS. A deadline is a wall-clock promise made to the staff
 * standing in the restaurant, not to the device in their pocket. A cook opening
 * the PWA on a phone still set to Bogotá, or a manager on a laptop in Vegas,
 * must see the same lock at the same instant as the person in Miramar. So every
 * deadline is computed as an ABSOLUTE INSTANT derived from a New York wall
 * clock, never from the device's local fields.
 *
 * DST is the whole difficulty. America/New_York is UTC-5 in winter and UTC-4 in
 * summer, so "Thursday 23:59" is a different number of milliseconds past the
 * epoch depending on the week. We resolve the offset per instant via Intl —
 * which carries the real tzdata — rather than hard-coding -5/-4, so the day the
 * DST rules change we inherit the fix instead of shipping a bug. See
 * deadlines.test.ts for both 2026 transitions.
 *
 * Pure module: no Firestore, no clock reads. `now` is always passed in.
 */

import { RESTAURANT_TZ, weekIdFor } from '@/lib/format'

/** Re-exported so callers get week keys and deadlines from one import. */
export { weekIdFor }

/** Spec §5. Also mirrored in settings/app.availabilityDeadline. */
export const AVAILABILITY_DEADLINE_WEEKDAY = 'thursday'
/** Spec §6. Also mirrored in settings/app.publishDeadline. */
export const PUBLISH_DEADLINE_WEEKDAY = 'friday'
export const DEADLINE_HOUR = 23
export const DEADLINE_MINUTE = 59

/** Days back from a week's Monday to the previous week's Thursday / Friday. */
const DAYS_BACK_TO_PREV_THURSDAY = 4
const DAYS_BACK_TO_PREV_FRIDAY = 3

const MS_PER_DAY = 86_400_000

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function parseIsoDate(isoDate: string): { year: number; month: number; day: number } {
  if (!ISO_DATE.test(isoDate)) {
    throw new Error(`Expected an ISO date "YYYY-MM-DD", got "${isoDate}"`)
  }
  const [y, m, d] = isoDate.split('-')
  // The regex above guarantees three parts; Number('') would be 0, not NaN.
  return { year: Number(y), month: Number(m), day: Number(d) }
}

/**
 * Calendar arithmetic on a plain "YYYY-MM-DD" string, done in UTC so it is
 * immune to both the device timezone and DST — a calendar day is a calendar
 * day. Exported because copyWeekFrom() needs exactly this and must not grow its
 * own copy of it.
 */
export function addDaysToIsoDate(isoDate: string, days: number): string {
  const { year, month, day } = parseIsoDate(isoDate)
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY)
  return shifted.toISOString().slice(0, 10)
}

/** The seven "YYYY-MM-DD" dates of a week, Mon→Sun. */
export function datesForWeekId(weekId: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDaysToIsoDate(weekId, i))
}

/**
 * The weekId a calendar date belongs to, from the string alone.
 *
 * Distinct from format.ts's weekIdFor(Date), which reads a Date's LOCAL
 * calendar fields — feeding it `new Date('2026-08-10')` (parsed as UTC
 * midnight) would yield Aug 9 west of Greenwich and silently pick the wrong
 * week. Stored dates are plain "YYYY-MM-DD" strings with no instant attached,
 * so they get string math and no timezone at all.
 */
export function weekIdForIsoDate(isoDate: string): string {
  const { year, month, day } = parseIsoDate(isoDate)
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  // getUTCDay: 0=Sun..6=Sat → step back to the Monday that starts the week.
  return addDaysToIsoDate(isoDate, utcDay === 0 ? -6 : 1 - utcDay)
}

/** Every weekId touched by an inclusive date range — the weeks to scan. */
export function weekIdsBetween(startIsoDate: string, endIsoDate: string): string[] {
  const last = weekIdForIsoDate(endIsoDate)
  const out: string[] = []
  let cursor = weekIdForIsoDate(startIsoDate)
  // Ranges are days-to-weeks long in practice; the cap stops a reversed or
  // absurd range from spinning forever.
  for (let i = 0; cursor <= last && i < 520; i += 1) {
    out.push(cursor)
    cursor = addDaysToIsoDate(cursor, 7)
  }
  return out
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

/**
 * How far the restaurant's wall clock is ahead of UTC at a given instant, in ms
 * (negative for New York: -5h in EST, -4h in EDT).
 */
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

/**
 * The instant at which the restaurant's wall clock reads the given date+time.
 *
 * Two passes: guess with the offset in force at the naive-UTC instant, then
 * re-resolve the offset at that guess. The second pass is what makes a deadline
 * that sits on the far side of a DST transition from its own naive reading come
 * out right. 23:59 never falls in a DST gap (the US transitions at 02:00), so
 * no third pass or ambiguity handling is needed at these times.
 */
function instantAtRestaurantWallClock(
  isoDate: string,
  hour: number,
  minute: number,
): Date {
  const { year, month, day } = parseIsoDate(isoDate)
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  const firstGuess = naiveUtc - tzOffsetMsAt(naiveUtc)
  return new Date(naiveUtc - tzOffsetMsAt(firstGuess))
}

/**
 * Availability for `weekId` locks at Thursday 23:59 ET of the PRECEDING week —
 * i.e. four days before that week's Monday (spec §5).
 *
 * After this instant staff see the week locked; managers holding
 * `availability.approve` can still edit on their behalf, which is a permission
 * question, not a time question, and is enforced in the rules — not here.
 */
export function availabilityDeadlineFor(weekId: string): Date {
  return instantAtRestaurantWallClock(
    addDaysToIsoDate(weekId, -DAYS_BACK_TO_PREV_THURSDAY),
    DEADLINE_HOUR,
    DEADLINE_MINUTE,
  )
}

/**
 * Target publish instant for `weekId` — Friday 23:59 ET of the preceding week,
 * three days before that week's Monday (spec §6). Drives the draft countdown
 * banner; nothing enforces it, publishing late is allowed.
 */
export function publishDeadlineFor(weekId: string): Date {
  return instantAtRestaurantWallClock(
    addDaysToIsoDate(weekId, -DAYS_BACK_TO_PREV_FRIDAY),
    DEADLINE_HOUR,
    DEADLINE_MINUTE,
  )
}

/**
 * Locked from the deadline instant onward (`now >= deadline`): when the
 * restaurant's clock reads 23:59 on Thursday, submissions are closed. The
 * boundary is inclusive so the banner and the lock agree on the displayed
 * minute rather than disagreeing for 59 seconds.
 */
export function isAvailabilityLocked(weekId: string, now: Date): boolean {
  return now.getTime() >= availabilityDeadlineFor(weekId).getTime()
}

/** True once the publish target for `weekId` has passed (banner turns red). */
export function isPublishOverdue(weekId: string, now: Date): boolean {
  return now.getTime() >= publishDeadlineFor(weekId).getTime()
}

/**
 * The week staff are currently submitting availability for: next week, until
 * its Thursday 23:59 lock, after which the open week rolls forward.
 */
export function openAvailabilityWeekId(now: Date): string {
  const nextWeek = addDaysToIsoDate(weekIdFor(now), 7)
  return isAvailabilityLocked(nextWeek, now) ? addDaysToIsoDate(nextWeek, 7) : nextWeek
}
