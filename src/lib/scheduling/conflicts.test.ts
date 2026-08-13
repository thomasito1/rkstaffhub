import { describe, it, expect } from 'vitest'
import {
  findConflicts,
  isAssignable,
  isOverridable,
  effectiveSkillFor,
  shiftHours,
  shiftsOverlap,
  type ShiftLike,
  type ConflictContext,
  type EmployeeLike,
} from './conflicts'

/**
 * Spec §6 fixes which conflicts block and which only warn. These tests pin that
 * mapping down, because getting it wrong is either a schedule that cannot be
 * built or a promise to an employee that gets silently broken.
 */

const COVERAGE = {
  // Asymmetric by design (spec §7.1): Bartender covers Server, never the reverse.
  bartender: ['server', 'host', 'runner'],
  server: [],
  host: [],
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
    availability: { status: 'available' },
    timeOff: [],
    otherShifts: [],
    canCoverRoleIds: COVERAGE,
    ...over,
  }
}

describe('time helpers', () => {
  it('computes shift length', () => {
    expect(shiftHours(shift({ startTime: '15:30', endTime: '22:00' }))).toBe(6.5)
  })

  it('handles a shift crossing midnight', () => {
    expect(shiftHours(shift({ startTime: '19:00', endTime: '02:00' }))).toBe(7)
  })

  it('treats touching endpoints as non-overlapping', () => {
    const a = shift({ id: 'a', startTime: '10:30', endTime: '16:00' })
    const b = shift({ id: 'b', startTime: '16:00', endTime: '22:00' })
    expect(shiftsOverlap(a, b)).toBe(false)
  })

  it('detects a real overlap', () => {
    const a = shift({ id: 'a', startTime: '10:30', endTime: '16:00' })
    const b = shift({ id: 'b', startTime: '15:00', endTime: '22:00' })
    expect(shiftsOverlap(a, b)).toBe(true)
  })

  it('does not overlap across different dates', () => {
    const a = shift({ id: 'a', date: '2026-08-14' })
    const b = shift({ id: 'b', date: '2026-08-15' })
    expect(shiftsOverlap(a, b)).toBe(false)
  })
})

describe('effectiveSkillFor — role coverage is asymmetric (spec §7.1)', () => {
  it('uses the direct role level', () => {
    expect(effectiveSkillFor(emp(), 'server', COVERAGE)).toBe(2)
  })

  it('lets a Bartender cover a Server shift at their bartender level', () => {
    const bartender = emp({ shiftRoles: [{ roleId: 'bartender', skillLevel: 3 }] })
    expect(effectiveSkillFor(bartender, 'server', COVERAGE)).toBe(3)
  })

  it('does NOT let a Server cover a Bartender shift', () => {
    expect(effectiveSkillFor(emp(), 'bartender', COVERAGE)).toBe(0)
  })

  it('takes the best level when several held roles can cover', () => {
    const multi = emp({
      shiftRoles: [
        { roleId: 'bartender', skillLevel: 3 },
        { roleId: 'host', skillLevel: 1 },
      ],
    })
    expect(effectiveSkillFor(multi, 'runner', COVERAGE)).toBe(3)
  })
})

describe('a clean assignment', () => {
  it('returns no conflicts', () => {
    const found = findConflicts(shift(), ctx())
    expect(found).toEqual([])
    expect(isAssignable(found)).toBe(true)
  })
})

describe('BLOCK: approved time off', () => {
  it('blocks a shift inside approved leave', () => {
    const found = findConflicts(
      shift({ date: '2026-08-14' }),
      ctx({
        timeOff: [{ startDate: '2026-08-13', endDate: '2026-08-15', status: 'approved' }],
      }),
    )
    expect(found.some((c) => c.code === 'time-off' && c.severity === 'block')).toBe(true)
    expect(isAssignable(found)).toBe(false)
  })

  it('does NOT block on PENDING time off — it has not been granted', () => {
    const found = findConflicts(
      shift({ date: '2026-08-14' }),
      ctx({
        timeOff: [{ startDate: '2026-08-13', endDate: '2026-08-15', status: 'pending' }],
      }),
    )
    expect(found.some((c) => c.code === 'time-off')).toBe(false)
  })

  it('is never overridable', () => {
    const found = findConflicts(
      shift(),
      ctx({
        timeOff: [{ startDate: '2026-08-14', endDate: '2026-08-14', status: 'approved' }],
      }),
    )
    expect(isOverridable(found)).toBe(false)
  })
})

describe('BLOCK: double-booking', () => {
  it('blocks an overlapping shift', () => {
    const found = findConflicts(
      shift({ id: 'new', startTime: '15:00', endTime: '22:00' }),
      ctx({
        otherShifts: [
          shift({ id: 'existing', startTime: '10:30', endTime: '16:00' }),
        ],
      }),
    )
    expect(found.some((c) => c.code === 'double-booked' && c.severity === 'block')).toBe(true)
  })

  it('allows back-to-back shifts that only touch', () => {
    const found = findConflicts(
      shift({ id: 'new', startTime: '16:00', endTime: '22:00' }),
      ctx({
        otherShifts: [shift({ id: 'existing', startTime: '10:30', endTime: '16:00' })],
      }),
    )
    expect(found.some((c) => c.code === 'double-booked')).toBe(false)
  })

  it('does not treat the shift being edited as a clash with itself', () => {
    const editing = shift({ id: 'shift-1' })
    const found = findConflicts(editing, ctx({ otherShifts: [editing] }))
    expect(found.some((c) => c.code === 'double-booked')).toBe(false)
  })
})

