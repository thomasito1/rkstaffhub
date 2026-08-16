import { describe, expect, it } from 'vitest'

import { nextSemimonthlyPeriod, periodIdForDate, semimonthlyPeriodForDate } from './periods'

describe('semimonthlyPeriodForDate — 1st-15th half', () => {
  it('resolves any date 1-15 to the same period, paid the 20th of the same month', () => {
    expect(semimonthlyPeriodForDate('2026-08-01')).toEqual({
      startDate: '2026-08-01',
      endDate: '2026-08-15',
      payDate: '2026-08-20',
    })
    expect(semimonthlyPeriodForDate('2026-08-15')).toEqual({
      startDate: '2026-08-01',
      endDate: '2026-08-15',
      payDate: '2026-08-20',
    })
    expect(semimonthlyPeriodForDate('2026-08-09')).toEqual({
      startDate: '2026-08-01',
      endDate: '2026-08-15',
      payDate: '2026-08-20',
    })
  })
})

describe('semimonthlyPeriodForDate — 16th-end-of-month half, paid the 5th of the NEXT month', () => {
  it('a 31-day month (January)', () => {
    expect(semimonthlyPeriodForDate('2026-01-16')).toEqual({
      startDate: '2026-01-16',
      endDate: '2026-01-31',
      payDate: '2026-02-05',
    })
    expect(semimonthlyPeriodForDate('2026-01-31')).toEqual({
      startDate: '2026-01-16',
      endDate: '2026-01-31',
      payDate: '2026-02-05',
    })
  })

  it('a 30-day month (April)', () => {
    expect(semimonthlyPeriodForDate('2026-04-20')).toEqual({
      startDate: '2026-04-16',
      endDate: '2026-04-30',
      payDate: '2026-05-05',
    })
  })

  it('February in a NON-leap year (2026, 28 days)', () => {
    expect(semimonthlyPeriodForDate('2026-02-16')).toEqual({
      startDate: '2026-02-16',
      endDate: '2026-02-28',
      payDate: '2026-03-05',
    })
    expect(semimonthlyPeriodForDate('2026-02-28')).toEqual({
      startDate: '2026-02-16',
      endDate: '2026-02-28',
      payDate: '2026-03-05',
    })
  })

  it('February in a LEAP year (2028, 29 days)', () => {
    expect(semimonthlyPeriodForDate('2028-02-16')).toEqual({
      startDate: '2028-02-16',
      endDate: '2028-02-29',
      payDate: '2028-03-05',
    })
    expect(semimonthlyPeriodForDate('2028-02-29')).toEqual({
      startDate: '2028-02-16',
      endDate: '2028-02-29',
      payDate: '2028-03-05',
    })
  })

  it('December rolls the pay date into January of the NEXT year', () => {
    expect(semimonthlyPeriodForDate('2026-12-20')).toEqual({
      startDate: '2026-12-16',
      endDate: '2026-12-31',
      payDate: '2027-01-05',
    })
  })
})

describe('periodIdForDate', () => {
  it('uses the period start date as the id, matching the existing seed convention', () => {
    expect(periodIdForDate('2026-08-09')).toBe('2026-08-01')
    expect(periodIdForDate('2026-08-20')).toBe('2026-08-16')
  })
})

describe('nextSemimonthlyPeriod', () => {
  it('goes from the 1-15 half to the 16-end half within the same month', () => {
    expect(nextSemimonthlyPeriod('2026-08-15')).toEqual({
      startDate: '2026-08-16',
      endDate: '2026-08-31',
      payDate: '2026-09-05',
    })
  })

  it('goes from the 16-end half to the NEXT month\'s 1-15 half', () => {
    expect(nextSemimonthlyPeriod('2026-08-31')).toEqual({
      startDate: '2026-09-01',
      endDate: '2026-09-15',
      payDate: '2026-09-20',
    })
  })

  it('crosses a year boundary correctly', () => {
    expect(nextSemimonthlyPeriod('2026-12-31')).toEqual({
      startDate: '2027-01-01',
      endDate: '2027-01-15',
      payDate: '2027-01-20',
    })
  })

  it('crosses a leap-year February correctly (from Jan 16-31 into Feb 1-15, then Feb 16-29)', () => {
    expect(nextSemimonthlyPeriod('2028-01-31')).toEqual({
      startDate: '2028-02-01',
      endDate: '2028-02-15',
      payDate: '2028-02-20',
    })
    expect(nextSemimonthlyPeriod('2028-02-15')).toEqual({
      startDate: '2028-02-16',
      endDate: '2028-02-29',
      payDate: '2028-03-05',
    })
  })
})
