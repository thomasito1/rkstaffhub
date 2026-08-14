/**
 * Shared scheduling primitives — spec §6/§7.
 *
 * PURE. No Firebase imports, no reads, no writes, no permission checks. This
 * is the one implementation of trade eligibility (spec §7's four conditions)
 * and the pieces it's built from, imported unmodified by both the client
 * (src/lib/scheduling/conflicts.ts, the schedule builder's fuller engine) and
 * Cloud Functions (functions/src/tradeActions.ts, via a symlink at
 * functions/src/tradeEligibility.ts -> ../../src/lib/scheduling/tradeEligibility.ts —
 * plain symlinks resolve cleanly under functions/tsconfig.json's rootDir, no
 * build config changes needed).
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
// Deliberately structural rather than importing the Firestore models: this
// module is fed by the schedule builder, the AI validator and trade
// eligibility, which assemble their inputs differently.

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

export function dateWithin(date: string, start: string, end: string): boolean {
  return date >= start && date <= end
}

// ── Eligibility primitives ──────────────────────────────────────────────────

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

/** Spec §7's 4th condition: active + right department. Quiet unless both sides carry one. */
export function isDepartmentMismatch(shift: ShiftLike, employee: EmployeeLike): boolean {
  return Boolean(shift.department && employee.department && shift.department !== employee.department)
}

export interface TradeEligibilityResult {
  eligible: boolean
  blockingConflicts: Conflict[]
}

/**
 * Typed error vocabulary for the trade action Cloud Functions
 * (functions/src/tradeActions.ts) and their client wrappers
 * (src/lib/scheduling/trades.ts) — shared for the same reason as the
 * eligibility engine itself: one vocabulary, checked with `isFirebaseError()`
 * on the client, set via `HttpsError`'s `details.code` on the server.
 */
export type TradeErrorCode =
  | 'trade/not-open'
  | 'trade/not-pending'
  | 'trade/not-pool'
  | 'trade/not-direct'
  | 'trade/shift-changed'
  | 'trade/wrong-recipient'
  | 'trade/wrong-approver'
  | 'trade/override-reason-required'
  | 'trade/ineligible-role'
  | 'trade/ineligible-skill'
  | 'trade/ineligible-department'
  | 'trade/ineligible-time-off'
  | 'trade/ineligible-double-booked'
  | 'trade/inactive-employee'

const CONFLICT_TO_TRADE_ERROR: Partial<Record<ConflictCode, TradeErrorCode>> = {
  'wrong-role': 'trade/ineligible-role',
  'skill-too-low': 'trade/ineligible-skill',
  'wrong-department': 'trade/ineligible-department',
  'time-off': 'trade/ineligible-time-off',
  'double-booked': 'trade/ineligible-double-booked',
  'inactive-employee': 'trade/inactive-employee',
}

/** The most relevant trade/* error code for an ineligible checkTradeEligibility() result. */
export function tradeIneligibilityCode(result: TradeEligibilityResult): TradeErrorCode {
  const first = result.blockingConflicts[0]
  return (first && CONFLICT_TO_TRADE_ERROR[first.code]) || 'trade/ineligible-role'
}

/**
 * Spec §7's four trade-eligibility conditions, and only those four: role
 * coverage + skill level, no double-booking/approved-time-off conflict, and
 * active + right department. Deliberately narrower than the schedule
 * builder's findConflicts (conflicts.ts) — availability and projected
 * overtime are builder-only warn concerns spec §7 does not gate a trade on.
 */
export function checkTradeEligibility(shift: ShiftLike, context: ConflictContext): TradeEligibilityResult {
  const { employee, timeOff, otherShifts, canCoverRoleIds = {} } = context
  const conflicts: Conflict[] = []

  if (employee.status !== 'active') {
    conflicts.push({
      code: 'inactive-employee',
      severity: 'block',
      messageKey: 'conflicts.inactiveEmployee',
      params: { status: employee.status },
      overridable: false,
    })
  }

  const skill = effectiveSkillFor(employee, shift.roleId, canCoverRoleIds)
  if (skill === 0) {
    conflicts.push({
      code: 'wrong-role',
      severity: 'block',
      messageKey: 'conflicts.wrongRole',
      overridable: false,
    })
  } else if (skill < shift.requiredSkillLevel) {
    conflicts.push({
      code: 'skill-too-low',
      severity: 'block',
      messageKey: 'conflicts.skillTooLow',
      params: { has: skill, needs: shift.requiredSkillLevel },
      overridable: true,
    })
  }

  if (isDepartmentMismatch(shift, employee)) {
    conflicts.push({
      code: 'wrong-department',
      severity: 'block',
      messageKey: 'conflicts.wrongDepartment',
      params: { department: shift.department ?? '' },
      overridable: false,
    })
  }

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

  return { eligible: conflicts.length === 0, blockingConflicts: conflicts }
}