describe('BLOCK: skill level — the only overridable block', () => {
  it('blocks an L2 server on an L3 shift', () => {
    const found = findConflicts(shift({ requiredSkillLevel: 3 }), ctx())
    const c = found.find((x) => x.code === 'skill-too-low')
    expect(c?.severity).toBe('block')
    expect(c?.overridable).toBe(true)
    expect(c?.params).toEqual({ has: 2, needs: 3 })
  })

  it('reports it as overridable so the UI can offer assign-anyway', () => {
    const found = findConflicts(shift({ requiredSkillLevel: 3 }), ctx())
    expect(isAssignable(found)).toBe(false)
    expect(isOverridable(found)).toBe(true)
  })

  it('allows a level above the requirement', () => {
    const l3 = emp({ shiftRoles: [{ roleId: 'server', skillLevel: 3 }] })
    const found = findConflicts(shift({ requiredSkillLevel: 2 }), ctx({ employee: l3 }))
    expect(found.some((c) => c.code === 'skill-too-low')).toBe(false)
  })

  it('blocks outright — not overridably — when the role cannot be worked at all', () => {
    const found = findConflicts(shift({ roleId: 'bartender' }), ctx())
    const c = found.find((x) => x.code === 'wrong-role')
    expect(c?.severity).toBe('block')
    expect(c?.overridable).toBe(false)
    expect(isOverridable(found)).toBe(false)
  })
})

describe('BLOCK: inactive employees are excluded from scheduling (spec §18)', () => {
  it('blocks an archived employee', () => {
    const found = findConflicts(shift(), ctx({ employee: emp({ status: 'archived' }) }))
    expect(found.some((c) => c.code === 'inactive-employee' && c.severity === 'block')).toBe(true)
  })
})

describe('WARN: availability', () => {
  it('warns rather than blocks on an unavailable day', () => {
    const found = findConflicts(shift(), ctx({ availability: { status: 'unavailable' } }))
    const c = found.find((x) => x.code === 'unavailable')
    expect(c?.severity).toBe('warn')
    expect(isAssignable(found)).toBe(true)
  })

  it('warns when a shift falls outside a partial window', () => {
    const found = findConflicts(
      shift({ startTime: '15:30', endTime: '22:00' }),
      ctx({ availability: { status: 'partial', from: '09:00', to: '16:00' } }),
    )
    expect(found.some((c) => c.code === 'partial-outside-hours')).toBe(true)
  })

  it('is quiet when the shift fits inside the partial window', () => {
    const found = findConflicts(
      shift({ startTime: '10:00', endTime: '15:00' }),
      ctx({ availability: { status: 'partial', from: '09:00', to: '16:00' } }),
    )
    expect(found.some((c) => c.code === 'partial-outside-hours')).toBe(false)
  })

  it('is quiet when no availability was submitted', () => {
    const found = findConflicts(shift(), ctx({ availability: undefined }))
    expect(found.filter((c) => c.severity === 'warn')).toEqual([])
  })
})

describe('WARN: projected overtime', () => {
  it('warns above 40 hours', () => {
    const others = Array.from({ length: 6 }, (_, i) =>
      shift({ id: `o${i}`, date: `2026-08-0${i + 1}`, startTime: '09:00', endTime: '15:00' }),
    )
    // 6 × 6h = 36h, plus a 6.5h shift = 42.5h
    const found = findConflicts(shift({ id: 'new' }), ctx({ otherShifts: others }))
    const c = found.find((x) => x.code === 'overtime')
    expect(c?.severity).toBe('warn')
    expect(c?.params?.projected).toBe(42.5)
  })

  it('does not warn at exactly 40 hours', () => {
    const others = Array.from({ length: 5 }, (_, i) =>
      shift({ id: `o${i}`, date: `2026-08-0${i + 1}`, startTime: '09:00', endTime: '16:00' }),
    )
    // 5 × 7h = 35h, plus 5h = 40h exactly
    const found = findConflicts(
      shift({ id: 'new', startTime: '10:00', endTime: '15:00' }),
      ctx({ otherShifts: others }),
    )
    expect(found.some((c) => c.code === 'overtime')).toBe(false)
  })

  it('never blocks on overtime alone', () => {
    const others = Array.from({ length: 8 }, (_, i) =>
      shift({ id: `o${i}`, date: `2026-08-0${i + 1}`, startTime: '09:00', endTime: '17:00' }),
    )
    const found = findConflicts(shift({ id: 'new' }), ctx({ otherShifts: others }))
    expect(isAssignable(found)).toBe(true)
  })
})

describe('ordering and combinations', () => {
  it('lists blocks before warnings', () => {
    const found = findConflicts(
      shift({ requiredSkillLevel: 3 }),
      ctx({ availability: { status: 'unavailable' } }),
    )
    expect(found[0]?.severity).toBe('block')
    expect(found[found.length - 1]?.severity).toBe('warn')
  })

  it('is NOT overridable when an absolute block sits alongside the skill block', () => {
    const found = findConflicts(
      shift({ requiredSkillLevel: 3 }),
      ctx({
        timeOff: [{ startDate: '2026-08-14', endDate: '2026-08-14', status: 'approved' }],
      }),
    )
    expect(isOverridable(found)).toBe(false)
  })
})
