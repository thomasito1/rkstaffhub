/**
 * Time clock — spec §8. Pattern-matched to scheduleOverride.ts/tradeActions.ts:
 * independently re-verify everything a client claims, atomic writes, no
 * trust in device clocks or client-reported paths.
 *
 * SELFIE + GEOFENCE are both re-verified server-side (punchHelpers.ts) —
 * `verifyGeofence`'s own header explains why the geofence check is honestly
 * just a plausibility filter on the CLAIMED position, and the selfie
 * (verifySelfieUpload — confirms a just-uploaded real JPEG exists at the
 * expected path, not merely that the client claims one does) is the actual
 * control against buddy-punching.
 *
 * OFFLINE QUEUE: a punch captured while offline (src/lib/offlineQueue/) is
 * submitted through these SAME callables once connectivity returns, with
 * `syncedFromOfflineQueue: true` — the geo/accuracy/selfie were captured
 * ATOMICALLY at the original tap, so the same verification applies unchanged;
 * only `timestamp` differs, and only in spirit — it is ALWAYS `serverTimestamp()`
 * at whatever moment this Function actually runs (the sync, for a queued
 * punch), never backdated to the tap. `deviceTimestamp` is what preserves the
 * original tap time for audit.
 *
 * FORGOTTEN CLOCK-OUTS are handled by punchScheduled.ts, not here — that
 * function only ever flags + notifies, never fabricates a close.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

import { COLLECTIONS, db } from './firebase'
import { canAccessSensitive, requirePermission } from './permissions'
import { markAuditPending, writeAudit } from './audit'
import type { EmployeeDoc, PunchDoc } from './model'
import {
  selfieStoragePath,
  throwPunchError,
  todayIsoInRestaurantTz,
  verifyGeofence,
  verifySelfieUpload,
  weekIdForIsoDate,
} from './punchHelpers'

function punchRef(punchId: string) {
  return db.collection(COLLECTIONS.punches).doc(punchId)
}

async function findOpenPunch(employeeId: string) {
  const snap = await db
    .collection(COLLECTIONS.punches)
    .where('employeeId', '==', employeeId)
    .where('type', '==', 'in')
    .where('status', '==', 'open')
    .limit(1)
    .get()
  return snap.docs[0] ?? null
}

/**
 * The employee's shift today, if any. Punch-without-shift is allowed (spec
 * §8) — this only decides whether to link + leave `flagged` false, never
 * whether the punch itself succeeds.
 */
async function findTodaysShift(
  employeeId: string,
): Promise<{ shiftId: string; weekId: string } | null> {
  const today = todayIsoInRestaurantTz()
  const weekId = weekIdForIsoDate(today)
  const snap = await db
    .collection(COLLECTIONS.schedules)
    .doc(weekId)
    .collection('shifts')
    .where('employeeId', '==', employeeId)
    .where('date', '==', today)
    .limit(1)
    .get()
  const doc = snap.docs[0]
  return doc ? { shiftId: doc.id, weekId } : null
}

// ── clockIn ──────────────────────────────────────────────────────────────────

export interface ClockInRequest {
  punchId: string
  lat: number
  lng: number
  accuracy: number
  /** ISO 8601 — what the device's own clock said at the moment of the tap. */
  deviceTimestamp: string
  syncedFromOfflineQueue?: boolean
}

export interface ClockInResponse {
  punchId: string
  shiftId: string | null
  flagged: boolean
}

