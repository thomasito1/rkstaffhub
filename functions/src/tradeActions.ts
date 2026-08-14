/**
 * Trade transitions unreachable from a client write — claim, accept, approve,
 * decline (spec §7, §17). Pattern-matched to `scheduleOverride.ts` /
 * `schedulePublish.ts`: independently re-verify state, never trust the
 * client's claimed status, atomic write + best-effort audit follow-up.
 *
 * ELIGIBILITY is the one piece of business logic this package does NOT
 * duplicate — `checkTradeEligibility()` (and `effectiveSkillFor`, the
 * department check) live in the one shared, Firebase-free module at
 * `../../src/lib/scheduling/tradeEligibility.ts`, reached here through the
 * symlink at `./tradeEligibility.ts`. Plain symlinks resolve cleanly under
 * this package's `rootDir: "src"` — no build config changes were needed to
 * make this the single implementation.
 *
 * AUDIT: spec §17 requires an auditLog entry for "trade overrides" only — a
 * normal, eligible claim/accept/approve/decline is not itself audited, unlike
 * schedule publish. Only `approveTrade` writes one, and only when it actually
 * overrides an ineligible candidate (`trade.override`, mirroring
 * `schedule.override`'s shape).
 *
 * NOTIFICATIONS: each callable computes and returns the directly-affected
 * employee ids (the same "compute now, send later" split
 * `recordSchedulePublish` established) — actually sending anything (FCM,
 * the ZenZap webhook stub) is the next Phase 2 task, not this one. Fanning a
 * pool drop out to every eligible employee also belongs there; these
 * `notifyEmployeeIds` lists are deliberately narrow — the poster and the
 * other named party to this specific transition, nothing broader.
 *
 * ShiftLike (from the shared module) has no weekId field — a schedule week is
 * this package's own concern, not the pure eligibility engine's — so weekId is
 * threaded through as a plain parameter rather than smuggled onto that type.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall, type FunctionsErrorCode } from 'firebase-functions/v2/https'

import { COLLECTIONS, db } from './firebase'
import { hasPermission, loadRoleDefaults, requirePermission } from './permissions'
import { markAuditPending, writeAudit } from './audit'
import type { EmployeeDoc, ShiftDoc, ShiftRoleDoc, TimeOffDoc, TradeDoc } from './model'
import {
  checkTradeEligibility,
  tradeIneligibilityCode,
  type ConflictContext,
  type EmployeeLike,
  type ShiftLike,
  type TimeOffLike,
  type TradeErrorCode,
} from './tradeEligibility'

function throwTradeError(httpsCode: FunctionsErrorCode, tradeCode: TradeErrorCode, message: string): never {
  throw new HttpsError(httpsCode, message, { code: tradeCode })
}

function shiftsCollection(weekId: string) {
  return db.collection(COLLECTIONS.schedules).doc(weekId).collection('shifts')
}

function shiftRef(weekId: string, shiftId: string) {
  return shiftsCollection(weekId).doc(shiftId)
}

function tradeRef(tradeId: string) {
  return db.collection(COLLECTIONS.trades).doc(tradeId)
}

function toShiftLike(shiftId: string, shift: ShiftDoc): ShiftLike {
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

function toEmployeeLike(id: string, employee: EmployeeDoc): EmployeeLike {
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
 * still assigned to the trade's `fromEmployeeId`, not cancelled. Used both
 * before eligibility is evaluated and again inside the write transaction —
 * the second check is the one that actually guards the write.
 */
function assertShiftUnchanged(shift: ShiftDoc | undefined, fromEmployeeId: string | null): asserts shift {
  if (!shift || (shift.employeeId ?? null) !== fromEmployeeId || shift.status === 'cancelled') {
    throwTradeError(
      'failed-precondition',
      'trade/shift-changed',
      'This shift changed since it was posted — refresh and try again.',
    )
  }
}

