import { describe, it, expect } from 'vitest'
import { checkTradeEligibility, type ShiftLike, type EmployeeLike, type ConflictContext } from './tradeEligibility'

/**
 * checkTradeEligibility implements spec §7's four conditions exactly, and only
 * those four — unlike the schedule builder's findConflicts, it does not warn
 * on availability or projected overtime, neither of which spec §7 gates a
 * trade on.
 */

const COVERAGE = {
  bartender: ['server', 'host', 'runner'],
  server: [],
}

function emp(over: Partial<EmployeeLike> = {}): EmployeeLike {
  return {
    id: 'emp-1',
    status: 'active',
    shiftRoles: [{ roleId: 'server', skillLevel: 2 }],
    ...over,
  }
}

function shift(over: Partial<ShiftLike> = {}): ShiftLike {
  return {
    id: 'shift-1',
    date: '2026-08-14',
    startTime: '15:30',
    endTime: '22:00',
    roleId: 'server',
    requiredSkillLevel: 2,
    ...over,
  }
}

function ctx(over: Partial<ConflictContext> = {}): ConflictContext {
  return {
    employee: emp(),
    timeOff: [],
    otherShifts: [],
    canCoverRoleIds: COVERAGE,
    ...over,
  }
}

describe('checkTradeEligibility — spec §7, all four conditions', () => {
  it('is eligible when nothing is wrong', () => {
    const result = checkTradeEligibility(shift(), ctx())
    expect(result.eligible).toBe(true)
    expect(result.blockingConflicts).toEqual([])
  })

  it('is ineligible when the employee cannot work the role at all', () => {
    const result = checkTradeEligibility(
      shift({ roleId: 'bartender' }),
      ctx({ employee: emp({ shiftRoles: [{ roleId: 'runner', skillLevel: 3 }] }) }),
    )
    expect(result.eligible).toBe(false)
    expect(result.blockingConflicts.some((c) => c.code === 'wrong-role')).toBe(true)
  })

  it('is ineligible when skill is below the shift requirement', () => {
    const result = checkTradeEligibility(
      shift({ requiredSkillLevel: 3 }),
      ctx({ employee: emp({ shiftRoles: [{ roleId: 'server', skillLevel: 2 }] }) }),
    )
    expect(result.eligible).toBe(false)
    expect(result.blockingConflicts.some((c) => c.code === 'skill-too-low')).toBe(true)
  })

  it('is ineligible on approved time off overlapping the shift date', () => {
    const result = checkTradeEligibility(
      shift(),
      ctx({ timeOff: [{ startDate: '2026-08-14', endDate: '2026-08-14', status: 'approved' }] }),
    )
    expect(result.eligible).toBe(false)
    expect(result.blockingConflicts.some((c) => c.code === 'time-off')).toBe(true)
  })

  it('is NOT ineligible on merely pending time off', () => {
    const result = checkTradeEligibility(
      shift(),
      ctx({ timeOff: [{ startDate: '2026-08-14', endDate: '2026-08-14', status: 'pending' }] }),
    )
    expect(result.eligible).toBe(true)
  })

  it('is ineligible when the shift overlaps another shift the employee already holds', () => {
    const result = checkTradeEligibility(
      shift(),
      ctx({
        otherShifts: [shift({ id: 'other', startTime: '14:00', endTime: '18:00' })],
      }),
    )
    expect(result.eligible).toBe(false)
    expect(result.blockingConflicts.some((c) => c.code === 'double-booked')).toBe(true)
  })

  it('is ineligible for an inactive employee', () => {
    const result = checkTradeEligibility(shift(), ctx({ employee: emp({ status: 'archived' }) }))
    expect(result.eligible).toBe(false)
    expect(result.blockingConflicts.some((c) => c.code === 'inactive-employee')).toBe(true)
  })

  it('is ineligible across departments', () => {
    const result = checkTradeEligibility(
      shift({ department: 'FOH' }),
      ctx({ employee: emp({ department: 'BOH' }) }),
    )
    expect(result.eligible).toBe(false)
    expect(result.blockingConflicts.some((c) => c.code === 'wrong-department')).toBe(true)
  })

  it('does not gate on availability — spec §7 does not name it as a condition', () => {
    const result = checkTradeEligibility(shift(), ctx({ availability: { status: 'unavailable' } }))
    expect(result.eligible).toBe(true)
  })
})
