/**
 * Conflicts engine — spec §6.
 *
 * The single place that decides whether a shift assignment is legal. The
 * schedule builder and the AI-draft validator (Phase 5) funnel through it, so
 * its severities are load-bearing:
 *
 *   'block' — the assignment must not be saved.
 *   'warn'  — the assignment saves, with a visible flag on the shift card.
 *
 * Spec §6 fixes which is which, and the choices are not interchangeable:
 *   availability conflict      → warn   (people flex; a manager may know better)
 *   approved time off          → BLOCK  (already granted; overriding it silently
 *                                        breaks a promise to the employee)
 *   double-booking             → BLOCK  (physically impossible)
 *   projected overtime > 40h   → warn   (costly, not illegal)
 *   skill below required level → BLOCK, but overridable by a manager holding
 *                                trades.manualAssign, with a REQUIRED reason
 *                                that is written to auditLog.
 *
 * Trade eligibility (Phase 2, spec §7) does NOT go through this module — its
 * narrower four-condition check lives in ./tradeEligibility, the one shared,
 * Firebase-free implementation imported by both this file and Cloud
 * Functions. This module re-exports its types and primitives so existing
 * imports of ShiftLike/EmployeeLike/effectiveSkillFor/etc. from './conflicts'
 * keep working unchanged.
 *
 * This module is PURE. It takes plain data and returns findings; it performs no
 * reads, no writes and no permission checks. Callers supply the context and are
 * responsible for enforcing the result.
 */

import {
  dateWithin,
  isDepartmentMismatch,
  minutesOf,
  shiftHours,
  shiftsOverlap,
  effectiveSkillFor,
  type Conflict,
  type ConflictContext,
  type ShiftLike,
} from './tradeEligibility'

export {
  type ConflictSeverity,
  type ConflictCode,
  type Conflict,
  type ShiftLike,
  type EmployeeLike,
  type AvailabilityDayLike,
  type TimeOffLike,
  type ConflictContext,
  minutesOf,
  shiftHours,
  shiftsOverlap,
  effectiveSkillFor,
} from './tradeEligibility'

// ── The engine ───────────────────────────────────────────────────────────────

/**
 * Every conflict for assigning `shift` to `context.employee`, most severe first.
 * An empty array means the assignment is clean.
 */
export function findConflicts(shift: ShiftLike, context: ConflictContext): Conflict[] {
  const conflicts: Conflict[] = []
  const {
    employee,
    availability,
    timeOff,
    otherShifts,
    canCoverRoleIds = {},
    overtimeThreshold = 40,
  } = context

  // ── BLOCK: archived/inactive staff are excluded from scheduling (spec §18)
  if (employee.status !== 'active') {
    conflicts.push({
      code: 'inactive-employee',
      severity: 'block',
      messageKey: 'conflicts.inactiveEmployee',
      params: { status: employee.status },
      overridable: false,
    })
  }

  // ── BLOCK: wrong department (spec §7's 4th trade-eligibility condition).
  //    Only fires when both sides carry a department — the schedule builder's
  //    own candidate list is already department-scoped, so this is a no-op
  //    there and only bites trade eligibility, which supplies both fields.
  if (isDepartmentMismatch(shift, employee)) {
    conflicts.push({
      code: 'wrong-department',
      severity: 'block',
      messageKey: 'conflicts.wrongDepartment',
      params: { department: shift.department ?? '' },
      overridable: false,
    })
  }

  // ── BLOCK: cannot work this role at all, directly or by coverage
  const skill = effectiveSkillFor(employee, shift.roleId, canCoverRoleIds)
  if (skill === 0) {
    conflicts.push({
      code: 'wrong-role',
      severity: 'block',
      messageKey: 'conflicts.wrongRole',
      overridable: false,
    })
  } else if (skill < shift.requiredSkillLevel) {
    // ── BLOCK, but a manager may override with a logged reason (spec §6)
    conflicts.push({
      code: 'skill-too-low',
      severity: 'block',
      messageKey: 'conflicts.skillTooLow',
      params: { has: skill, needs: shift.requiredSkillLevel },
      overridable: true,
    })
  }

  // ── BLOCK: approved time off. Pending time off is NOT a conflict — it has
  //    not been granted, and treating it as one would let anyone freeze their
  //    schedule just by asking.
  const onApprovedLeave = timeOff.some(
    (t) => t.status === 'approved' && dateWithin(shift.date, t.startDate, t.endDate),
  )
  if (onApprovedLeave) {
    conflicts.push({
      code: 'time-off',
      severity: 'block',
      messageKey: 'conflicts.timeOff',
      overridable: false,
    })
  }

  // ── BLOCK: double-booking. Physically impossible, never overridable.
  const clash = otherShifts.find((s) => s.id !== shift.id && shiftsOverlap(shift, s))
  if (clash) {
    conflicts.push({
      code: 'double-booked',
      severity: 'block',
      messageKey: 'conflicts.doubleBooked',
      params: { start: clash.startTime, end: clash.endTime },
      overridable: false,
    })
  }

  // ── WARN: availability. People flex, and a manager may have spoken to them.
  if (availability) {
    if (availability.status === 'unavailable') {
      conflicts.push({
        code: 'unavailable',
        severity: 'warn',
        messageKey: 'conflicts.unavailable',
        overridable: false,
      })
    } else if (availability.status === 'partial') {
      const from = availability.from ? minutesOf(availability.from) : 0
      const to = availability.to ? minutesOf(availability.to) : 24 * 60
      const start = minutesOf(shift.startTime)
      let end = minutesOf(shift.endTime)
      if (end <= start) end += 24 * 60
      if (start < from || end > to) {
        conflicts.push({
          code: 'partial-outside-hours',
          severity: 'warn',
          messageKey: 'conflicts.partialOutsideHours',
          params: {
            from: availability.from ?? '00:00',
            to: availability.to ?? '24:00',
          },
          overridable: false,
        })
      }
    }
  }

  // ── WARN: projected overtime. Costly, not illegal.
  const projected =
    otherShifts
      .filter((s) => s.id !== shift.id)
      .reduce((sum, s) => sum + shiftHours(s), 0) + shiftHours(shift)

  if (projected > overtimeThreshold) {
    conflicts.push({
      code: 'overtime',
      severity: 'warn',
      messageKey: 'conflicts.overtime',
      params: {
        projected: Math.round(projected * 10) / 10,
        threshold: overtimeThreshold,
      },
      overridable: false,
    })
  }

  return conflicts.sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === 'block' ? -1 : 1,
  )
}

/** True when nothing blocks the assignment. Warnings do not block. */
export function isAssignable(conflicts: Conflict[]): boolean {
  return !conflicts.some((c) => c.severity === 'block')
}

/**
 * True when the only thing standing in the way is an overridable block, so the
 * UI can offer "assign anyway (reason required)" rather than a dead end.
 */
export function isOverridable(conflicts: Conflict[]): boolean {
  const blocks = conflicts.filter((c) => c.severity === 'block')
  return blocks.length > 0 && blocks.every((c) => c.overridable)
}
