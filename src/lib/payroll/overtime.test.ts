import { describe, expect, it } from 'vitest'

import {
  allocateHoursToPeriod,
  groupDailyHoursByWorkweek,
  splitOvertimeForWorkweek,
  weekIdForIsoDate,
  workweekRangeCoveringPeriod,
  workweeksCoveringPeriod,
  type DailyHours,
} from './overtime'

describe('weekIdForIsoDate', () => {
  it('resolves a date to its own Mon-start week', () => {
    expect(weekIdForIsoDate('2026-08-10')).toBe('2026-08-10') // Monday itself
    expect(weekIdForIsoDate('2026-08-16')).toBe('2026-08-10') // Sunday
    expect(weekIdForIsoDate('2026-08-12')).toBe('2026-08-10') // Wednesday
  })
})

describe('splitOvertimeForWorkweek', () => {
  it('is all regular when the week totals 40h or less', () => {
    const days: DailyHours[] = [
      { date: '2026-08-10', hours: 8 },
      { date: '2026-08-11', hours: 8 },
      { date: '2026-08-12', hours: 8 },
      { date: '2026-08-13', hours: 8 },
      { date: '2026-08-14', hours: 8 },
    ]
    const split = splitOvertimeForWorkweek(days)
    expect(split.every((d) => d.otHours === 0)).toBe(true)
    expect(split.reduce((s, d) => s + d.regularHours, 0)).toBe(40)
  })

  it('splits the SPECIFIC day that crosses the 40h threshold, not the whole day', () => {
    // Mon-Thu 8h each = 32h cumulative. Fri 10h crosses 40 at the 8h mark:
    // 8h of Friday is regular (bringing the week to 40), 2h is OT.
    const days: DailyHours[] = [
      { date: '2026-08-10', hours: 8 },
      { date: '2026-08-11', hours: 8 },
      { date: '2026-08-12', hours: 8 },
      { date: '2026-08-13', hours: 8 },
      { date: '2026-08-14', hours: 10 },
    ]
    const split = splitOvertimeForWorkweek(days)
    const friday = split.find((d) => d.date === '2026-08-14')
    expect(friday).toEqual({ date: '2026-08-14', regularHours: 8, otHours: 2 })
  })

  it('is entirely OT for a day that starts after the week has already hit 40h', () => {
    const days: DailyHours[] = [
      { date: '2026-08-10', hours: 8 },
      { date: '2026-08-11', hours: 8 },
      { date: '2026-08-12', hours: 8 },
      { date: '2026-08-13', hours: 8 },
      { date: '2026-08-14', hours: 8 }, // exactly 40 by end of Friday
      { date: '2026-08-15', hours: 6 }, // Saturday — all OT
    ]
    const split = splitOvertimeForWorkweek(days)
    const saturday = split.find((d) => d.date === '2026-08-15')
    expect(saturday).toEqual({ date: '2026-08-15', regularHours: 0, otHours: 6 })
  })

  it('sorts input by date before splitting, regardless of input order', () => {
    const days: DailyHours[] = [
      { date: '2026-08-14', hours: 10 },
      { date: '2026-08-10', hours: 8 },
      { date: '2026-08-13', hours: 8 },
      { date: '2026-08-12', hours: 8 },
      { date: '2026-08-11', hours: 8 },
    ]
    const split = splitOvertimeForWorkweek(days)
    const friday = split.find((d) => d.date === '2026-08-14')
    expect(friday?.otHours).toBe(2)
  })
})

describe('groupDailyHoursByWorkweek', () => {
  it('buckets dates spanning two workweeks correctly', () => {
    const days: DailyHours[] = [
      { date: '2026-08-14', hours: 8 }, // week of 2026-08-10
      { date: '2026-08-17', hours: 8 }, // week of 2026-08-17
    ]
    const byWeek = groupDailyHoursByWorkweek(days)
    expect(byWeek.size).toBe(2)
    expect(byWeek.get('2026-08-10')).toEqual([{ date: '2026-08-14', hours: 8 }])
    expect(byWeek.get('2026-08-17')).toEqual([{ date: '2026-08-17', hours: 8 }])
  })
})

