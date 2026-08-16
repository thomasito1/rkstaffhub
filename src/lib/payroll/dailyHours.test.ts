import { describe, expect, it } from 'vitest'

import { bucketPunchesIntoDailyHours, type PunchLike } from './dailyHours'

// A trivial UTC-based "date of ms" stand-in — the real caller passes a
// restaurant-tz-aware function; this module doesn't care which, it's pure.
function isoDateOfMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

const HOUR = 60 * 60 * 1000
const DAY0 = Date.UTC(2026, 7, 10, 9, 0, 0) // 2026-08-10 09:00 UTC

describe('bucketPunchesIntoDailyHours', () => {
  it('pairs a simple in/out into that day\'s hours', () => {
    const punches: PunchLike[] = [
      { employeeId: 'e1', type: 'in', timestampMs: DAY0 },
      { employeeId: 'e1', type: 'out', timestampMs: DAY0 + 8 * HOUR },
    ]
    const result = bucketPunchesIntoDailyHours(punches, isoDateOfMs)
    expect(result).toEqual([{ date: '2026-08-10', hours: 8 }])
  })

  it('ignores a trailing unpaired "in" (still open) rather than fabricating hours', () => {
    const punches: PunchLike[] = [{ employeeId: 'e1', type: 'in', timestampMs: DAY0 }]
    const result = bucketPunchesIntoDailyHours(punches, isoDateOfMs)
    expect(result).toEqual([])
  })

  it('sums two pairs on the same day (a split shift) into one daily total', () => {
    const punches: PunchLike[] = [
      { employeeId: 'e1', type: 'in', timestampMs: DAY0 },
      { employeeId: 'e1', type: 'out', timestampMs: DAY0 + 4 * HOUR },
      { employeeId: 'e1', type: 'in', timestampMs: DAY0 + 6 * HOUR },
      { employeeId: 'e1', type: 'out', timestampMs: DAY0 + 10 * HOUR },
    ]
    const result = bucketPunchesIntoDailyHours(punches, isoDateOfMs)
    expect(result).toEqual([{ date: '2026-08-10', hours: 8 }])
  })

  it('attributes a pair crossing midnight to the "in" punch\'s own calendar day', () => {
    const lateNightIn = Date.UTC(2026, 7, 10, 22, 0, 0) // 2026-08-10 22:00
    const earlyOut = Date.UTC(2026, 7, 11, 2, 0, 0) // 2026-08-11 02:00
    const punches: PunchLike[] = [
      { employeeId: 'e1', type: 'in', timestampMs: lateNightIn },
      { employeeId: 'e1', type: 'out', timestampMs: earlyOut },
    ]
    const result = bucketPunchesIntoDailyHours(punches, isoDateOfMs)
    expect(result).toEqual([{ date: '2026-08-10', hours: 4 }])
  })

  it('keeps different employees\' punches completely separate', () => {
    const punches: PunchLike[] = [
      { employeeId: 'e1', type: 'in', timestampMs: DAY0 },
      { employeeId: 'e2', type: 'in', timestampMs: DAY0 },
      { employeeId: 'e1', type: 'out', timestampMs: DAY0 + 5 * HOUR },
      { employeeId: 'e2', type: 'out', timestampMs: DAY0 + 3 * HOUR },
    ]
    const e1 = bucketPunchesIntoDailyHours(
      punches.filter((p) => p.employeeId === 'e1'),
      isoDateOfMs,
    )
    const e2 = bucketPunchesIntoDailyHours(
      punches.filter((p) => p.employeeId === 'e2'),
      isoDateOfMs,
    )
    expect(e1).toEqual([{ date: '2026-08-10', hours: 5 }])
    expect(e2).toEqual([{ date: '2026-08-10', hours: 3 }])
  })

  it('sorts unordered input by timestamp before pairing', () => {
    const punches: PunchLike[] = [
      { employeeId: 'e1', type: 'out', timestampMs: DAY0 + 8 * HOUR },
      { employeeId: 'e1', type: 'in', timestampMs: DAY0 },
    ]
    const result = bucketPunchesIntoDailyHours(punches, isoDateOfMs)
    expect(result).toEqual([{ date: '2026-08-10', hours: 8 }])
  })
})
