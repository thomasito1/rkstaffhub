/**
 * Offline punch queue — spec §15: "punches queue and sync, clearly marked
 * 'pending sync'" through a brief connectivity gap.
 *
 * THE CONTRACT: everything a punch needs — the selfie blob, geo, accuracy,
 * and device timestamp (and, for a tipped clock-out, the tip amount) — is
 * captured ATOMICALLY the moment the user taps Clock In/Out, before this
 * module is ever involved. Queuing never re-captures anything later; it only
 * ever replays exactly what was captured at tap time. This is what makes a
 * synced punch's `deviceTimestamp` meaningful — it reflects when the person
 * actually acted, not when the network happened to come back.
 *
 * The client-side geofence pre-check (display-only — see src/lib/geofence.ts)
 * still runs before queuing even while offline, using whatever `settings/app`
 * value is already cached locally: an attempt outside the fence is refused at
 * tap time and never reaches this queue at all. A queued item can therefore
 * still fail server-side re-verification (settings changed underneath it,
 * the employee was clocked in/out from another device meanwhile) — those are
 * TERMINAL, not retried; only genuine connectivity failures are.
 */
import { openDB, type IDBPDatabase } from 'idb'

import { clockIn, clockOut, PunchActionRejected } from '@/lib/timeClock/punchActions'
import { uploadPunchSelfie } from '@/lib/timeClock/selfieUpload'
import type { PunchErrorCode } from '@/lib/punchErrors'

export interface QueuedPunch {
  punchId: string
  kind: 'in' | 'out'
  employeeId: string
  selfieBlob: Blob
  lat: number
  lng: number
  accuracy: number
  /** ISO 8601, captured at tap time. */
  deviceTimestamp: string
  /** Clock-out only, tipped employees only — entered at tap time, same as everything else here. */
  tipsAmount?: number
  queuedAt: string
}

const DB_NAME = 'rk-staffhub-punch-queue'
const STORE = 'queued-punches'

/**
 * Rejections that mean the state already resolved some other way (a live
 * clock-in on another device, settings changed) — retrying changes nothing,
 * so these are dropped rather than retried forever.
 */
const TERMINAL_CODES: readonly PunchErrorCode[] = [
  'punch/already-open',
  'punch/no-open-punch',
  'punch/clock-not-required',
  'punch/outside-geofence',
  'punch/gps-imprecise',
]

let dbPromise: Promise<IDBPDatabase> | null = null

function getDb(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(database) {
      database.createObjectStore(STORE, { keyPath: 'punchId' })
    },
  })
  return dbPromise
}

export async function queuePunch(item: QueuedPunch): Promise<void> {
  const idb = await getDb()
  await idb.put(STORE, item)
}

export async function listQueuedPunches(): Promise<QueuedPunch[]> {
  const idb = await getDb()
  const items = await idb.getAll(STORE)
  return items.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
}

export async function removeQueuedPunch(punchId: string): Promise<void> {
  const idb = await getDb()
  await idb.delete(STORE, punchId)
}

export interface SyncResult {
  synced: string[]
  /** Terminal rejections — the punch could not go through and won't be retried; the UI should tell the employee. */
  dropped: { punchId: string; code: PunchErrorCode | 'unknown' }[]
  /** Still queued — a genuine connectivity failure, try again next time. */
  stillQueued: string[]
}

/**
 * Replays every queued punch in the order it was captured. Never throws —
 * each item's own failure is reported, not propagated, so one bad item can't
 * stop the rest of the queue from syncing.
 */
export async function syncQueuedPunches(): Promise<SyncResult> {
  const items = await listQueuedPunches()
  const result: SyncResult = { synced: [], dropped: [], stillQueued: [] }

  for (const item of items) {
    try {
      await uploadPunchSelfie(item.employeeId, item.punchId, item.selfieBlob)

      if (item.kind === 'in') {
        await clockIn({
          punchId: item.punchId,
          lat: item.lat,
          lng: item.lng,
          accuracy: item.accuracy,
          deviceTimestamp: item.deviceTimestamp,
          syncedFromOfflineQueue: true,
        })
      } else {
        await clockOut({
          punchId: item.punchId,
          lat: item.lat,
          lng: item.lng,
          accuracy: item.accuracy,
          deviceTimestamp: item.deviceTimestamp,
          tipsAmount: item.tipsAmount,
          syncedFromOfflineQueue: true,
        })
      }

      await removeQueuedPunch(item.punchId)
      result.synced.push(item.punchId)
    } catch (err) {
      if (err instanceof PunchActionRejected) {
        const detailCode =
          err.details && typeof err.details === 'object' && 'code' in err.details
            ? (err.details as { code?: unknown }).code
            : undefined
        const code = typeof detailCode === 'string' ? (detailCode as PunchErrorCode) : 'unknown'
        if (TERMINAL_CODES.includes(code as PunchErrorCode)) {
          await removeQueuedPunch(item.punchId)
          result.dropped.push({ punchId: item.punchId, code })
          continue
        }
      }
      // Storage upload failure, or a non-terminal Function rejection — keep
      // queued, try again next sync.
      result.stillQueued.push(item.punchId)
    }
  }

  return result
}