describe('workweeksCoveringPeriod / workweekRangeCoveringPeriod', () => {
  it('lists every workweek that overlaps the period, even partially', () => {
    // Period Aug 6-20 (semimonthly-shaped): touches the week of Aug 3 (Mon)
    // through the week of Aug 17 (Mon) — three workweeks total.
    expect(workweeksCoveringPeriod('2026-08-06', '2026-08-20')).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
    ])
  })

  it('widens the fetch range to whole workweeks, never a partial one', () => {
    expect(workweekRangeCoveringPeriod('2026-08-06', '2026-08-20')).toEqual({
      start: '2026-08-03',
      end: '2026-08-23',
    })
  })
})

describe('allocateHoursToPeriod — the correctness trap: a workweek straddling a period boundary', () => {
  // The workweek of 2026-08-17 (Mon) through 2026-08-23 (Sun) straddles a
  // semimonthly period boundary at Aug 20/21. One employee works enough to
  // cross 40h for the whole week — spec's own warning: summing hours INSIDE
  // each period separately and calling anything over some per-period
  // threshold "OT" would be wrong. The correct order is workweek-first.
  const week: DailyHours[] = [
    { date: '2026-08-17', hours: 9 }, // Mon
    { date: '2026-08-18', hours: 9 }, // Tue
    { date: '2026-08-19', hours: 9 }, // Wed
    { date: '2026-08-20', hours: 9 }, // Thu — cumulative 36 by end of Thu
    { date: '2026-08-21', hours: 9 }, // Fri — crosses 40 (4h regular, 5h OT)
    { date: '2026-08-22', hours: 8 }, // Sat — all OT
  ]
  // Whole-week truth: 45h regular... wait, total = 9*5+8=53h. Regular=40, OT=13.
  const periodA = { start: '2026-08-06', end: '2026-08-20' } // Mon-Thu of that week
  const periodB = { start: '2026-08-21', end: '2026-09-05' } // Fri-Sat of that week

  it('allocates period A (Mon-Thu of the straddled week) as entirely regular — 36h, 0 OT', () => {
    const alloc = allocateHoursToPeriod(week, periodA.start, periodA.end)
    expect(alloc).toEqual({ regularHours: 36, otHours: 0 })
  })

  it('allocates period B (Fri-Sat of the straddled week) as 4h regular + 13h OT', () => {
    const alloc = allocateHoursToPeriod(week, periodB.start, periodB.end)
    expect(alloc).toEqual({ regularHours: 4, otHours: 13 })
  })

  it('PROVES the two periods sum back to the whole workweek\'s true 40 regular / 13 OT split', () => {
    const allocA = allocateHoursToPeriod(week, periodA.start, periodA.end)
    const allocB = allocateHoursToPeriod(week, periodB.start, periodB.end)
    expect(allocA.regularHours + allocB.regularHours).toBe(40)
    expect(allocA.otHours + allocB.otHours).toBe(13)
    const totalHours = week.reduce((s, d) => s + d.hours, 0)
    expect(allocA.regularHours + allocA.otHours + allocB.regularHours + allocB.otHours).toBe(totalHours)
  })

  it('would give the WRONG answer if OT were computed by summing hours inside each period alone (the trap spec warns against)', () => {
    // Naive-wrong: period A alone sums to 36h (under 40, so "0 OT" — coincidentally
    // right here), but period B alone sums to 17h, which naively has "0 OT"
    // (under 40) — the naive per-period total of 0+0=0 OT is WRONG against
    // the correct answer of 13h OT proven above.
    const naivePeriodBHours = week
      .filter((d) => d.date >= periodB.start && d.date <= periodB.end)
      .reduce((s, d) => s + d.hours, 0)
    const naiveOtForPeriodBAlone = Math.max(0, naivePeriodBHours - 40)
    expect(naiveOtForPeriodBAlone).toBe(0)
    expect(naiveOtForPeriodBAlone).not.toBe(13)
  })
})
