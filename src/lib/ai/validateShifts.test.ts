import { describe, expect, it } from 'vitest'

import { validateGeneratedShifts, type ValidateShiftsInput } from './validateShifts'
import type { AiGeneratedShift } from './contract'

const SERVER_SPEC = { minSkillLevel: 1 as const, department: 'FOH' }

function baseInput(overrides: Partial<ValidateShiftsInput> = {}): ValidateShiftsInput {
  return {
    shifts: [],
    existingShiftsByEmployee: {},
    employeesById: {
      'emp-1': { id: 'emp-1', status: 'active', shiftRoles: [{ roleId: 'server', skillLevel: 2 }] },
    },
    availabilityByEmployee: {},
    timeOffByEmployee: {},
    canCoverRoleIds: {},
    roleSpecByDateAndRole: { '2026-08-10::server': SERVER_SPEC },
    ...overrides,
  }
}

function shift(over: Partial<AiGeneratedShift> = {}): AiGeneratedShift {
  return { employeeId: 'emp-1', date: '2026-08-10', startTime: '11:00', endTime: '15:00', roleId: 'server', ...over }
}

describe('validateGeneratedShifts', () => {
  it('accepts a clean assignment with no conflicts', () => {
    const result = validateGeneratedShifts(baseInput({ shifts: [shift()] }))
    expect(result.rejected).toHaveLength(0)
    expect(result.shifts).toHaveLength(1)
    expect(result.shifts[0]).toMatchObject({ employeeId: 'emp-1', requiredSkillLevel: 1, department: 'FOH', aiValidationNote: null })
  })

  it('accepts a shift the model itself left open (employeeId: null)', () => {
    const result = validateGeneratedShifts(baseInput({ shifts: [shift({ employeeId: null })] }))
    expect(result.shifts).toHaveLength(1)
    expect(result.shifts[0]?.employeeId).toBeNull()
    expect(result.shifts[0]?.aiValidationNote).toBeNull()
  })

  it('rejects (drops entirely) a proposed date/role with no matching requirement line', () => {
    const result = validateGeneratedShifts(baseInput({ shifts: [shift({ roleId: 'bartender' })] }))
    expect(result.shifts).toHaveLength(0)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]?.reason.messageKey).toBe('ai.errors.noMatchingRequirement')
  })

  it('demotes to open with a reason when the employeeId does not exist', () => {
    const result = validateGeneratedShifts(baseInput({ shifts: [shift({ employeeId: 'ghost' })] }))
    expect(result.shifts).toHaveLength(1)
    expect(result.shifts[0]?.employeeId).toBeNull()
    expect(result.shifts[0]?.aiValidationNote?.messageKey).toBe('ai.errors.unknownEmployee')
  })

  it('demotes to open when the employee is not active (a real conflicts-engine block)', () => {
    const input = baseInput({
      shifts: [shift()],
      employeesById: { 'emp-1': { id: 'emp-1', status: 'terminated', shiftRoles: [{ roleId: 'server', skillLevel: 2 }] } },
    })
    const result = validateGeneratedShifts(input)
    expect(result.shifts[0]?.employeeId).toBeNull()
    expect(result.shifts[0]?.aiValidationNote?.messageKey).toBe('conflicts.inactiveEmployee')
  })

  it('demotes to open on approved time off (a block)', () => {
    const input = baseInput({
      shifts: [shift()],
      timeOffByEmployee: { 'emp-1': [{ startDate: '2026-08-09', endDate: '2026-08-11', status: 'approved' }] },
    })
    const result = validateGeneratedShifts(input)
    expect(result.shifts[0]?.employeeId).toBeNull()
    expect(result.shifts[0]?.aiValidationNote?.messageKey).toBe('conflicts.timeOff')
  })

  it('catches double-booking BETWEEN two proposed shifts in the same batch, not just against pre-existing ones', () => {
    const input = baseInput({
      shifts: [
        shift({ startTime: '11:00', endTime: '15:00' }),
        shift({ startTime: '14:00', endTime: '18:00' }), // overlaps the first
      ],
    })
    const result = validateGeneratedShifts(input)
    expect(result.shifts).toHaveLength(2)
    expect(result.shifts[0]?.employeeId).toBe('emp-1') // first one accepted
    expect(result.shifts[1]?.employeeId).toBeNull() // second demoted — collides with the first
    expect(result.shifts[1]?.aiValidationNote?.messageKey).toBe('conflicts.doubleBooked')
  })

  it('accepts an assignment against a WARN-only conflict (e.g. marked unavailable) — matches the builder allowing the same thing by hand', () => {
    const input = baseInput({
      shifts: [shift()],
      availabilityByEmployee: { 'emp-1': { mon: { status: 'unavailable' } } },
    })
    const result = validateGeneratedShifts(input)
    expect(result.shifts[0]?.employeeId).toBe('emp-1')
    expect(result.shifts[0]?.aiValidationNote).toBeNull()
  })

  it('demotes to open on a skill-too-low block (employee lacks the required level)', () => {
    const input = baseInput({
      shifts: [shift()],
      employeesById: { 'emp-1': { id: 'emp-1', status: 'active', shiftRoles: [{ roleId: 'server', skillLevel: 1 }] } },
      roleSpecByDateAndRole: { '2026-08-10::server': { minSkillLevel: 3, department: 'FOH' } },
    })
    const result = validateGeneratedShifts(input)
    expect(result.shifts[0]?.employeeId).toBeNull()
    expect(result.shifts[0]?.aiValidationNote?.messageKey).toBe('conflicts.skillTooLow')
  })

  it('respects an existing (pre-generation) shift for double-booking, not just batch-local ones', () => {
    const input = baseInput({
      shifts: [shift({ startTime: '14:00', endTime: '18:00' })],
      existingShiftsByEmployee: {
        'emp-1': [{ date: '2026-08-10', startTime: '11:00', endTime: '15:00', roleId: 'server', requiredSkillLevel: 1, employeeId: 'emp-1' }],
      },
    })
    const result = validateGeneratedShifts(input)
    expect(result.shifts[0]?.employeeId).toBeNull()
    expect(result.shifts[0]?.aiValidationNote?.messageKey).toBe('conflicts.doubleBooked')
  })
})