async function loadTradeAndShift(
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
 * don't change mid-request the way the shift/trade's own status can, so only
 * that narrower state gets re-verified inside the write transaction.
 */
async function evaluateEligibility(
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

// ── claimTrade ───────────────────────────────────────────────────────────────

export interface ClaimTradeRequest {
  tradeId: string
}

export interface ClaimTradeResponse {
  tradeId: string
  status: 'claimed'
  claimedBy: string
  notifyEmployeeIds: string[]
}

export const claimTrade = onCall<ClaimTradeRequest>(
  async (request): Promise<ClaimTradeResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { tradeId } = request.data
    if (!tradeId) throw new HttpsError('invalid-argument', 'tradeId is required.')

    const actor = await requirePermission(uid, 'trades.request')
    const { trade, weekId, shift } = await loadTradeAndShift(tradeId)

    if (trade.type !== 'pool') {
      throwTradeError('failed-precondition', 'trade/not-pool', 'Only pool trades can be claimed.')
    }
    if (trade.status !== 'open') {
      throwTradeError('failed-precondition', 'trade/not-open', 'This trade is no longer open.')
    }

    const eligibility = await evaluateEligibility(actor.id, weekId, shift)
    if (!eligibility.eligible) {
      throwTradeError(
        'failed-precondition',
        tradeIneligibilityCode(eligibility),
        'You are not eligible for this shift.',
      )
    }

    await db.runTransaction(async (tx) => {
      const [freshTrade, freshShift] = await Promise.all([
        tx.get(tradeRef(tradeId)),
        tx.get(shiftRef(weekId, shift.id as string)),
      ])
      if (!freshTrade.exists || (freshTrade.data() as TradeDoc).status !== 'open') {
        throwTradeError('failed-precondition', 'trade/not-open', 'This trade is no longer open.')
      }
      assertShiftUnchanged(
        freshShift.exists ? (freshShift.data() as ShiftDoc) : undefined,
        trade.fromEmployeeId ?? null,
      )
      tx.update(tradeRef(tradeId), {
        status: 'claimed',
        claimedBy: actor.id,
        updatedAt: FieldValue.serverTimestamp(),
      })
    })

    const notifyEmployeeIds = Array.from(
      new Set([trade.postedBy, trade.fromEmployeeId ?? undefined].filter((id): id is string => Boolean(id))),
    )

    return { tradeId, status: 'claimed', claimedBy: actor.id, notifyEmployeeIds }
  },
)

// ── acceptTrade ──────────────────────────────────────────────────────────────

export interface AcceptTradeRequest {
  tradeId: string
}

export interface AcceptTradeResponse {
  tradeId: string
  status: 'pending-approval'
  notifyEmployeeIds: string[]
}

export const acceptTrade = onCall<AcceptTradeRequest>(
  async (request): Promise<AcceptTradeResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { tradeId } = request.data
    if (!tradeId) throw new HttpsError('invalid-argument', 'tradeId is required.')

    const actor = await requirePermission(uid, 'trades.request')
    const { trade, weekId, shift } = await loadTradeAndShift(tradeId)

    if (trade.type !== 'direct') {
      throwTradeError('failed-precondition', 'trade/not-direct', 'Only a direct offer can be accepted.')
    }
    if (trade.status !== 'open') {
      throwTradeError('failed-precondition', 'trade/not-open', 'This trade is no longer open.')
    }
    if (trade.toEmployeeId !== actor.id) {
      throwTradeError('permission-denied', 'trade/wrong-recipient', 'This offer was not made to you.')
    }

    const eligibility = await evaluateEligibility(actor.id, weekId, shift)
    if (!eligibility.eligible) {
      throwTradeError(
        'failed-precondition',
        tradeIneligibilityCode(eligibility),
        'You are not eligible for this shift.',
      )
    }

    await db.runTransaction(async (tx) => {
      const [freshTrade, freshShift] = await Promise.all([
        tx.get(tradeRef(tradeId)),
        tx.get(shiftRef(weekId, shift.id as string)),
      ])
      if (!freshTrade.exists || (freshTrade.data() as TradeDoc).status !== 'open') {
        throwTradeError('failed-precondition', 'trade/not-open', 'This trade is no longer open.')
      }
      assertShiftUnchanged(
        freshShift.exists ? (freshShift.data() as ShiftDoc) : undefined,
        trade.fromEmployeeId ?? null,
      )
      tx.update(tradeRef(tradeId), { status: 'pending-approval', updatedAt: FieldValue.serverTimestamp() })
    })

    const notifyEmployeeIds = Array.from(
      new Set([trade.postedBy, trade.fromEmployeeId ?? undefined].filter((id): id is string => Boolean(id))),
    )

    return { tradeId, status: 'pending-approval', notifyEmployeeIds }
  },
)

// ── approveTrade ─────────────────────────────────────────────────────────────

export interface ApproveTradeRequest {
  tradeId: string
  /** Required only when the assignee currently fails eligibility. */
  overrideReason?: string
}

export interface ApproveTradeResponse {
  tradeId: string
  status: 'approved'
  assigneeId: string
  overridden: boolean
  notifyEmployeeIds: string[]
}

