/**
 * Pool-drop notifications — spec §7: "A drops shift → every ELIGIBLE
 * employee gets a push notification ... also write a webhook stub
 * notifyZenZap(payload)."
 *
 * Fires on trade CREATION rather than living in a callable because posting a
 * trade is a plain client write (src/lib/db/trades.ts, permitted directly by
 * firestore.rules) — there is no callable in the request path to hang this
 * off of. The eligibility filter is the same shared `checkTradeEligibility()`
 * every other trade transition uses (via `evaluateEligibility`,
 * `tradeHelpers.ts`) — "eligible" here means the full spec §7 check, not just
 * the coarser same-department visibility firestore.rules' `mayReadTrade`
 * grants for browsing the pool.
 */

import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'

import { COLLECTIONS, db } from './firebase'
import { displayName, type EmployeeDoc, type ShiftDoc, type ShiftRoleDoc, type TradeDoc } from './model'
import { markPushPending, sendPush } from './push'
import { notifyZenZap } from './zenzap'
import {
  activeEmployeesInDepartment,
  evaluateEligibility,
  formatShiftDateLabel,
  formatShiftTime,
  shiftRef,
  toShiftLike,
  tradeRef,
} from './tradeHelpers'

export const onTradeCreated = onDocumentCreated(
  `${COLLECTIONS.trades}/{tradeId}`,
  async (event) => {
    const snap = event.data
    if (!snap) return
    const trade = snap.data() as TradeDoc
    const tradeId = event.params.tradeId

    // Only a fresh pool drop needs the fan-out; a direct offer already names
    // its one recipient, and this trigger only ever sees a trade in its
    // CREATED state (status transitions later don't re-fire onDocumentCreated).
    if (trade.type !== 'pool' || trade.status !== 'open') return
    if (!trade.weekId || !trade.shiftId || !trade.department) {
      logger.error('pool trade missing weekId/shiftId/department; cannot notify', { tradeId })
      return
    }

    const [shiftSnap, roleRolesSnap] = await Promise.all([
      shiftRef(trade.weekId, trade.shiftId).get(),
      trade.eligibilitySnapshot?.roleId
        ? db.collection(COLLECTIONS.shiftRoles).doc(trade.eligibilitySnapshot.roleId).get()
        : Promise.resolve(null),
    ])
    if (!shiftSnap.exists) {
      logger.error('pool trade posted against a shift that does not exist; cannot notify', { tradeId })
      return
    }
    const shift = toShiftLike(trade.shiftId, shiftSnap.data() as ShiftDoc)

    const candidates = await activeEmployeesInDepartment(trade.department, trade.fromEmployeeId ?? null)
    const eligible: string[] = []
    await Promise.all(
      candidates.map(async (employeeId) => {
        const result = await evaluateEligibility(employeeId, trade.weekId as string, shift)
        if (result.eligible) eligible.push(employeeId)
      }),
    )

    if (eligible.length === 0) {
      logger.info('pool drop has no currently-eligible employees to notify', { tradeId })
      return
    }

    const posterId = trade.fromEmployeeId ?? trade.postedBy
    const posterSnap = posterId ? await db.collection(COLLECTIONS.employees).doc(posterId).get() : null
    const posterName = posterSnap?.exists ? displayName(posterSnap.data() as EmployeeDoc) : 'A manager'

    const roleData = roleRolesSnap?.exists ? (roleRolesSnap.data() as ShiftRoleDoc) : null

    const params = {
      posterName,
      roleName: { en: roleData?.name ?? shift.roleId, es: roleData?.nameEs ?? shift.roleId },
      dateLabel: formatShiftDateLabel(shift.date),
      startTime: formatShiftTime(shift.startTime),
      endTime: formatShiftTime(shift.endTime),
    }

    const { failed } = await sendPush({ employeeIds: eligible, category: 'trade.pool-drop', params })
    if (failed.length > 0) await markPushPending(tradeRef(tradeId), 'trade.pool-drop', failed)

    await notifyZenZap({
      eventType: 'trade.pool-drop',
      employeeIds: eligible,
      shift: {
        weekId: trade.weekId,
        shiftId: trade.shiftId,
        date: shift.date,
        startTime: shift.startTime,
        endTime: shift.endTime,
        roleId: shift.roleId,
        department: trade.department,
      },
      deepLink: '/shift-pool',
      occurredAt: new Date().toISOString(),
    })
  },
)
