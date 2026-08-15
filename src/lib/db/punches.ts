/**
 * Punch data access — spec §8, §9, §17.
 *
 * Punches are Cloud-Function-only for every write (firestore.rules: `allow
 * create, update, delete: if false`) — this module is READS ONLY. Creation
 * lives in `src/lib/timeClock/punchActions.ts`, the clockIn/clockOut/
 * manualPunch Cloud Function wrappers.
 */
import {
  collection,
  getDocs,
  orderBy,
  query,
  Timestamp,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import type { AccessRole, Department, Punch, PunchGeo } from '@/types/models'

import { isPermissionDenied } from './errors'

/** The minimal caller shape `listPunchesInRange` needs to scope its query. */
export interface PunchListActor {
  accessRole: AccessRole
  department: Department
}

function toPunch(snap: QueryDocumentSnapshot<DocumentData>): Punch {
  const d = snap.data()
  return {
    id: snap.id,
    employeeId: String(d.employeeId ?? ''),
    shiftId: (d.shiftId as string | null) ?? null,
    type: d.type === 'out' ? 'out' : 'in',
    timestamp: d.timestamp,
    deviceTimestamp: d.deviceTimestamp,
    geo: (d.geo as PunchGeo | null) ?? null,
    selfieStoragePath: (d.selfieStoragePath as string | null) ?? null,
    manualBy: (d.manualBy as string | null) ?? null,
    manualReason: (d.manualReason as string | null) ?? null,
    flagged: Boolean(d.flagged),
    flagReason: (d.flagReason as string | null) ?? null,
    status: d.status === 'closed' ? 'closed' : d.status === 'open' ? 'open' : undefined,
    syncedFromOfflineQueue: Boolean(d.syncedFromOfflineQueue),
    editedBy: (d.editedBy as string | null) ?? null,
    editHistory: Array.isArray(d.editHistory) ? d.editHistory : [],
    locationId: (d.locationId as string | null) ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

/** The employee's currently-open clock-in, if any — the single source of truth for "am I clocked in?" */
export async function getOpenPunch(employeeId: string): Promise<Punch | null> {
  try {
    const snap = await getDocs(
      query(
        collection(db, COLLECTIONS.punches),
        where('employeeId', '==', employeeId),
        where('type', '==', 'in'),
        where('status', '==', 'open'),
      ),
    )
    return snap.docs[0] ? toPunch(snap.docs[0]) : null
  } catch (err) {
    if (isPermissionDenied(err)) return null
    throw err
  }
}

/** Restaurant-local "YYYY-MM-DD" for a punch's server timestamp — the admin view's grouping key. */
export function punchLocalDate(p: Punch): string | null {
  const ts = p.timestamp
  if (!ts || typeof ts !== 'object' || !('toDate' in ts)) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
    (ts as { toDate(): Date }).toDate(),
  )
}

/**
 * Every punch whose restaurant-local date falls within [startDate, endDate]
 * (both inclusive) — Shifts & Tips admin (§9). The Firestore query itself
 * only narrows to a generously widened UTC window (±1 day, so no timezone
 * boundary math has to be exact there); the precise inclusion check is the
 * same local-date string comparison `listPunchesForEmployeeOnDate` already
 * uses. Client-side filters (employee/flagged/department) narrow further —
 * a two-week admin window is a few hundred documents at most, cheap to
 * filter in memory rather than needing a matching composite index per
 * filter combination.
 *
 * `actor` scopes the query itself for non-Owner/GM callers: a Firestore
 * `list` is all-or-nothing (see firestore.rules' `punchDepartment()`
 * comment), so a Manager/Supervisor's query MUST pin
 * `where('department', '==', actor.department)` or the whole request is
 * denied outright, not merely filtered. Owner/GM see every department, so
 * no department filter is added for them.
 */
export async function listPunchesInRange(
  startDate: string,
  endDate: string,
  actor: PunchListActor,
): Promise<Punch[]> {
  const DAY_MS = 24 * 60 * 60 * 1000
  const widenedStart = Timestamp.fromMillis(new Date(`${startDate}T00:00:00Z`).getTime() - DAY_MS)
  const widenedEnd = Timestamp.fromMillis(new Date(`${endDate}T23:59:59Z`).getTime() + DAY_MS)
  const scopedToDepartment = actor.accessRole !== 'owner' && actor.accessRole !== 'gm'

  try {
    const snap = await getDocs(
      query(
        collection(db, COLLECTIONS.punches),
        where('timestamp', '>=', widenedStart),
        where('timestamp', '<=', widenedEnd),
        ...(scopedToDepartment ? [where('department', '==', actor.department)] : []),
        orderBy('timestamp', 'asc'),
      ),
    )
    return snap.docs
      .map(toPunch)
      .filter((p) => {
        const localDate = punchLocalDate(p)
        return localDate !== null && localDate >= startDate && localDate <= endDate
      })
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}

/** Every punch for one employee on one restaurant-local calendar date — pairs into the Shifts & Tips admin view (§9). */
export async function listPunchesForEmployeeOnDate(employeeId: string, date: string): Promise<Punch[]> {
  try {
    const snap = await getDocs(
      query(collection(db, COLLECTIONS.punches), where('employeeId', '==', employeeId)),
    )
    return snap.docs
      .map(toPunch)
      .filter((p) => {
        const ts = p.timestamp
        if (!ts || typeof ts !== 'object' || !('toDate' in ts)) return false
        const d = (ts as { toDate(): Date }).toDate()
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d) === date
      })
      .sort((a, b) => {
        const at = (p: Punch) =>
          p.timestamp && typeof p.timestamp === 'object' && 'toMillis' in p.timestamp
            ? (p.timestamp as { toMillis(): number }).toMillis()
            : 0
        return at(a) - at(b)
      })
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}
