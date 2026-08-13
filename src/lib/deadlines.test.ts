/**
 * Deadline math — spec §5, §6.
 *
 * The point of these tests is DST. Every deadline is asserted twice: once as an
 * absolute UTC instant (the number that actually decides whether a submission
 * is locked) and once as the New York wall clock that instant lands on (the
 * promise made to staff). A regression that hard-codes UTC-5, or that leans on
 * the device timezone, breaks one of the two.
 *
 * 2026 US transitions: DST starts Sun Mar 8, ends Sun Nov 1.
 */

import { describe, expect, it } from 'vitest'

import {
  addDaysToIsoDate,
  availabilityDeadlineFor,
  datesForWeekId,
  isAvailabilityLocked,
  isPublishOverdue,
  openAvailabilityWeekId,
  publishDeadlineFor,
  weekIdForIsoDate,
  weekIdsBetween,
} from './deadlines'
import { RESTAURANT_TZ } from './format'

/** What a New York clock reads at a given instant — the staff-facing truth. */
function newYorkWallClock(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: RESTAURANT_TZ,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

describe('availabilityDeadlineFor — Thursday 23:59 ET of the preceding week', () => {
  it('lands on the Thursday before the week, at 23:59 New York time', () => {
    const d = availabilityDeadlineFor('2026-08-10')
    expect(newYorkWallClock(d)).toBe('Thu, 08/06/2026, 23:59')
  })

  it('is EST (UTC-5) for a deadline before the spring transition', () => {
    // Week of Mon Mar 9 2026; deadline Thu Mar 5, still standard time.
    const d = availabilityDeadlineFor('2026-03-09')
    expect(newYorkWallClock(d)).toBe('Thu, 03/05/2026, 23:59')
    expect(d.toISOString()).toBe('2026-03-06T04:59:00.000Z')
  })

  it('is EDT (UTC-4) for the very next week, after DST starts Mar 8', () => {
    // Week of Mon Mar 16 2026; deadline Thu Mar 12 — one hour less from UTC.
    const d = availabilityDeadlineFor('2026-03-16')
    expect(newYorkWallClock(d)).toBe('Thu, 03/12/2026, 23:59')
    expect(d.toISOString()).toBe('2026-03-13T03:59:00.000Z')
  })

  it('is EDT (UTC-4) for the last deadline before DST ends Nov 1', () => {
    // Week of Mon Nov 2 2026; deadline Thu Oct 29, still daylight time.
    const d = availabilityDeadlineFor('2026-11-02')
    expect(newYorkWallClock(d)).toBe('Thu, 10/29/2026, 23:59')
    expect(d.toISOString()).toBe('2026-10-30T03:59:00.000Z')
  })

  it('is EST (UTC-5) again for the week after DST ends', () => {
    // Week of Mon Nov 9 2026; deadline Thu Nov 5, back on standard time.
    const d = availabilityDeadlineFor('2026-11-09')
    expect(newYorkWallClock(d)).toBe('Thu, 11/05/2026, 23:59')
    expect(d.toISOString()).toBe('2026-11-06T04:59:00.000Z')
  })

  it('the two sides of each transition are 168h apart in wall clock but not in UTC', () => {
    const before = availabilityDeadlineFor('2026-03-09').getTime()
    const after = availabilityDeadlineFor('2026-03-16').getTime()
    // A naive "+7 days" implementation would give exactly 168h here and be an
    // hour wrong on the far side; the spring-forward week is 167h.
    expect(after - before).toBe(167 * 3_600_000)

    const fallBefore = availabilityDeadlineFor('2026-11-02').getTime()
    const fallAfter = availabilityDeadlineFor('2026-11-09').getTime()
    expect(fallAfter - fallBefore).toBe(169 * 3_600_000)
  })
})

describe('publishDeadlineFor — Friday 23:59 ET of the preceding week', () => {
  it('lands on the Friday before the week', () => {
    const d = publishDeadlineFor('2026-08-10')
    expect(newYorkWallClock(d)).toBe('Fri, 08/07/2026, 23:59')
  })

  it('holds 23:59 local across both 2026 transitions', () => {
    expect(newYorkWallClock(publishDeadlineFor('2026-03-09'))).toBe('Fri, 03/06/2026, 23:59')
    expect(publishDeadlineFor('2026-03-09').toISOString()).toBe('2026-03-07T04:59:00.000Z')

    expect(newYorkWallClock(publishDeadlineFor('2026-03-16'))).toBe('Fri, 03/13/2026, 23:59')
    expect(publishDeadlineFor('2026-03-16').toISOString()).toBe('2026-03-14T03:59:00.000Z')

    expect(newYorkWallClock(publishDeadlineFor('2026-11-02'))).toBe('Fri, 10/30/2026, 23:59')
    expect(publishDeadlineFor('2026-11-02').toISOString()).toBe('2026-10-31T03:59:00.000Z')

    expect(newYorkWallClock(publishDeadlineFor('2026-11-09'))).toBe('Fri, 11/06/2026, 23:59')
    expect(publishDeadlineFor('2026-11-09').toISOString()).toBe('2026-11-07T04:59:00.000Z')
  })

  it('always falls exactly 24h after the availability lock', () => {
    for (const weekId of ['2026-03-09', '2026-03-16', '2026-08-10', '2026-11-02', '2026-11-09']) {
      const gap = publishDeadlineFor(weekId).getTime() - availabilityDeadlineFor(weekId).getTime()
      expect(gap).toBe(24 * 3_600_000)
    }
  })
})

describe('isAvailabilityLocked', () => {
  const weekId = '2026-08-10'
  const deadline = availabilityDeadlineFor(weekId)

  it('is open a minute before the deadline', () => {
    expect(isAvailabilityLocked(weekId, new Date(deadline.getTime() - 60_000))).toBe(false)
  })

  it('locks at the deadline instant itself', () => {
    expect(isAvailabilityLocked(weekId, new Date(deadline.getTime()))).toBe(true)
    expect(isAvailabilityLocked(weekId, new Date(deadline.getTime() - 1))).toBe(false)
  })

  it('stays locked afterwards', () => {
    expect(isAvailabilityLocked(weekId, new Date(deadline.getTime() + 86_400_000))).toBe(true)
  })

  it('does not shift by an hour across the fall-back weekend', () => {
    // Thu Nov 5 2026 23:58 EST — open. One minute later — locked.
    expect(isAvailabilityLocked('2026-11-09', new Date('2026-11-06T04:58:00Z'))).toBe(false)
    expect(isAvailabilityLocked('2026-11-09', new Date('2026-11-06T04:59:00Z'))).toBe(true)
  })

  it('does not shift by an hour across the spring-forward weekend', () => {
    // Thu Mar 12 2026 23:58 EDT — open. One minute later — locked.
    expect(isAvailabilityLocked('2026-03-16', new Date('2026-03-13T03:58:00Z'))).toBe(false)
    expect(isAvailabilityLocked('2026-03-16', new Date('2026-03-13T03:59:00Z'))).toBe(true)
  })
})

describe('isPublishOverdue', () => {
  it('flips at Friday 23:59 ET', () => {
    expect(isPublishOverdue('2026-08-10', new Date('2026-08-08T03:58:00Z'))).toBe(false)
    expect(isPublishOverdue('2026-08-10', new Date('2026-08-08T03:59:00Z'))).toBe(true)
  })
})

describe('openAvailabilityWeekId', () => {
  it('is next week while this week is still open', () => {
    // Wed Aug 5 2026, 18:00 ET — the Thursday lock for Aug 10 has not passed.
    expect(openAvailabilityWeekId(new Date('2026-08-05T22:00:00Z'))).toBe('2026-08-10')
  })

  it('rolls forward once the Thursday lock passes', () => {
    // Fri Aug 7 2026, 10:00 ET — Aug 10 is locked, staff now submit for Aug 17.
    expect(openAvailabilityWeekId(new Date('2026-08-07T14:00:00Z'))).toBe('2026-08-17')
  })
})

describe('ISO date helpers', () => {
  it('adds days without tripping over DST or month ends', () => {
    expect(addDaysToIsoDate('2026-03-07', 1)).toBe('2026-03-08') // spring forward
    expect(addDaysToIsoDate('2026-03-08', 1)).toBe('2026-03-09')
    expect(addDaysToIsoDate('2026-11-01', 1)).toBe('2026-11-02') // fall back
    expect(addDaysToIsoDate('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDaysToIsoDate('2028-02-28', 1)).toBe('2028-02-29') // leap year
    expect(addDaysToIsoDate('2026-01-01', -1)).toBe('2025-12-31')
    expect(addDaysToIsoDate('2026-08-10', 7)).toBe('2026-08-17')
  })

  it('expands a weekId into its seven Mon–Sun dates', () => {
    expect(datesForWeekId('2026-08-10')).toEqual([
      '2026-08-10',
      '2026-08-11',
      '2026-08-12',
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
    ])
  })

  it('maps a date to its Monday without touching the device timezone', () => {
    expect(weekIdForIsoDate('2026-08-10')).toBe('2026-08-10') // Monday itself
    expect(weekIdForIsoDate('2026-08-16')).toBe('2026-08-10') // Sunday belongs to the week it ends
    expect(weekIdForIsoDate('2026-08-09')).toBe('2026-08-03') // previous Sunday
    expect(weekIdForIsoDate('2026-01-01')).toBe('2025-12-29') // week spanning the year
  })

  it('lists every week a date range touches', () => {
    expect(weekIdsBetween('2026-08-12', '2026-08-13')).toEqual(['2026-08-10'])
    expect(weekIdsBetween('2026-08-14', '2026-08-24')).toEqual([
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
    ])
    // Reversed range: no weeks, no infinite loop.
    expect(weekIdsBetween('2026-08-24', '2026-08-10')).toEqual([])
  })

  it('rejects a malformed week id rather than silently returning Invalid Date', () => {
    expect(() => availabilityDeadlineFor('2026-8-10')).toThrow(/ISO date/)
    expect(() => addDaysToIsoDate('', 1)).toThrow(/ISO date/)
  })
})
