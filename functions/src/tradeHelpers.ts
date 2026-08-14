/**
 * Firestore glue shared by `tradeActions.ts` (the claim/accept/approve/decline
 * callables) and `tradeTriggers.ts` (the pool-drop notification trigger) —
 * everything here is plumbing (doc shapes, refs, gathering eligibility
 * context), NOT the eligibility algorithm itself. That stays the one
 * implementation in `./tradeEligibility` (symlinked from
 * `../../src/lib/scheduling/tradeEligibility.ts`).
 */

import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https'

import { COLLECTIONS, db } from './firebase'
import { displayName, type EmployeeDoc, type ShiftDoc, type ShiftRoleDoc, type TimeOffDoc, type TradeDoc } from './model'
import {
  checkTradeEligibility,
  type ConflictContext,
  type EmployeeLike,
  type ShiftLike,
  type TimeOffLike,
  type TradeErrorCode,
} from './tradeEligibility'

export function throwTradeError(
  httpsCode: FunctionsErrorCode,
  tradeCode: TradeErrorCode,
  message: string,
): never {
  throw new HttpsError(httpsCode, message, { code: tradeCode })
}

export function shiftsCollection(weekId: string) {
  return db.collection(COLLECTIONS.schedules).doc(weekId).collection('shifts')
}

export function shiftRef(weekId: string, shiftId: string) {
  return shiftsCollection(weekId).doc(shiftId)
}

export function tradeRef(tradeId: string) {
  return db.collection(COLLECTIONS.trades).doc(tradeId)
}

export function toShiftLike(shiftId: string, shift: ShiftDoc): ShiftLike {
  return {
    id: shiftId,
    date: shift.date ?? '',
    startTime: shift.startTime ?? '',
    endTime: shift.endTime ?? '',
    roleId: shift.roleId ?? '',
    requiredSkillLevel: (shift.requiredSkillLevel ?? 1) as 1 | 2 | 3,
    employeeId: shift.employeeId ?? null,
    department: shift.department,
  }
}

export function toEmployeeLike(id: string, employee: EmployeeDoc): EmployeeLike {
  return {
    id,
    status: employee.status ?? 'inactive',
    department: employee.department,
    shiftRoles: (employee.shiftRoles ?? []).map((r) => ({
      roleId: r.roleId,
      skillLevel: r.skillLevel as 1 | 2 | 3,
    })),
  }
}

/**
 * Re-fetches the shift a client's write must never be trusted for, and
 * re-verifies it still matches what the trade was posted against: exists,
 * still assigned to the trade's `fromEmployeeId`, not cancelled.
 */
export function assertShiftUnchanged(
  shift: ShiftDoc | undefined,
  fromEmployeeId: string | null,
): asserts shift {
  if (!shift || (shift.employeeId ?? null) !== fromEmployeeId || shift.status === 'cancelled') {
    throwTradeError(
      'failed-precondition',
      'trade/shift-changed',
      'This shift changed since it was posted — refresh and try again.',
    )
  }
}

export async function loadTradeAndShift(
  tradeId: string,
): Promise<{ trade: TradeDoc; weekId: string; shift: ShiftLike }> {
  const snap = await tradeRef(tradeId).get()
  if (!snap.exists) {
    throwTradeError('not-found', 'trade/shift-changed', 'That trade no longer exists.')
  }
  const trade = snap.data() as TradeDoc
  if (!trade.weekId || !trade.shiftId) {
    throwTradeError('failed-precondition', 'trade/shift-changed', 'This trade is missing its shift reference.')
  }

  const shiftSnap = await shiftRef(trade.weekId, trade.shiftId).get()
  const shiftData = shiftSnap.exists ? (shiftSnap.data() as ShiftDoc) : undefined
  assertShiftUnchanged(shiftData, trade.fromEmployeeId ?? null)

  return { trade, weekId: trade.weekId, shift: toShiftLike(trade.shiftId, shiftData) }
}

