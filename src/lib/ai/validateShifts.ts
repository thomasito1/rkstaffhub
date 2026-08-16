/**
 * Runs every AI-proposed shift through the REAL conflicts engine (spec §13,
 * Rafa's guardrail #3: "every shift validated by the real conflicts engine;
 * invalid → open shift with reason") — `findConflicts` from
 * `../scheduling/conflicts` is imported unmodified, never reimplemented
 * (guardrail #2). PURE: plain data in, typed shifts out, no reads/writes.
 *
 * "Invalid" means BLOCKED (`!isAssignable(conflicts)`), matching the
 * conflicts engine's own severity vocabulary exactly — a `warn`-only
 * assignment (e.g. projected overtime, a partial-availability mismatch) is
 * accepted as-is, precisely because a human building the schedule by hand
 * would be allowed to do the same thing with just a visible flag. Only a
 * genuine block (double-booking, approved time off, wrong role, skill floor,
 * inactive employee) demotes a proposed assignment to an open shift.
 *
 * A shift proposing a (date, roleId) pair with no matching resolved
 * requirement line at all is a hallucination, not a validation failure — it
 * is DROPPED entirely (`rejected`), never written as a Shift document,
 * since there is no real department/skill-level data to build one from.
 *
 * Double-booking and overtime are checked against the EMPLOYEE's real
 * existing shifts for the week AND every other shift already accepted from
 * this same batch — a provider proposing the same person twice in
 * overlapping slots must be caught even though neither shift existed before
 * this call.
 */

import {
  findConflicts,
  isAssignable,
  type AvailabilityDayLike,
  type EmployeeLike,
  type ShiftLike,
  type TimeOffLike,
} from '../scheduling/conflicts'
import { weekdayKeyOfDate } from './dateHelpers'
import type { AiGeneratedShift } from './contract'

export interface ShiftRoleSpec {
  minSkillLevel: 1 | 2 | 3
  department: string
}

export interface ValidateShiftsInput {
  shifts: AiGeneratedShift[]
  /** Every existing shift for the week, keyed by employeeId — what a proposed assignment must not collide with. */
  existingShiftsByEmployee: Record<string, ShiftLike[]>
  employeesById: Record<string, EmployeeLike>
  /** Resolved (temporary-overriding-recurring) availability, per employee, per weekday key. */
  availabilityByEmployee: Record<string, Partial<Record<string, AvailabilityDayLike>>>
  timeOffByEmployee: Record<string, TimeOffLike[]>
  canCoverRoleIds: Record<string, string[]>
  /** `${date}::${roleId}` → the resolved requirement line's own skill/department. */
  roleSpecByDateAndRole: Record<string, ShiftRoleSpec>
  overtimeThreshold?: number
}

export interface ValidatedShift {
  employeeId: string | null
  date: string
  startTime: string
  endTime: string
  roleId: string
  requiredSkillLevel: 1 | 2 | 3
  department: string
  aiValidationNote: { messageKey: string; params?: Record<string, string | number> } | null
}

export interface RejectedShift {
  shift: AiGeneratedShift
  reason: { messageKey: string; params?: Record<string, string | number> }
}

export interface ValidateShiftsResult {
  shifts: ValidatedShift[]
  rejected: RejectedShift[]
}

function requirementKey(date: string, roleId: string): string {
  return `${date}::${roleId}`
}

export function validateGeneratedShifts(input: ValidateShiftsInput): ValidateShiftsResult {
  const shifts: ValidatedShift[] = []
  const rejected: RejectedShift[] = []

  // Batch-local additions, so a second proposed shift for the same employee
  // sees the first one as an "other shift" for double-booking/OT purposes,
  // even though neither existed before this call.
  const acceptedThisBatch: Record<string, ShiftLike[]> = {}
  const otherShiftsFor = (employeeId: string): ShiftLike[] => [
    ...(input.existingShiftsByEmployee[employeeId] ?? []),
    ...(acceptedThisBatch[employeeId] ?? []),
  ]

  for (const [index, raw] of input.shifts.entries()) {
    const spec = input.roleSpecByDateAndRole[requirementKey(raw.date, raw.roleId)]
    if (!spec) {
      rejected.push({
        shift: raw,
        reason: { messageKey: 'ai.errors.noMatchingRequirement', params: { roleId: raw.roleId, date: raw.date } },
      })
      continue
    }

    const base = {
      date: raw.date,
      startTime: raw.startTime,
      endTime: raw.endTime,
      roleId: raw.roleId,
      requiredSkillLevel: spec.minSkillLevel,
      department: spec.department,
    }

    if (raw.employeeId === null) {
      shifts.push({ ...base, employeeId: null, aiValidationNote: null })
      continue
    }

    const employee = input.employeesById[raw.employeeId]
    if (!employee) {
      shifts.push({
        ...base,
        employeeId: null,
        aiValidationNote: { messageKey: 'ai.errors.unknownEmployee', params: { employeeId: raw.employeeId } },
      })
      continue
    }

    // A distinct, real-doc-id-proof synthetic id: `findConflicts`' double-
    // booking check excludes `s.id !== shift.id` to skip comparing a shift
    // against itself — with every candidate and stored "other shift" alike
    // carrying `id: undefined`, that check would spuriously treat every pair
    // as "the same shift" and never fire at all.
    const shiftLike: ShiftLike = { ...base, id: `__candidate_${index}__`, employeeId: raw.employeeId }
    const weekday = weekdayKeyOfDate(raw.date)
    const conflicts = findConflicts(shiftLike, {
      employee,
      availability: input.availabilityByEmployee[raw.employeeId]?.[weekday],
      timeOff: input.timeOffByEmployee[raw.employeeId] ?? [],
      otherShifts: otherShiftsFor(raw.employeeId),
      canCoverRoleIds: input.canCoverRoleIds,
      overtimeThreshold: input.overtimeThreshold,
    })

    if (isAssignable(conflicts)) {
      shifts.push({ ...base, employeeId: raw.employeeId, aiValidationNote: null })
      const list = acceptedThisBatch[raw.employeeId] ?? []
      list.push(shiftLike)
      acceptedThisBatch[raw.employeeId] = list
    } else {
      const worst = conflicts.find((c) => c.severity === 'block') ?? conflicts[0]
      shifts.push({
        ...base,
        employeeId: null,
        aiValidationNote: worst ? { messageKey: worst.messageKey, params: worst.params } : null,
      })
    }
  }

  return { shifts, rejected }
}
