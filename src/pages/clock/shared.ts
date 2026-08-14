import { firebaseErrorCode } from '@/lib/firebaseError'
import { PunchActionRejected } from '@/lib/timeClock/punchActions'
import type { PunchErrorCode } from '@/lib/punchErrors'
import type { Employee } from '@/types/models'

/**
 * Shared helpers for the clock screens (spec §8). Kept out of the flow
 * components so the state machine in ClockPage.tsx stays readable.
 */

export function employeeDisplayName(e: Employee): string {
  const first = e.preferredName?.trim() ? e.preferredName : e.firstName
  return `${first} ${e.lastName}`.trim()
}

/** "HH:mm" 24h (restaurant-local, as stored on Shift) → "3:30 PM". */
export function formatClock12(hhmm: string): string {
  const [hPart, mPart] = hhmm.split(':')
  const h = Number(hPart)
  const m = Number(mPart)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm
  const period = h >= 12 ? 'PM' : 'AM'
  const twelve = h % 12 === 0 ? 12 : h % 12
  return `${twelve}:${String(m).padStart(2, '0')} ${period}`
}

/** Same input, compact form used by the "Recent punches" rows: "3:30p". */
export function formatClock12Compact(hhmm: string): string {
  const [hPart, mPart] = hhmm.split(':')
  const h = Number(hPart)
  const m = Number(mPart)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm
  const period = h >= 12 ? 'p' : 'a'
  const twelve = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${twelve}${period}` : `${twelve}:${String(m).padStart(2, '0')}${period}`
}

/** A Firestore Timestamp-ish value (or a plain unknown) → Date, or null. */
export function toDateOrNull(value: unknown): Date | null {
  if (value && typeof value === 'object' && 'toDate' in value) {
    try {
      return (value as { toDate(): Date }).toDate()
    } catch {
      return null
    }
  }
  return null
}

const KNOWN_PUNCH_ERROR_CODES: readonly PunchErrorCode[] = [
  'punch/clock-not-required',
  'punch/already-open',
  'punch/no-open-punch',
  'punch/selfie-missing',
  'punch/selfie-invalid',
  'punch/selfie-stale',
  'punch/gps-imprecise',
  'punch/outside-geofence',
  'punch/shift-mismatch',
  'punch/tips-required',
  'punch/reason-required',
  'punch/below-level-required',
]

/**
 * A recognized `punch/*` business rejection, or `null` when `err` is a
 * genuine connectivity/infra failure (or anything else) — the offline
 * queue's own contract (`TERMINAL_CODES`) for what counts as "the server
 * definitively said no" vs. "try again once connectivity returns".
 */
export function punchRejectionCode(err: unknown): PunchErrorCode | null {
  if (!(err instanceof PunchActionRejected)) return null
  const code = firebaseErrorCode(err)
  return code && (KNOWN_PUNCH_ERROR_CODES as readonly string[]).includes(code)
    ? (code as PunchErrorCode)
    : null
}

/** i18n suffix for `clock.errors.*` — the code's own tail without the `punch/` namespace. */
export function errorKeyFor(code: PunchErrorCode): string {
  return code.replace('punch/', '')
}

/** Promise wrapper around the callback-based Geolocation API. */
export function getCurrentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('geolocation-unsupported'))
      return
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 0,
    })
  })
}

/** i18n key (under `clock.home.*`) for a failed geolocation attempt. */
export function geoErrorKeyFor(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: number }).code
    if (code === 1) return 'clock.home.geoErrorDenied'
    if (code === 2) return 'clock.home.geoErrorUnavailable'
    if (code === 3) return 'clock.home.geoErrorTimeout'
  }
  return 'clock.home.geoErrorGeneric'
}
