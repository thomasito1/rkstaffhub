/**
 * Forgotten-clockout sweep — spec §8: "forgotten clock-out auto-flags after
 * 14h open punch and notifies managers."
 *
 * FLAGS AND NOTIFIES ONLY. Never closes the punch or invents an out-time —
 * an open punch this old already means something went wrong (an actual
 * forgotten clock-out, a lost connection, a no-show they never punched for);
 * guessing at when they actually left would silently corrupt a pay record
 * that a human needs to look at and resolve deliberately (via a manual edit,
 * Shifts & Tips admin — editHistory required either way). Runs hourly rather
 * than exactly at the 14h mark — the cost of being flagged an hour late is
 * nothing; the cost of a scheduled function silently missing its one exact
 * moment would be a punch that never gets flagged at all.
 */

import { Timestamp } from 'firebase-admin/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'

import { COLLECTIONS, db } from './firebase'
import { displayName, type EmployeeDoc, type PunchDoc } from './model'
import { sendPush } from './push'
import { todayIsoInRestaurantTz } from './punchHelpers'

const FORGOTTEN_THRESHOLD_MS = 14 * 60 * 60 * 1000

export const checkForgottenClockOuts = onSchedule('every 60 minutes', async () => {
  const cutoff = Timestamp.fromMillis(Date.now() - FORGOTTEN_THRESHOLD_MS)

  const snap = await db
    .collection(COLLECTIONS.punches)
    .where('type', '==', 'in')
    .where('status', '==', 'open')
    .where('flagged', '==', false)
    .where('timestamp', '<=', cutoff)
    .get()

  if (snap.empty) return

  for (const doc of snap.docs) {
    const punch = doc.data() as PunchDoc
    if (!punch.employeeId) continue

    await doc.ref.update({ flagged: true, flagReason: 'forgotten-clockout' })

    const employeeSnap = await db.collection(COLLECTIONS.employees).doc(punch.employeeId).get()
    if (!employeeSnap.exists) continue
    const employee = employeeSnap.data() as EmployeeDoc
    if (!employee.department) continue

    const managersSnap = await db
      .collection(COLLECTIONS.employees)
      .where('department', '==', employee.department)
      .where('status', '==', 'active')
      .where('accessRole', 'in', ['manager', 'gm', 'owner'])
      .get()
    const managerIds = managersSnap.docs.map((d) => d.id)
    if (managerIds.length === 0) continue

    const { failed } = await sendPush({
      employeeIds: managerIds,
      category: 'punch.forgotten',
      params: { employeeName: displayName(employee), dateLabel: todayIsoInRestaurantTz() },
    })
    if (failed.length > 0) {
      logger.error('failed to notify some managers about a forgotten clock-out', {
        punchId: doc.id,
        employeeId: punch.employeeId,
        failed,
      })
    }
  }
})