export const clockIn = onCall<ClockInRequest>(async (request): Promise<ClockInResponse> => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

  const { punchId, lat, lng, accuracy, deviceTimestamp, syncedFromOfflineQueue } = request.data
  if (!punchId || typeof lat !== 'number' || typeof lng !== 'number' || typeof accuracy !== 'number') {
    throw new HttpsError('invalid-argument', 'punchId, lat, lng and accuracy are required.')
  }

  const actor = await requirePermission(uid, 'timeclock.punchSelf')
  if (!actor.employee.clockRequired) {
    throwPunchError('failed-precondition', 'punch/clock-not-required', 'You are not set up to use the time clock.')
  }

  const existingOpen = await findOpenPunch(actor.id)
  if (existingOpen) {
    throwPunchError('failed-precondition', 'punch/already-open', 'You are already clocked in.')
  }

  await verifySelfieUpload(selfieStoragePath(actor.id, punchId))
  const geo = await verifyGeofence(lat, lng, accuracy)

  const todaysShift = await findTodaysShift(actor.id)
  const shiftId = todaysShift?.shiftId ?? null
  const flagged = shiftId === null
  const flagReason = flagged ? 'no-scheduled-shift' : null

  await punchRef(punchId).create({
    employeeId: actor.id,
    shiftId,
    type: 'in',
    status: 'open',
    timestamp: FieldValue.serverTimestamp(),
    deviceTimestamp,
    geo: { lat, lng, accuracy, insideFence: geo.insideFence },
    selfieStoragePath: selfieStoragePath(actor.id, punchId),
    manualBy: null,
    manualReason: null,
    flagged,
    flagReason,
    syncedFromOfflineQueue: Boolean(syncedFromOfflineQueue),
    editHistory: [],
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })

  return { punchId, shiftId, flagged }
})

// ── clockOut ─────────────────────────────────────────────────────────────────

export interface ClockOutRequest {
  punchId: string
  lat: number
  lng: number
  accuracy: number
  deviceTimestamp: string
  /** Required when the employee's tipsRequired is true — $0 is a valid, explicit value. */
  tipsAmount?: number
  syncedFromOfflineQueue?: boolean
}

export interface ClockOutResponse {
  punchId: string
  shiftId: string | null
}