export const approveTrade = onCall<ApproveTradeRequest>(
  async (request): Promise<ApproveTradeResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { tradeId } = request.data
    if (!tradeId) throw new HttpsError('invalid-argument', 'tradeId is required.')

    const actor = await requirePermission(uid, 'trades.approve')
    const { trade, weekId, shift } = await loadTradeAndShift(tradeId)

    // Department scoping (spec §4/§7): FOH managers approve FOH trades; BOH
    // effectively has no trades. Owner/GM bypass.
    if (
      actor.accessRole !== 'owner' &&
      actor.accessRole !== 'gm' &&
      actor.employee.department !== trade.department
    ) {
      throwTradeError('permission-denied', 'trade/wrong-approver', 'This trade is outside your department.')
    }

    const assigneeId = trade.type === 'pool' ? trade.claimedBy : trade.toEmployeeId
    const expectedStatus = trade.type === 'pool' ? 'claimed' : 'pending-approval'
    if (!assigneeId || trade.status !== expectedStatus) {
      throwTradeError('failed-precondition', 'trade/not-pending', 'This trade is not awaiting approval.')
    }

    const eligibility = await evaluateEligibility(assigneeId, weekId, shift)

    let overridden = false
    if (!eligibility.eligible) {
      const roleDefaults = await loadRoleDefaults()
      const canOverride = hasPermission(actor, 'trades.manualAssign', roleDefaults)
      if (!canOverride) {
        throwTradeError(
          'failed-precondition',
          tradeIneligibilityCode(eligibility),
          'The assignee is not eligible for this shift.',
        )
      }
      const reason = request.data.overrideReason?.trim()
      if (!reason) {
        throwTradeError(
          'invalid-argument',
          'trade/override-reason-required',
          'A reason is required to approve an ineligible trade.',
        )
      }
      overridden = true
    }

    const previousEmployeeId = shift.employeeId ?? null

    await db.runTransaction(async (tx) => {
      const [freshTrade, freshShift] = await Promise.all([
        tx.get(tradeRef(tradeId)),
        tx.get(shiftRef(weekId, shift.id as string)),
      ])
      if (!freshTrade.exists || (freshTrade.data() as TradeDoc).status !== expectedStatus) {
        throwTradeError('failed-precondition', 'trade/not-pending', 'This trade is not awaiting approval.')
      }
      assertShiftUnchanged(
        freshShift.exists ? (freshShift.data() as ShiftDoc) : undefined,
        previousEmployeeId,
      )
      tx.update(shiftRef(weekId, shift.id as string), {
        employeeId: assigneeId,
        dirtySincePublish: true,
        updatedAt: FieldValue.serverTimestamp(),
      })
      tx.update(tradeRef(tradeId), {
        status: 'approved',
        approvedBy: actor.id,
        updatedAt: FieldValue.serverTimestamp(),
      })
    })

    if (overridden) {
      const audited = await writeAudit({
        action: 'trade.override',
        actorEmployeeId: actor.id,
        actorUid: uid,
        targetType: 'trade',
        targetId: tradeId,
        reason: request.data.overrideReason?.trim() ?? null,
        before: { employeeId: previousEmployeeId },
        after: {
          employeeId: assigneeId,
          blockingConflicts: eligibility.blockingConflicts.map((c) => c.code),
        },
      })
      if (!audited) await markAuditPending(tradeRef(tradeId), 'trade.override')
    }

    const notifyEmployeeIds = Array.from(
      new Set(
        [assigneeId, trade.fromEmployeeId ?? undefined, trade.postedBy].filter(
          (id): id is string => Boolean(id),
        ),
      ),
    )

    return { tradeId, status: 'approved', assigneeId, overridden, notifyEmployeeIds }
  },
)

// ── declineTrade ─────────────────────────────────────────────────────────────

export interface DeclineTradeRequest {
  tradeId: string
  reason?: string
}

export interface DeclineTradeResponse {
  tradeId: string
  /** Pool declines reopen for anyone else to claim; direct declines are terminal. */
  status: 'open' | 'declined'
  notifyEmployeeIds: string[]
}

export const declineTrade = onCall<DeclineTradeRequest>(
  async (request): Promise<DeclineTradeResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { tradeId } = request.data
    if (!tradeId) throw new HttpsError('invalid-argument', 'tradeId is required.')

    const actor = await requirePermission(uid, 'trades.approve')
    const { trade } = await loadTradeAndShift(tradeId)

    if (
      actor.accessRole !== 'owner' &&
      actor.accessRole !== 'gm' &&
      actor.employee.department !== trade.department
    ) {
      throwTradeError('permission-denied', 'trade/wrong-approver', 'This trade is outside your department.')
    }

    const expectedStatus = trade.type === 'pool' ? 'claimed' : 'pending-approval'
    if (trade.status !== expectedStatus) {
      throwTradeError('failed-precondition', 'trade/not-pending', 'This trade is not awaiting approval.')
    }

    // Pool: a declined claim reopens for anyone else. Direct: terminal — the
    // offer itself was to one named person, so there is no "anyone else" to
    // reopen it for (Trade.status doc comment, src/types/models.ts).
    const nextStatus = trade.type === 'pool' ? 'open' : 'declined'
    const reason = request.data.reason?.trim() || null
    const declinedParty = trade.type === 'pool' ? trade.claimedBy : trade.toEmployeeId

    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(tradeRef(tradeId))
      if (!fresh.exists || (fresh.data() as TradeDoc).status !== expectedStatus) {
        throwTradeError('failed-precondition', 'trade/not-pending', 'This trade is not awaiting approval.')
      }
      tx.update(tradeRef(tradeId), {
        status: nextStatus,
        claimedBy: nextStatus === 'open' ? null : declinedParty ?? null,
        declineReason: reason,
        updatedAt: FieldValue.serverTimestamp(),
      })
    })

    const notifyEmployeeIds = Array.from(
      new Set([trade.postedBy, declinedParty ?? undefined].filter((id): id is string => Boolean(id))),
    )

    return { tradeId, status: nextStatus, notifyEmployeeIds }
  },
)
