import { describe, expect, it } from 'vitest'

import { weekdayKeyOfDate } from './dateHelpers'

describe('weekdayKeyOfDate', () => {
  it('resolves every day of a known Mon–Sun week (Aug 10–16 2026, Aug 10 confirmed Monday)', () => {
    expect(weekdayKeyOfDate('2026-08-10')).toBe('mon')
    expect(weekdayKeyOfDate('2026-08-11')).toBe('tue')
    expect(weekdayKeyOfDate('2026-08-12')).toBe('wed')
    expect(weekdayKeyOfDate('2026-08-13')).toBe('thu')
    expect(weekdayKeyOfDate('2026-08-14')).toBe('fri')
    expect(weekdayKeyOfDate('2026-08-15')).toBe('sat')
    expect(weekdayKeyOfDate('2026-08-16')).toBe('sun')
  })

  it('handles a month boundary (Aug 31 2026 confirmed Monday, per the Phase 3(c) reseed)', () => {
    expect(weekdayKeyOfDate('2026-08-31')).toBe('mon')
    expect(weekdayKeyOfDate('2026-09-01')).toBe('tue')
  })

  it('falls back to mon for malformed input rather than throwing', () => {
    expect(weekdayKeyOfDate('not-a-date')).toBe('mon')
  })
})
