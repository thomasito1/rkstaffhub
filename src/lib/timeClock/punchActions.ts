/**
 * Client wrappers for the punch Cloud Functions — see
 * `functions/src/punchActions.ts` for what each independently re-verifies
 * (selfie upload, server-side geofence) and why clock-in/out cannot be plain
 * client writes (firestore.rules: punches are Cloud-Function-only).
 */
import { httpsCallable, type FunctionsError } from 'firebase/functions'
import { functions } from '@/lib/firebase'

export class PunchActionRejected extends Error {
  constructor(
    message: string,
    public readonly code: FunctionsError['code'],
    /** Carries `{ code: PunchErrorCode }` when the Function set one — see firebaseError.ts. */
    public readonly details: unknown,
  ) {
    super(message)
    this.name = 'PunchActionRejected'
  }
}

async function callPunchAction<Req, Res>(name: string, input: Req): Promise<Res> {
  const call = httpsCallable<Req, Res>(functions, name)
  try {
    const res = await call(input)
    return res.data
  } catch (err) {
    const fnErr = err as FunctionsError
    throw new PunchActionRejected(fnErr.message ?? 'Punch action failed', fnErr.code, fnErr.details)
  }
}

export interface ClockInInput {
  punchId: string
  lat: number
  lng: number
  accuracy: number
  /** ISO 8601 — captured at the moment of the tap, atomically with lat/lng/accuracy and the selfie. */
  deviceTimestamp: string
  /** True only when submitted via the offline queue's sync, not a live tap. */
  syncedFromOfflineQueue?: boolean
}

export interface ClockInResult {
  punchId: string
  shiftId: string | null
  flagged: boolean
}

export function clockIn(input: ClockInInput): Promise<ClockInResult> {
  return callPunchAction('clockIn', input)
}

export interface ClockOutInput {
  punchId: string
  lat: number
  lng: number
  accuracy: number
  deviceTimestamp: string
  /** Required when the employee's tipsRequired is true — $0 is a valid, explicit value. */
  tipsAmount?: number
  syncedFromOfflineQueue?: boolean
}

export interface ClockOutResult {
  punchId: string
  shiftId: string | null
}

export function clockOut(input: ClockOutInput): Promise<ClockOutResult> {
  return callPunchAction('clockOut', input)
}

export interface ManualPunchInput {
  employeeId: string
  reason: string
  /** ISO 8601. At least one of clockIn/clockOut is required; both together creates a complete pair in one call. */
  clockIn?: string
  clockOut?: string
  tipsAmount?: number
}

export interface ManualPunchResult {
  punchIds: string[]
}

/** Manager-only (`punches.edit`, below-level) — bypasses geofence + selfie by design (spec §8). */
export function manualPunch(input: ManualPunchInput): Promise<ManualPunchResult> {
  return callPunchAction('manualPunch', input)
}

export interface EditPunchInput {
  punchId: string
  /** ISO 8601. */
  newTimestamp: string
  reason: string
}

export interface EditPunchResult {
  punchId: string
}

/** Corrects a punch's recorded time (`punches.edit`, below-level) — spec §9. */
export function editPunch(input: EditPunchInput): Promise<EditPunchResult> {
  return callPunchAction('editPunch', input)
}

export interface EditTipReportInput {
  tipReportId?: string
  employeeId?: string
  date?: string
  shiftId?: string | null
  newAmount: number
  reason: string
}

export interface EditTipReportResult {
  tipReportId: string
}

/** Edits an existing tip report, or creates one where none exists (`tips.edit`, below-level) — spec §9. */
export function editTipReport(input: EditTipReportInput): Promise<EditTipReportResult> {
  return callPunchAction('editTipReport', input)
}
