/**
 * Pay period data access — `payPeriods/{periodId}` (spec §11, Phase 3(c)).
 *
 * READS ONLY — every write (lock, unlock, CSV export's stamping) is
 * Cloud-Function-only, see `src/lib/payroll/payrollActions.ts`.
 * `payroll.view`-gated in firestore.rules, Owner/GM only per the matrix
 * (Rafa's ruling tightened this off Manager's default grant set).
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  type DocumentData,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import type { PayPeriod, PayPeriodStatus } from '@/types/models'

import { isPermissionDenied, readOrNullIfDenied } from './errors'

function periodDoc(id: string) {
  return doc(db, COLLECTIONS.payPeriods, id)
}

function toPayPeriod(
  snap: DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>,
): PayPeriod {
  const d = snap.data() ?? {}
  const status = d.status as PayPeriodStatus
  return {
    id: snap.id,
    startDate: String(d.startDate ?? ''),
    endDate: String(d.endDate ?? ''),
    status: (['open', 'review', 'locked', 'exported'] as const).includes(status) ? status : 'open',
    lockedAt: d.lockedAt,
    lockedBy: (d.lockedBy as string | null) ?? null,
    unlockedAt: d.unlockedAt,
    unlockedBy: (d.unlockedBy as string | null) ?? null,
    unlockReason: (d.unlockReason as string | null) ?? null,
    exportedAt: d.exportedAt,
    exportedBy: (d.exportedBy as string | null) ?? null,
    exportFileName: (d.exportFileName as string | null) ?? null,
    locationId: (d.locationId as string | null) ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

/** Every pay period, most recent first — a restaurant's worth is a couple dozen a year, cheap to sort client-side. */
export async function listPayPeriods(): Promise<PayPeriod[]> {
  try {
    const snap = await getDocs(collection(db, COLLECTIONS.payPeriods))
    return snap.docs.map((d) => toPayPeriod(d)).sort((a, b) => b.startDate.localeCompare(a.startDate))
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}

export async function getPayPeriod(id: string): Promise<PayPeriod | null> {
  return readOrNullIfDenied(async () => {
    const snap = await getDoc(periodDoc(id))
    return snap.exists() ? toPayPeriod(snap) : null
  })
}
