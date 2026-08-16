/**
 * 48h direct-trade expiry sweep — ruled by Rafa (Aug 2026), restated and
 * recorded in PROGRESS.md after being lost to a `/clear` once already.
 *
 * Only a direct offer still `status: 'open'` expires. `pending-approval`
 * (claimed/accepted, awaiting a manager) never does via this sweep — that's
 * a manager-reminder problem (Phase 6's `trade.awaiting-approval`), not an
 * expiry one. The expiry instant is `min(trade.expiresAt, the shift's own
 * start instant)`: an offer whose shift has already started is dead even if
 * its 48h window hasn't elapsed yet, and vice versa. Pattern-matched to
 * `punchScheduled.ts`'s forgotten-clockout sweep — runs hourly rather than at
 * an exact moment, because an offer expiring an hour late costs nothing,
 * while a sweep silently missing its one exact instant would leave a dead
 * offer looking actionable indefinitely.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'

import { COLLECTIONS, db } from './firebase'
import type { TradeDoc } from './model'
import { markPushPending, sendPush } from './push'
import { fetchRoleName, formatShiftDateLabel, shiftRef, tradeRef } from './tradeHelpers'
import { instantAtShiftStart } from './timeHelpers'

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (value && typeof value === 'object' && 'toDate' in value) {
    return (value as { toDate(): Date }).toDate()
  }
  return null
}

export const sweepExpiredTrades = onSchedule('every 60 minutes', async () => {
  const now = Date.now()

  const snap = await db
    .collection(COLLECTIONS.trades)
    .where('type', '==', 'direct')
    .where('status', '==', 'open')
    .get()

  if (snap.empty) return

  for (const doc of snap.docs) {
    const trade = doc.data() as TradeDoc
    const expiresAt = toDate(trade.expiresAt)
    if (!expiresAt) continue // no expiresAt at all — nothing to sweep against

    let expiryInstant = expiresAt
    if (trade.weekId && trade.shiftId) {
      const shiftSnap = await shiftRef(trade.weekId, trade.shiftId).get()
      const shift = shiftSnap.exists ? shiftSnap.data() : undefined
      if (shift?.date && shift?.startTime) {
        const shiftStart = instantAtShiftStart(shift.date as string, shift.startTime as string)
        if (shiftStart.getTime() < expiryInstant.getTime()) expiryInstant = shiftStart
      }
    }

    if (now < expiryInstant.getTime()) continue

    await tradeRef(doc.id).update({ status: 'expired', updatedAt: FieldValue.serverTimestamp() })

    const offererId = trade.fromEmployeeId ?? trade.postedBy
    if (!offererId) continue

    const shiftSnap = trade.weekId && trade.shiftId ? await shiftRef(trade.weekId, trade.shiftId).get() : null
    const shift = shiftSnap?.exists ? shiftSnap.data() : undefined
    const roleId = trade.eligibilitySnapshot?.roleId ?? shift?.roleId
    const [roleName] = await Promise.all([roleId ? fetchRoleName(roleId) : Promise.resolve({ en: '', es: '' })])

    const { failed } = await sendPush({
      employeeIds: [offererId],
      category: 'trade.expired',
      params: {
        roleName,
        dateLabel: shift?.date ? formatShiftDateLabel(shift.date as string) : '',
      },
    })
    if (failed.length > 0) {
      logger.error('failed to notify offerer of an expired trade', { tradeId: doc.id, offererId })
      await markPushPending(tradeRef(doc.id), 'trade.expired', failed)
    }
  }
})