export const clockOut = onCall<ClockOutRequest>(async (request): Promise<ClockOutResponse> => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

  const { punchId, lat, lng, accuracy, deviceTimestamp, tipsAmount, syncedFromOfflineQueue } = request.data
  if (!punchId || typeof lat !== 'number' || typeof lng !== 'number' || typeof accuracy !== 'number') {
    throw new HttpsError('invalid-argument', 'punchId, lat, lng and accuracy are required.')
  }

  const actor = await requirePermission(uid, 'timeclock.punchSelf')

  const openDoc = await findOpenPunch(actor.id)
  if (!openDoc) {
    throwPunchError('failed-precondition', 'punch/no-open-punch', 'You are not currently clocked in.')
  }
  const openPunch = openDoc.data() as PunchDoc

  if (actor.employee.tipsRequired) {
    if (typeof tipsAmount !== 'number' || tipsAmount < 0) {
      throwPunchError(
        'invalid-argument',
        'punch/tips-required',
        'Enter your total tips for this shift before clocking out.',
      )
    }
  }

  await verifySelfieUpload(selfieStoragePath(actor.id, punchId))
  const geo = await verifyGeofence(lat, lng, accuracy)

  const shiftId = openPunch.shiftId ?? null

  await db.runTransaction(async (tx) => {
    const freshOpen = await tx.get(openDoc.ref)
    if (!freshOpen.exists || (freshOpen.data() as PunchDoc).status !== 'open') {
      throwPunchError('failed-precondition', 'punch/no-open-punch', 'You are not currently clocked in.')
    }
    tx.update(openDoc.ref, { status: 'closed', updatedAt: FieldValue.serverTimestamp() })
    tx.create(punchRef(punchId), {
      employeeId: actor.id,
      shiftId,
      type: 'out',
      timestamp: FieldValue.serverTimestamp(),
      deviceTimestamp,
      geo: { lat, lng, accuracy, insideFence: geo.insideFence },
      selfieStoragePath: selfieStoragePath(actor.id, punchId),
      manualBy: null,
      manualReason: null,
      flagged: false,
      flagReason: null,
      syncedFromOfflineQueue: Boolean(syncedFromOfflineQueue),
      editHistory: [],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

    if (actor.employee.tipsRequired) {
      const tipRef = db.collection(COLLECTIONS.tipReports).doc()
      tx.create(tipRef, {
        employeeId: actor.id,
        date: todayIsoInRestaurantTz(),
        shiftId,
        amount: tipsAmount,
        reportedAt: FieldValue.serverTimestamp(),
        editedBy: null,
        editHistory: [],
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
    }
  })

  return { punchId, shiftId }
})

// ── manualPunch ──────────────────────────────────────────────────────────────

export interface ManualPunchRequest {
  employeeId: string
  type: 'in' | 'out'
  reason: string
  /** Optional — a manager may know the tip total for an 'out' punch; otherwise it's left for a later correction (Shifts & Tips admin). */
  tipsAmount?: number
}

export interface ManualPunchResponse {
  punchId: string
}

export const manualPunch = onCall<ManualPunchRequest>(
  async (request): Promise<ManualPunchResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { employeeId, type } = request.data
    const reason = request.data.reason?.trim()
    if (!employeeId || (type !== 'in' && type !== 'out')) {
      throw new HttpsError('invalid-argument', 'employeeId and a valid type are required.')
    }
    if (!reason) {
      throwPunchError('invalid-argument', 'punch/reason-required', 'A reason is required for a manual punch.')
    }

    const actor = await requirePermission(uid, 'punches.edit')

    const targetSnap = await db.collection(COLLECTIONS.employees).doc(employeeId).get()
    if (!targetSnap.exists) throw new HttpsError('not-found', 'That employee does not exist.')
    const target = targetSnap.data() as EmployeeDoc
    if (
      !target.accessRole ||
      !canAccessSensitive(actor, { id: employeeId, accessRole: target.accessRole })
    ) {
      throwPunchError(
        'permission-denied',
        'punch/below-level-required',
        'You may only create a manual punch for someone below your access level.',
      )
    }

    const punchRefNew = db.collection(COLLECTIONS.punches).doc()
    const todaysShift = await findTodaysShift(employeeId)
    const shiftId = todaysShift?.shiftId ?? null

    if (type === 'in') {
      const existingOpen = await findOpenPunch(employeeId)
      if (existingOpen) {
        throwPunchError('failed-precondition', 'punch/already-open', 'This employee is already clocked in.')
      }
      await punchRefNew.create({
        employeeId,
        shiftId,
        type: 'in',
        status: 'open',
        timestamp: FieldValue.serverTimestamp(),
        deviceTimestamp: FieldValue.serverTimestamp(),
        geo: null,
        selfieStoragePath: null,
        manualBy: actor.id,
        manualReason: reason,
        flagged: shiftId === null,
        flagReason: shiftId === null ? 'no-scheduled-shift' : null,
        editHistory: [],
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      })
    } else {
      const openDoc = await findOpenPunch(employeeId)
      if (!openDoc) {
        throwPunchError('failed-precondition', 'punch/no-open-punch', 'This employee is not currently clocked in.')
      }
      const openPunch = openDoc.data() as PunchDoc
      const outShiftId = openPunch.shiftId ?? shiftId

      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(openDoc.ref)
        if (!fresh.exists || (fresh.data() as PunchDoc).status !== 'open') {
          throwPunchError('failed-precondition', 'punch/no-open-punch', 'This employee is not currently clocked in.')
        }
        tx.update(openDoc.ref, { status: 'closed', updatedAt: FieldValue.serverTimestamp() })
        tx.create(punchRefNew, {
          employeeId,
          shiftId: outShiftId,
          type: 'out',
          timestamp: FieldValue.serverTimestamp(),
          deviceTimestamp: FieldValue.serverTimestamp(),
          geo: null,
          selfieStoragePath: null,
          manualBy: actor.id,
          manualReason: reason,
          flagged: false,
          flagReason: null,
          editHistory: [],
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        })

        if (typeof request.data.tipsAmount === 'number' && request.data.tipsAmount >= 0) {
          const tipRef = db.collection(COLLECTIONS.tipReports).doc()
          tx.create(tipRef, {
            employeeId,
            date: todayIsoInRestaurantTz(),
            shiftId: outShiftId,
            amount: request.data.tipsAmount,
            reportedAt: FieldValue.serverTimestamp(),
            editedBy: actor.id,
            editHistory: [],
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          })
        }
      })
    }

    const audited = await writeAudit({
      action: 'punch.edit',
      actorEmployeeId: actor.id,
      actorUid: uid,
      targetType: 'punch',
      targetId: punchRefNew.id,
      reason,
      before: null,
      after: { employeeId, type, manual: true },
    })
    if (!audited) await markAuditPending(punchRefNew, 'punch.edit')

    return { punchId: punchRefNew.id }
  },
)
