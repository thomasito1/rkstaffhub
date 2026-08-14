/**
 * Firestore/Storage glue for the punch callables (punchActions.ts,
 * punchScheduled.ts) — geofence math itself is shared (./geofence.ts,
 * symlinked from src/lib/geofence.ts); everything here is plumbing specific
 * to this package.
 *
 * `weekIdForIsoDate`/`addDaysToIsoDate` are a deliberate small duplicate of
 * src/lib/deadlines.ts's own functions, NOT a case the "one shared
 * implementation" ruling (tradeEligibility.ts) covers — deadlines.ts pulls in
 * src/lib/format.ts's i18n bootstrapping transitively, which has no business
 * being reachable from a Cloud Function. This is a few lines of pure calendar
 * string math, not business logic; keep them byte-for-byte identical to
 * deadlines.ts's versions if either ever changes.
 */

import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https'

import { COLLECTIONS, db, storage } from './firebase'
import { MAX_PLAUSIBLE_ACCURACY_METERS, checkGeofence, type GeofenceCheck } from './geofence'
import type { AppSettingsDoc } from './model'
import type { PunchErrorCode } from './punchErrors'

export function throwPunchError(
  httpsCode: FunctionsErrorCode,
  punchCode: PunchErrorCode,
  message: string,
): never {
  throw new HttpsError(httpsCode, message, { code: punchCode })
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

function parseIsoDate(isoDate: string): { year: number; month: number; day: number } {
  const parts = isoDate.split('-').map(Number)
  return { year: parts[0] ?? 0, month: parts[1] ?? 1, day: parts[2] ?? 1 }
}

/** See the file header — kept identical to deadlines.ts's own version. */
export function addDaysToIsoDate(isoDate: string, days: number): string {
  const { year, month, day } = parseIsoDate(isoDate)
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY)
  return shifted.toISOString().slice(0, 10)
}

/** See the file header — kept identical to deadlines.ts's own version. */
export function weekIdForIsoDate(isoDate: string): string {
  const { year, month, day } = parseIsoDate(isoDate)
  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return addDaysToIsoDate(isoDate, utcDay === 0 ? -6 : 1 - utcDay)
}

/** "YYYY-MM-DD" for today in the restaurant's own timezone (spec: all deadline logic is America/New_York). */
export function todayIsoInRestaurantTz(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date())
}

/** "YYYY-MM" for the punch-selfie Storage path (storage.rules' punch-selfies/{employeeId}/{yyyy-mm}/{punchId}.jpg). */
export function yearMonthInRestaurantTz(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date())
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000'
  const month = parts.find((p) => p.type === 'month')?.value ?? '00'
  return `${year}-${month}`
}

export function selfieStoragePath(employeeId: string, punchId: string): string {
  return `punch-selfies/${employeeId}/${yearMonthInRestaurantTz()}/${punchId}.jpg`
}

const SELFIE_FRESHNESS_MS = 5 * 60 * 1000

/**
 * Confirms a real, just-uploaded JPEG sits at the expected path — never trust
 * a client-supplied path string alone. `timeCreated` must be recent: without
 * this, a client could point at an old selfie from a prior punch and skip
 * ever uploading a new one.
 */
export async function verifySelfieUpload(path: string): Promise<void> {
  let metadata: { size?: string | number; contentType?: string; timeCreated?: string }
  try {
    ;[metadata] = await storage.bucket().file(path).getMetadata()
  } catch {
    throwPunchError('failed-precondition', 'punch/selfie-missing', 'No selfie was found for this punch.')
  }

  const size = Number(metadata.size ?? 0)
  if (!(size > 0) || !metadata.contentType?.match(/^image\/jpe?g$/)) {
    throwPunchError('failed-precondition', 'punch/selfie-invalid', 'That selfie upload is not a valid image.')
  }

  const uploadedAt = metadata.timeCreated ? new Date(metadata.timeCreated).getTime() : 0
  if (!uploadedAt || Date.now() - uploadedAt > SELFIE_FRESHNESS_MS) {
    throwPunchError(
      'failed-precondition',
      'punch/selfie-stale',
      'That selfie is too old for this punch — take a new one.',
    )
  }
}

/**
 * The canonical geofence decision — computed here, never trusted from the
 * client. See geofence.ts's own header: this validates the CLAIMED position;
 * the selfie is the actual anti-buddy-punching control.
 */
export async function verifyGeofence(
  lat: number,
  lng: number,
  accuracy: number,
): Promise<GeofenceCheck> {
  if (accuracy > MAX_PLAUSIBLE_ACCURACY_METERS) {
    throwPunchError(
      'failed-precondition',
      'punch/gps-imprecise',
      'Your location is not precise enough to clock in — move somewhere with a clearer GPS signal and try again.',
    )
  }

  const settingsSnap = await db.collection(COLLECTIONS.settings).doc('app').get()
  const settings = settingsSnap.data() as AppSettingsDoc | undefined
  const geofence = settings?.geofence
  if (!geofence) {
    throwPunchError('failed-precondition', 'punch/outside-geofence', 'The clock-in location is not configured yet.')
  }

  const result = checkGeofence({ lat, lng }, { lat: geofence.lat, lng: geofence.lng }, geofence.radiusMeters)
  if (!result.insideFence) {
    throwPunchError(
      'failed-precondition',
      'punch/outside-geofence',
      "You're too far from the restaurant to clock in from here.",
    )
  }
  return result
}
