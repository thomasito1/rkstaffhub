/**
 * Pay period lock/unlock — spec §11: "Review & lock: period status open →
 * review → locked (no more punch/tip edits without unlock by Owner/GM,
 * logged)." Unreachable from a client write (firestore.rules' `payPeriods`
 * match denies create/update/delete outright) — both transitions need the
 * audit guarantee spec §17 requires, the same "the Function is the only
 * path" shape `recordSchedulePublish`/`recordScheduleOverride` already
 * established.
 *
 * LOCK needs `payroll.lockPeriod` (which spec's matrix only grants Owner/GM
 * by default, same as `payroll.view`/`payroll.export`). UNLOCK is gated
 * TWICE, deliberately stricter than the permission key alone: `payroll.
 * lockPeriod` AND the actor's actual `accessRole` is literally `owner` or
 * `gm` — spec's own text names "Owner/GM" for unlock specifically, not
 * merely "whoever holds the permission key" (a `permissionOverrides` grant
 * to some hypothetical future role should not be enough to reopen an
 * already-locked, already-reviewed period on its own).
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

import { COLLECTIONS, db } from './firebase'
import { requirePermission } from './permissions'
import { markAuditPending, writeAudit } from './audit'
import type { PayPeriodDoc } from './model'

function periodRef(periodId: string) {
  return db.collection(COLLECTIONS.payPeriods).doc(periodId)
}

export interface LockPayPeriodRequest {
  periodId: string
}

export interface LockPayPeriodResponse {
  periodId: string
  status: 'locked'
}

export const lockPayPeriod = onCall<LockPayPeriodRequest>(
  async (request): Promise<LockPayPeriodResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { periodId } = request.data
    if (!periodId) throw new HttpsError('invalid-argument', 'periodId is required.')

    const actor = await requirePermission(uid, 'payroll.lockPeriod')

    const ref = periodRef(periodId)
    const before = await ref.get()
    if (!before.exists) throw new HttpsError('not-found', 'That pay period no longer exists.')
    const beforeData = before.data() as PayPeriodDoc
    if (beforeData.status === 'locked') {
      throw new HttpsError('failed-precondition', 'This period is already locked.')
    }

    await ref.update({
      status: 'locked',
      lockedAt: FieldValue.serverTimestamp(),
      lockedBy: actor.id,
      updatedAt: FieldValue.serverTimestamp(),
    })

    const audited = await writeAudit({
      action: 'period.lock',
      actorEmployeeId: actor.id,
      actorUid: uid,
      targetType: 'payPeriod',
      targetId: periodId,
      before: { status: beforeData.status ?? null },
      after: { status: 'locked' },
    })
    if (!audited) await markAuditPending(ref, 'period.lock')

    return { periodId, status: 'locked' }
  },
)

export interface UnlockPayPeriodRequest {
  periodId: string
  reason: string
}

export interface UnlockPayPeriodResponse {
  periodId: string
  status: 'review'
}

export const unlockPayPeriod = onCall<UnlockPayPeriodRequest>(
  async (request): Promise<UnlockPayPeriodResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { periodId } = request.data
    const reason = request.data.reason?.trim()
    if (!periodId) throw new HttpsError('invalid-argument', 'periodId is required.')
    if (!reason) throw new HttpsError('invalid-argument', 'A reason is required to unlock a pay period.')

    const actor = await requirePermission(uid, 'payroll.lockPeriod')
    if (actor.accessRole !== 'owner' && actor.accessRole !== 'gm') {
      throw new HttpsError('permission-denied', 'Only an Owner or GM can unlock a pay period.')
    }

    const ref = periodRef(periodId)
    const before = await ref.get()
    if (!before.exists) throw new HttpsError('not-found', 'That pay period no longer exists.')
    const beforeData = before.data() as PayPeriodDoc
    if (beforeData.status !== 'locked') {
      throw new HttpsError('failed-precondition', 'This period is not locked.')
    }

    // Unlocking returns to 'review', not 'open' — the period was already
    // reviewed once; re-opening it to raw 'open' would lose that milestone.
    await ref.update({
      status: 'review',
      unlockedAt: FieldValue.serverTimestamp(),
      unlockedBy: actor.id,
      unlockReason: reason,
      updatedAt: FieldValue.serverTimestamp(),
    })

    const audited = await writeAudit({
      action: 'period.unlock',
      actorEmployeeId: actor.id,
      actorUid: uid,
      targetType: 'payPeriod',
      targetId: periodId,
      reason,
      before: { status: 'locked' },
      after: { status: 'review' },
    })
    if (!audited) await markAuditPending(ref, 'period.unlock')

    return { periodId, status: 'review' }
  },
)
