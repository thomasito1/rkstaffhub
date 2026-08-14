/**
 * Tip report data access — spec §8, §9, §17. Reads only — `tipReports` is
 * Cloud-Function-only for every write (firestore.rules); creation/edits live
 * in `src/lib/timeClock/punchActions.ts` (`clockOut`'s tip gate,
 * `editTipReport`).
 */
import {
  collection,
  getDocs,
  query,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import type { TipReport } from '@/types/models'

import { isPermissionDenied } from './errors'

function toTipReport(snap: QueryDocumentSnapshot<DocumentData>): TipReport {
  const d = snap.data()
  return {
    id: snap.id,
    employeeId: String(d.employeeId ?? ''),
    date: String(d.date ?? ''),
    shiftId: (d.shiftId as string | null) ?? null,
    amount: Number(d.amount ?? 0),
    reportedAt: d.reportedAt,
    editedBy: (d.editedBy as string | null) ?? null,
    editHistory: Array.isArray(d.editHistory) ? d.editHistory : [],
    locationId: (d.locationId as string | null) ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

/**
 * Every tip report with a restaurant-local `date` within [startDate, endDate]
 * (both inclusive) — Shifts & Tips admin (§9). `date` is already a plain
 * "YYYY-MM-DD" string (set at clock-out in the restaurant's own timezone),
 * so this is a direct range query, no widen-then-filter dance needed the way
 * punches' Timestamp field requires.
 */
export async function listTipReportsInRange(startDate: string, endDate: string): Promise<TipReport[]> {
  try {
    const snap = await getDocs(
      query(
        collection(db, COLLECTIONS.tipReports),
        where('date', '>=', startDate),
        where('date', '<=', endDate),
      ),
    )
    return snap.docs.map(toTipReport)
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}
