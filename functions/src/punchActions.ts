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

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
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
 * The employee's shift on `date` (restaurant-local "YYYY-MM-DD"), if any.
 * Punch-without-shift is allowed (spec §8) — this only decides whether to
 * link + leave `flagged` false, never whether the punch itself succeeds.
 *
 * Takes an explicit date rather than always assuming "today": `manualPunch`
 * can legitimately backdate (mockup 24 — a shift the employee never punched
 * at all, added after the fact), and looking up TODAY's shift for a
 * backdated punch would both miss the real shift (wrongly flagging
 * `no-scheduled-shift`) and query the wrong week entirely.
 */
async function findShiftForDate(
  employeeId: string,
  date: string,
): Promise<{ shiftId: string; weekId: string } | null> {
  const weekId = weekIdForIsoDate(date)
  const snap = await db
    .collection(COLLECTIONS.schedules)
    .doc(weekId)
    .collection('shifts')
    .where('employeeId', '==', employeeId)
    .where('date', '==', date)
    .limit(1)
    .get()
  const doc = snap.docs[0]
  return doc ? { shiftId: doc.id, weekId } : null
}

/** Restaurant-local "YYYY-MM-DD" for a punch's own instant — the date it actually happened, not "today". */
function isoDateOf(instant: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(instant))
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

  const todaysShift = await findShiftForDate(actor.id, todayIsoInRestaurantTz())
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
  reason: string
  /**
   * ISO 8601. At least one of clockIn/clockOut is required. Both together
   * creates a complete pair in one call (mockup 24 — "add a manual punch"
   * for a shift the employee never punched at all); either alone behaves
   * like the single-sided open/close it names.
   */
  clockIn?: string
  clockOut?: string
  /** Optional — a manager may know the tip total already; otherwise it's left for a later correction via editTipReport. */
  tipsAmount?: number
}

export interface ManualPunchResponse {
  punchIds: string[]
}

async function requireBelowLevelTarget(
  actor: Awaited<ReturnType<typeof requirePermission>>,
  employeeId: string,
): Promise<void> {
  const targetSnap = await db.collection(COLLECTIONS.employees).doc(employeeId).get()
  if (!targetSnap.exists) throw new HttpsError('not-found', 'That employee does not exist.')
  const target = targetSnap.data() as EmployeeDoc
  if (!target.accessRole || !canAccessSensitive(actor, { id: employeeId, accessRole: target.accessRole })) {
    throwPunchError(
      'permission-denied',
      'punch/below-level-required',
      'You may only act on a punch for someone below your access level.',
    )
  }
}

