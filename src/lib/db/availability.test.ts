/**
 * Temporary-vs-recurring resolution — spec §5.
 *
 * resolveEffectiveAvailability() is pure by construction (no Firestore, no
 * clock), which is why it was split out of effectiveAvailabilityFor(). These
 * run under plain `vitest run`; anything touching the emulator belongs in
 * tests/rules.
 */

import { describe, expect, it } from 'vitest'

import { WEEKDAY_KEYS, type Availability, type AvailabilityDay, type WeekdayKey } from '@/types/models'

import { RECURRING_WEEK_ID, resolveEffectiveAvailability } from './availability'

const WEEK = '2026-08-10'

function days(overrides: Partial<Record<WeekdayKey, AvailabilityDay>>): Record<WeekdayKey, AvailabilityDay> {
  const out = {} as Record<WeekdayKey, AvailabilityDay>
  for (const key of WEEKDAY_KEYS) {
    out[key] = overrides[key] ?? { status: 'available', from: null, to: null }
  }
  return out
}

function record(over: Partial<Availability>): Availability {
  return {
    id: 'x',
    employeeId: 'emp-1',
    weekId: WEEK,
    type: 'temporary',
    days: days({}),
    status: 'approved',
    ...over,
  }
}

const recurring = record({
  id: `${RECURRING_WEEK_ID}_emp-1`,
  weekId: RECURRING_WEEK_ID,
  type: 'recurring',
  days: days({
    mon: { status: 'unavailable', from: null, to: null },
    wed: { status: 'partial', from: '17:00', to: '23:00' },
  }),
})

describe('resolveEffectiveAvailability', () => {
  it('falls back to an all-available week when nothing is on file', () => {
    const eff = resolveEffectiveAvailability('emp-1', WEEK, null, null)
    expect(eff.source).toBe('none')
    expect(eff.record).toBeNull()
    expect(eff.isPending).toBe(false)
    for (const key of WEEKDAY_KEYS) expect(eff.days[key]!.status).toBe('available')
  })

  it('uses the recurring baseline when there is no override for the week', () => {
    const eff = resolveEffectiveAvailability('emp-1', WEEK, recurring, null)
    expect(eff.source).toBe('recurring')
    expect(eff.days.mon).toEqual({ status: 'unavailable', from: null, to: null })
    expect(eff.days.wed).toEqual({ status: 'partial', from: '17:00', to: '23:00' })
    expect(eff.days.tue!.status).toBe('available')
  })

  it('lets a temporary override win for that week', () => {
    const temporary = record({
      days: days({
        mon: { status: 'available', from: null, to: null },
        wed: { status: 'unavailable', from: null, to: null },
        sat: { status: 'partial', from: '10:00', to: '16:00' },
      }),
    })

    const eff = resolveEffectiveAvailability('emp-1', WEEK, recurring, temporary)
    expect(eff.source).toBe('temporary')
    expect(eff.record).toBe(temporary)
    // Monday is unavailable in the baseline and free in the override — the
    // override governs, otherwise the week-specific request means nothing.
    expect(eff.days.mon!.status).toBe('available')
    expect(eff.days.wed!.status).toBe('unavailable')
    expect(eff.days.sat).toEqual({ status: 'partial', from: '10:00', to: '16:00' })
  })

  it('applies a pending override but flags it as unconfirmed', () => {
    const temporary = record({
      status: 'pending',
      days: days({ fri: { status: 'unavailable', from: null, to: null } }),
    })
    const eff = resolveEffectiveAvailability('emp-1', WEEK, recurring, temporary)
    expect(eff.source).toBe('temporary')
    expect(eff.isPending).toBe(true)
    expect(eff.days.fri!.status).toBe('unavailable')
  })

  it('ignores a DECLINED override and falls back to the baseline', () => {
    const declined = record({
      status: 'declined',
      declineReason: 'Friday dinner is already short two servers.',
      days: days({ fri: { status: 'unavailable', from: null, to: null } }),
    })

    const eff = resolveEffectiveAvailability('emp-1', WEEK, recurring, declined)
    expect(eff.source).toBe('recurring')
    // The declined request does NOT get to mark Friday off.
    expect(eff.days.fri!.status).toBe('available')
    expect(eff.days.mon!.status).toBe('unavailable')
  })

  it('ignores a declined baseline too', () => {
    const declinedBaseline = record({ ...recurring, status: 'declined' })
    const eff = resolveEffectiveAvailability('emp-1', WEEK, declinedBaseline, null)
    expect(eff.source).toBe('none')
    expect(eff.days.mon!.status).toBe('available')
  })

  it('falls back per day when the override omits one', () => {
    // Hand-assembled partial record: the Firestore reader materialises all
    // seven keys, but a partial write must not reset the untouched days.
    const partial = record({
      days: { fri: { status: 'unavailable', from: null, to: null } } as Record<
        WeekdayKey,
        AvailabilityDay
      >,
    })

    const eff = resolveEffectiveAvailability('emp-1', WEEK, recurring, partial)
    expect(eff.source).toBe('temporary')
    expect(eff.days.fri!.status).toBe('unavailable')
    // Inherited from the baseline, not silently reset to available.
    expect(eff.days.mon!.status).toBe('unavailable')
    expect(eff.days.wed).toEqual({ status: 'partial', from: '17:00', to: '23:00' })
  })

  it('always returns all seven days', () => {
    const eff = resolveEffectiveAvailability('emp-1', WEEK, null, record({ days: days({}) }))
    expect(Object.keys(eff.days).sort()).toEqual([...WEEKDAY_KEYS].sort())
  })
})