/**
 * Gathers everything `checkTradeEligibility()` needs for `employeeId` against
 * `shift`, and runs it. Reads happen OUTSIDE any transaction (matching
 * `scheduleOverride.ts`'s shape) — role catalogs, time off and other-shifts
 * don't change mid-request the way the shift/trade's own status can.
 */
export async function evaluateEligibility(
  employeeId: string,
  weekId: string,
  shift: ShiftLike,
): Promise<ReturnType<typeof checkTradeEligibility>> {
  const [employeeSnap, roleRolesSnap, timeOffSnap, otherShiftsSnap] = await Promise.all([
    db.collection(COLLECTIONS.employees).doc(employeeId).get(),
    db.collection(COLLECTIONS.shiftRoles).get(),
    db.collection(COLLECTIONS.timeOff).where('employeeId', '==', employeeId).get(),
    shiftsCollection(weekId).where('employeeId', '==', employeeId).get(),
  ])

  if (!employeeSnap.exists) {
    throwTradeError('not-found', 'trade/shift-changed', 'That employee no longer exists.')
  }
  const employee = toEmployeeLike(employeeId, employeeSnap.data() as EmployeeDoc)

  const canCoverRoleIds: Record<string, string[]> = {}
  for (const doc of roleRolesSnap.docs) {
    const data = doc.data() as ShiftRoleDoc
    canCoverRoleIds[doc.id] = data.canCoverRoleIds ?? []
  }

  const timeOff: TimeOffLike[] = timeOffSnap.docs.map((doc) => {
    const data = doc.data() as TimeOffDoc
    return { startDate: data.startDate ?? '', endDate: data.endDate ?? '', status: data.status ?? '' }
  })

  const otherShifts: ShiftLike[] = otherShiftsSnap.docs
    .filter((doc) => doc.id !== shift.id)
    .map((doc) => toShiftLike(doc.id, doc.data() as ShiftDoc))

  const context: ConflictContext = { employee, timeOff, otherShifts, canCoverRoleIds }
  return checkTradeEligibility(shift, context)
}

/**
 * "Sat, Aug 15" — restaurant timezone, fixed 'en-US' numerals. Deliberately
 * NOT per-recipient-language (see push.ts's SendPushInput doc comment): a
 * date/time reads fine bilingually in a neutral format, and localizing it
 * would need a second timezone-aware formatting pass per recipient for
 * marginal benefit.
 */
export function formatShiftDateLabel(date: string): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  }).format(new Date(`${date}T12:00:00Z`))
}

/** "HH:mm" 24h → "3:30 PM". */
export function formatShiftTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2000, 0, 1, h, m)))
}

/** Display name for a push notification body. Falls back for a manager-posted (no fromEmployeeId) trade or a deleted record. */
export async function fetchDisplayName(employeeId: string | null | undefined): Promise<string> {
  if (!employeeId) return 'A manager'
  const snap = await db.collection(COLLECTIONS.employees).doc(employeeId).get()
  return snap.exists ? displayName(snap.data() as EmployeeDoc) : 'Someone'
}

/** Bilingual role name for push params (ShiftRole.name/nameEs) — falls back to the raw roleId. */
export async function fetchRoleName(roleId: string): Promise<{ en: string; es: string }> {
  const snap = await db.collection(COLLECTIONS.shiftRoles).doc(roleId).get()
  const data = snap.exists ? (snap.data() as ShiftRoleDoc) : null
  return { en: data?.name ?? roleId, es: data?.nameEs ?? roleId }
}

/**
 * Every active employee in `department` except `excludeEmployeeId` (the
 * poster) — the coarse, CORRECTNESS-PRESERVING pre-filter for pool-drop
 * notifications: spec §7's 4th eligibility condition requires the right
 * department outright, so a cross-department employee can never be eligible
 * regardless of role/skill, and is never worth an eligibility read.
 */
export async function activeEmployeesInDepartment(
  department: string,
  excludeEmployeeId: string | null,
): Promise<string[]> {
  const snap = await db
    .collection(COLLECTIONS.employees)
    .where('department', '==', department)
    .where('status', '==', 'active')
    .get()

  return snap.docs.map((d) => d.id).filter((id) => id !== excludeEmployeeId)
}
