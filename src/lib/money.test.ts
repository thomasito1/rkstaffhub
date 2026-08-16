import { describe, expect, it } from 'vitest'

import { centsForHours, centsToCsvString, centsToDollars, dollarsToCents, sumCents } from './money'

describe('money — integer-cents conversions', () => {
  it('converts a dollar amount to integer cents', () => {
    expect(dollarsToCents(18.5)).toBe(1850)
    expect(dollarsToCents(0)).toBe(0)
  })

  it('rounds a dollar amount with more than 2 decimal places', () => {
    expect(dollarsToCents(18.505)).toBe(1851)
    expect(dollarsToCents(18.504)).toBe(1850)
  })

  it('converts cents back to a plain dollar number', () => {
    expect(centsToDollars(1850)).toBe(18.5)
    expect(centsToDollars(1)).toBe(0.01)
  })

  it('sums a list of cents with plain integer addition', () => {
    expect(sumCents([100, 250, 1])).toBe(351)
    expect(sumCents([])).toBe(0)
  })

  it('computes cents for a fractional hours × rate, rounding to the nearest cent', () => {
    // 37.75h @ $18.50/hr = $698.375 → rounds to $698.38
    expect(centsForHours(1850, 37.75)).toBe(69838)
  })

  it('rounds half up for a fractional-cent result', () => {
    // 1 hour @ 33.335 cents/hr-equivalent edge — use a rate/hours combo that lands exactly on .5 cents
    expect(centsForHours(1, 0.5)).toBe(1) // 0.5 cents rounds up to 1
  })

  it('formats cents as a CSV-safe dollar string with no currency symbol', () => {
    expect(centsToCsvString(69838)).toBe('698.38')
    expect(centsToCsvString(5)).toBe('0.05')
    expect(centsToCsvString(0)).toBe('0.00')
  })

  it('formats negative cents correctly for a CSV column', () => {
    expect(centsToCsvString(-150)).toBe('-1.50')
  })
})
