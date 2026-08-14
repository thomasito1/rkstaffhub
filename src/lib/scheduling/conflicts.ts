/**
 * Conflicts engine — spec §6.
 *
 * The single place that decides whether a shift assignment is legal. The
 * schedule builder, the AI-draft validator (Phase 5) and trade eligibility
 * (Phase 2, spec §7) all funnel through it, so its severities are load-bearing:
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
 * This module is PURE. It takes plain data and returns findings; it performs no
 * reads, no writes and no permission checks. Callers supply the context and are
 * responsible for enforcing the result.
 */

export type ConflictSeverity = 'block' | 'warn'

export type ConflictCode =
  | 'unavailable'
  | 'partial-outside-hours'
  | 'time-off'
  | 'double-booked'
  | 'overtime'
  | 'skill-too-low'
  | 'wrong-role'
  | 'inactive-employee'
  | 'wrong-department'

export interface Conflict {
  code: ConflictCode
  severity: ConflictSeverity
  /** i18n key under `conflicts.*`. Never a user-facing string — this is a lib. */
  messageKey: string
  /** Interpolation values for the message. */
  params?: Record<string, string | number>
  /**
   * True only for `skill-too-low`. A manager with trades.manualAssign may
   * override it, and the override is logged with a reason (spec §6, §7).
   * Every other block is absolute.
   */
  overridable: boolean
}

// ── Inputs ───────────────────────────────────────────────────────────────────
// Deliberately structural rather than importing the Firestore models: the
// engine is also fed by the AI validator and by trade eligibility, which
// assemble their inputs differently.

export interface ShiftLike {
  id?: string
  date: string // "2026-08-14"
  startTime: string // "15:30"
  endTime: string // "22:00"
  roleId: string
  requiredSkillLevel: 1 | 2 | 3
  employeeId?: string | null
  /**
   * Optional. Only trade eligibility (spec §7) supplies it — the schedule
   * builder already scopes its candidate list to the shift's department, so
   * the check below is a no-op there. Left off, the department check never
   * fires.
   */
  department?: string
}

export interface EmployeeLike {
  id: string
  status: string
  shiftRoles: { roleId: string; skillLevel: 1 | 2 | 3 }[]
  /** Optional — see ShiftLike.department. */
  department?: string
}

export interface AvailabilityDayLike {
  status: 'available' | 'unavailable' | 'partial'
  from?: string | null
  to?: string | null
}

export interface TimeOffLike {
  startDate: string
  endDate: string
  status: string
}

export interface ConflictContext {
  employee: EmployeeLike
  /** The candidate's availability for the shift's weekday, already resolved
   *  (temporary overriding recurring). Undefined = nothing submitted. */
  availability?: AvailabilityDayLike | undefined
  /** All of the employee's approved/pending time off overlapping the week. */
  timeOff: TimeOffLike[]
  /** The employee's OTHER shifts that week, excluding the one being checked. */
  otherShifts: ShiftLike[]
  /** Coverage map: roleId → roles it may cover (spec §7.1, asymmetric). */
  canCoverRoleIds?: Record<string, string[]>
  /** Weekly overtime threshold in hours. Spec §6: >40. */
  overtimeThreshold?: number
}

// ── Time helpers ─────────────────────────────────────────────────────────────

/** "15:30" → 930. Returns NaN for malformed input so callers can spot it. */
export function minutesOf(hhmm: string): number {
  const parts = hhmm.split(':')
  const h = Number(parts[0])
  const m = Number(parts[1])
  if (!Number.isFinite(h) || !Number.isFinite(m)) return Number.NaN
  return h * 60 + m
}

/** Shift length in hours. Handles a shift crossing midnight (close at 02:00). */
export function shiftHours(shift: ShiftLike): number {
  const start = minutesOf(shift.startTime)
  let end = minutesOf(shift.endTime)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  if (end <= start) end += 24 * 60 // crossed midnight
  return (end - start) / 60
}

/** Do two shifts on the same date overlap? Touching endpoints do NOT overlap. */
export function shiftsOverlap(a: ShiftLike, b: ShiftLike): boolean {
  if (a.date !== b.date) return false
  const aStart = minutesOf(a.startTime)
  const bStart = minutesOf(b.startTime)
  let aEnd = minutesOf(a.endTime)
  let bEnd = minutesOf(b.endTime)
  if (aEnd <= aStart) aEnd += 24 * 60
  if (bEnd <= bStart) bEnd += 24 * 60
  return aStart < bEnd && bStart < aEnd
}

function dateWithin(date: string, start: string, end: string): boolean {
  return date >= start && date <= end
}

// ── Individual checks ────────────────────────────────────────────────────────

/**
 * Effective skill level for working `roleId`: the direct level if the employee
 * holds that role, otherwise the level of a role that can cover into it
 * (spec §7.1). Returns 0 when the employee cannot work the role at all.
 *
 * Coverage is asymmetric by design: Bartender lists Server, but a Server never
 * lists Bartender.
 */
export function effectiveSkillFor(
  employee: EmployeeLike,
  roleId: string,
  canCoverRoleIds: Record<string, string[]> = {},
): number {
  const direct = employee.shiftRoles.find((r) => r.roleId === roleId)
  if (direct) return direct.skillLevel

  let best = 0
  for (const held of employee.shiftRoles) {
    const covers = canCoverRoleIds[held.roleId] ?? []
    if (covers.includes(roleId) && held.skillLevel > best) {
      best = held.skillLevel
    }
  }
  return best
}

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
  if (shift.department && employee.department && shift.department !== employee.department) {
    conflicts.push({
      code: 'wrong-department',
      severity: 'block',
      messageKey: 'conflicts.wrongDepartment',
      params: { department: shift.department },
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
