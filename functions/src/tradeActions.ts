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
 * symlink at `./tradeEligibility.ts`. The Firestore glue around it (doc
 * shapes, refs, gathering eligibility context) lives in `./tradeHelpers.ts`,
 * shared with `tradeTriggers.ts`'s pool-drop notification trigger so that
 * plumbing isn't duplicated either.
 *
 * AUDIT: spec §17 requires an auditLog entry for "trade overrides" only — a
 * normal, eligible claim/accept/approve/decline is not itself audited, unlike
 * schedule publish. Only `approveTrade` writes one, and only when it actually
 * overrides an ineligible candidate (`trade.override`, mirroring
 * `schedule.override`'s shape).
 *
 * PUSH: only the transitions with an assigned PushCategory send anything —
 * `claimTrade` (`trade.claimed`) and `approveTrade` (`trade.approved`).
 * `acceptTrade`/`declineTrade` have no category and send nothing. ZenZap is
 * NOT called here — spec §7 names the webhook stub for the pool-drop moment
 * specifically (`tradeTriggers.ts`), not every transition. A failed push is
 * best-effort: it never blocks or rolls back the transition that already
 * committed, and marks `pushPending` on the trade so the gap surfaces
 * (`markPushPending`, ./push.ts) rather than vanishing. The ACTOR of a
 * transition is never pushed about their own action, even if they'd
 * otherwise be in the notify set.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

import { db } from './firebase'
import { hasPermission, loadRoleDefaults, requirePermission } from './permissions'
import { markAuditPending, writeAudit } from './audit'
import { markPushPending, sendPush } from './push'
import type { ShiftDoc, TradeDoc } from './model'
import { tradeIneligibilityCode } from './tradeEligibility'
import {
  assertShiftUnchanged,
  evaluateEligibility,
  fetchDisplayName,
  fetchRoleName,
  formatShiftDateLabel,
  loadTradeAndShift,
  shiftRef,
  throwTradeError,
  tradeRef,
} from './tradeHelpers'

function dedupe(ids: (string | null | undefined)[]): string[] {
  return Array.from(new Set(ids.filter((id): id is string => Boolean(id))))
}

/** The push audience is always a subset of the notify audience: never push to the actor about their own action. */
function excludingActor(ids: string[], actorId: string): string[] {
  return ids.filter((id) => id !== actorId)
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

    const notifyEmployeeIds = dedupe([trade.postedBy, trade.fromEmployeeId])
    const pushTargets = excludingActor(notifyEmployeeIds, actor.id)
    if (pushTargets.length > 0) {
      const [claimantName, posterName, roleName] = await Promise.all([
        fetchDisplayName(actor.id),
        fetchDisplayName(trade.fromEmployeeId ?? trade.postedBy),
        fetchRoleName(shift.roleId),
      ])
      const { failed } = await sendPush({
        employeeIds: pushTargets,
        category: 'trade.claimed',
        params: { claimantName, posterName, roleName, dateLabel: formatShiftDateLabel(shift.date) },
      })
      if (failed.length > 0) await markPushPending(tradeRef(tradeId), 'trade.claimed', failed)
    }

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

    // No PushCategory is assigned to acceptance (src/types/models.ts) —
    // deliberately silent; the next signal a party gets is the approval.
    const notifyEmployeeIds = dedupe([trade.postedBy, trade.fromEmployeeId])

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
      assertShiftUnchanged(freshShift.exists ? (freshShift.data() as ShiftDoc) : undefined, previousEmployeeId)
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

    const notifyEmployeeIds = dedupe([assigneeId, trade.fromEmployeeId, trade.postedBy])

    // "{{approverName}} approved your trade with {{otherName}} for
    // {{dateLabel}}." — otherName differs per recipient (each side of the
    // trade sees the OTHER party's name), so this sends per-recipient rather
    // than as one shared-params batch.
    const pushTargets = excludingActor(notifyEmployeeIds, actor.id)
    if (pushTargets.length > 0) {
      const [approverName, assigneeName, fromName, dateLabel] = await Promise.all([
        fetchDisplayName(actor.id),
        fetchDisplayName(assigneeId),
        fetchDisplayName(trade.fromEmployeeId ?? trade.postedBy),
        Promise.resolve(formatShiftDateLabel(shift.date)),
      ])
      const failedAll: string[] = []
      await Promise.all(
        pushTargets.map(async (employeeId) => {
          const otherName = employeeId === assigneeId ? fromName : assigneeName
          const { failed } = await sendPush({
            employeeIds: [employeeId],
            category: 'trade.approved',
            params: { approverName, otherName, dateLabel },
          })
          failedAll.push(...failed)
        }),
      )
      if (failedAll.length > 0) await markPushPending(tradeRef(tradeId), 'trade.approved', failedAll)
    }

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

    // No PushCategory is assigned to a decline either — deliberately silent.
    const notifyEmployeeIds = dedupe([trade.postedBy, declinedParty])

    return { tradeId, status: nextStatus, notifyEmployeeIds }
  },
)