export const manualPunch = onCall<ManualPunchRequest>(
  async (request): Promise<ManualPunchResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { employeeId, clockIn, clockOut } = request.data
    const reason = request.data.reason?.trim()
    if (!employeeId || (!clockIn && !clockOut)) {
      throw new HttpsError('invalid-argument', 'employeeId and at least one of clockIn/clockOut are required.')
    }
    if (!reason) {
      throwPunchError('invalid-argument', 'punch/reason-required', 'A reason is required for a manual punch.')
    }

    const actor = await requirePermission(uid, 'punches.edit')
    await requireBelowLevelTarget(actor, employeeId)

    // The shift lookup uses the punch's OWN date, not "today" — manualPunch
    // routinely backdates (mockup 24), and today's shift would both miss the
    // real one (wrongly flagging no-scheduled-shift) and query the wrong week.
    const shiftLookupDate = isoDateOf(clockIn ?? (clockOut as string))
    const todaysShift = await findShiftForDate(employeeId, shiftLookupDate)
    const shiftId = todaysShift?.shiftId ?? null
    const punchIds: string[] = []

    const basePunch = (type: 'in' | 'out', at: string, status?: 'open' | 'closed') => ({
      employeeId,
      shiftId,
      type,
      ...(status ? { status } : {}),
      timestamp: Timestamp.fromDate(new Date(at)),
      deviceTimestamp: Timestamp.fromDate(new Date(at)),
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

    if (clockIn && clockOut) {
      // A complete pair, e.g. an employee who never punched at all that day.
      const existingOpen = await findOpenPunch(employeeId)
      if (existingOpen) {
        throwPunchError(
          'failed-precondition',
          'punch/already-open',
          'This employee already has an open punch — resolve that first.',
        )
      }
      const inRef = db.collection(COLLECTIONS.punches).doc()
      const outRef = db.collection(COLLECTIONS.punches).doc()
      await db.runTransaction(async (tx) => {
        tx.create(inRef, basePunch('in', clockIn, 'closed'))
        tx.create(outRef, basePunch('out', clockOut))
        if (typeof request.data.tipsAmount === 'number' && request.data.tipsAmount >= 0) {
          tx.create(db.collection(COLLECTIONS.tipReports).doc(), {
            employeeId,
            date: isoDateOf(clockOut),
            shiftId,
            amount: request.data.tipsAmount,
            reportedAt: FieldValue.serverTimestamp(),
            editedBy: actor.id,
            editHistory: [],
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          })
        }
      })
      punchIds.push(inRef.id, outRef.id)
    } else if (clockIn) {
      const existingOpen = await findOpenPunch(employeeId)
      if (existingOpen) {
        throwPunchError('failed-precondition', 'punch/already-open', 'This employee is already clocked in.')
      }
      const inRef = db.collection(COLLECTIONS.punches).doc()
      await inRef.create(basePunch('in', clockIn, 'open'))
      punchIds.push(inRef.id)
    } else {
      const openDoc = await findOpenPunch(employeeId)
      if (!openDoc) {
        throwPunchError('failed-precondition', 'punch/no-open-punch', 'This employee is not currently clocked in.')
      }
      const openPunch = openDoc.data() as PunchDoc
      const outShiftId = openPunch.shiftId ?? shiftId
      const outRef = db.collection(COLLECTIONS.punches).doc()

      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(openDoc.ref)
        if (!fresh.exists || (fresh.data() as PunchDoc).status !== 'open') {
          throwPunchError('failed-precondition', 'punch/no-open-punch', 'This employee is not currently clocked in.')
        }
        tx.update(openDoc.ref, { status: 'closed', updatedAt: FieldValue.serverTimestamp() })
        tx.create(outRef, { ...basePunch('out', clockOut as string), shiftId: outShiftId })
        if (typeof request.data.tipsAmount === 'number' && request.data.tipsAmount >= 0) {
          tx.create(db.collection(COLLECTIONS.tipReports).doc(), {
            employeeId,
            date: isoDateOf(clockOut as string),
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
      punchIds.push(outRef.id)
    }

    const audited = await writeAudit({
      action: 'punch.edit',
      actorEmployeeId: actor.id,
      actorUid: uid,
      targetType: 'punch',
      targetId: punchIds.join(','),
      reason,
      before: null,
      after: { employeeId, clockIn: clockIn ?? null, clockOut: clockOut ?? null, manual: true },
    })
    if (!audited) {
      for (const id of punchIds) await markAuditPending(punchRef(id), 'punch.edit')
    }

    return { punchIds }
  },
)

// ── editPunch ────────────────────────────────────────────────────────────────

export interface EditPunchRequest {
  punchId: string
  /** ISO 8601. */
  newTimestamp: string
  reason: string
}

export interface EditPunchResponse {
  punchId: string
}

/** Corrects a punch's recorded time — spec §9. Never touches type/employeeId/shiftId; those are facts, not the clock reading. */
export const editPunch = onCall<EditPunchRequest>(async (request): Promise<EditPunchResponse> => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

  const { punchId, newTimestamp } = request.data
  const reason = request.data.reason?.trim()
  if (!punchId || !newTimestamp) {
    throw new HttpsError('invalid-argument', 'punchId and newTimestamp are required.')
  }
  if (!reason) {
    throwPunchError('invalid-argument', 'punch/reason-required', 'A reason is required to edit a punch.')
  }

  const actor = await requirePermission(uid, 'punches.edit')

  const snap = await punchRef(punchId).get()
  if (!snap.exists) throw new HttpsError('not-found', 'That punch no longer exists.')
  const punch = snap.data() as PunchDoc & { employeeId: string; timestamp: FirebaseFirestore.Timestamp }
  await requireBelowLevelTarget(actor, punch.employeeId)

  const oldTimestamp = punch.timestamp
  const newTs = Timestamp.fromDate(new Date(newTimestamp))
  const historyEntry = { by: actor.id, at: Timestamp.now(), oldTimestamp, newTimestamp: newTs, reason }

  await punchRef(punchId).update({
    timestamp: newTs,
    editedBy: actor.id,
    editHistory: FieldValue.arrayUnion(historyEntry),
    updatedAt: FieldValue.serverTimestamp(),
  })

  const audited = await writeAudit({
    action: 'punch.edit',
    actorEmployeeId: actor.id,
    actorUid: uid,
    targetType: 'punch',
    targetId: punchId,
    reason,
    before: { timestamp: oldTimestamp.toDate().toISOString() },
    after: { timestamp: newTimestamp },
  })
  if (!audited) await markAuditPending(punchRef(punchId), 'punch.edit')

  return { punchId }
})

// ── editTipReport ────────────────────────────────────────────────────────────

export interface EditTipReportRequest {
  /** Provide to edit an existing report. */
  tipReportId?: string
  /** Provide employeeId + date instead to CREATE one where none exists yet (the "missing tip report" flag's resolution). */
  employeeId?: string
  date?: string
  shiftId?: string | null
  newAmount: number
  reason: string
}

export interface EditTipReportResponse {
  tipReportId: string
}

export const editTipReport = onCall<EditTipReportRequest>(
  async (request): Promise<EditTipReportResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { tipReportId, employeeId, date, shiftId, newAmount } = request.data
    const reason = request.data.reason?.trim()
    if (typeof newAmount !== 'number' || newAmount < 0) {
      throw new HttpsError('invalid-argument', 'newAmount must be a non-negative number.')
    }
    if (!reason) {
      throwPunchError('invalid-argument', 'punch/reason-required', 'A reason is required to edit a tip report.')
    }
    if (!tipReportId && !(employeeId && date)) {
      throw new HttpsError('invalid-argument', 'Provide tipReportId, or employeeId + date to create one.')
    }

    const actor = await requirePermission(uid, 'tips.edit')

    if (tipReportId) {
      const ref = db.collection(COLLECTIONS.tipReports).doc(tipReportId)
      const snap = await ref.get()
      if (!snap.exists) throw new HttpsError('not-found', 'That tip report no longer exists.')
      const report = snap.data() as { employeeId: string; amount: number }
      await requireBelowLevelTarget(actor, report.employeeId)

      const oldAmount = report.amount
      const historyEntry = { by: actor.id, at: Timestamp.now(), oldAmount, newAmount, reason }
      await ref.update({
        amount: newAmount,
        editedBy: actor.id,
        editHistory: FieldValue.arrayUnion(historyEntry),
        updatedAt: FieldValue.serverTimestamp(),
      })

      const audited = await writeAudit({
        action: 'tip.edit',
        actorEmployeeId: actor.id,
        actorUid: uid,
        targetType: 'tipReport',
        targetId: tipReportId,
        reason,
        before: { amount: oldAmount },
        after: { amount: newAmount },
      })
      if (!audited) await markAuditPending(ref, 'tip.edit')

      return { tipReportId }
    }

    await requireBelowLevelTarget(actor, employeeId as string)
    const ref = db.collection(COLLECTIONS.tipReports).doc()
    const historyEntry = { by: actor.id, at: Timestamp.now(), oldAmount: 0, newAmount, reason }
    await ref.set({
      employeeId,
      date,
      shiftId: shiftId ?? null,
      amount: newAmount,
      reportedAt: FieldValue.serverTimestamp(),
      editedBy: actor.id,
      editHistory: [historyEntry],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

    const audited = await writeAudit({
      action: 'tip.edit',
      actorEmployeeId: actor.id,
      actorUid: uid,
      targetType: 'tipReport',
      targetId: ref.id,
      reason,
      before: { amount: 0 },
      after: { amount: newAmount },
    })
    if (!audited) await markAuditPending(ref, 'tip.edit')

    return { tipReportId: ref.id }
  },
)
