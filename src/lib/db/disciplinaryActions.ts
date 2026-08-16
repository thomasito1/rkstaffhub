/**
 * Disciplinary action data access — `disciplinaryActions/{actionId}` (spec §12,
 * Phase 4). All writes go through Cloud Functions (`src/lib/hr/hrActions.ts`);
 * this module is reads only, matching firestore.rules' `allow create, update,
 * delete: if false`.
 *
 * Sensitive class (Rafa's guardrail #1): a staff member reads only their OWN
 * actions. An admin reads a below-level employee's actions via
 * `listDisciplinaryActionsForEmployee`, which firestore.rules enforces with
 * `canAccessSensitive` — the client-side `employeeId` filter here is a
 * convenience, not the security boundary.
 */
import { collection, getDoc, getDocs, doc, orderBy, query, where, type DocumentData, type QueryDocumentSnapshot } from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import type { DisciplinaryAction } from '@/types/models'

import { isPermissionDenied, readOrNullIfDenied } from './errors'

function toDisciplinaryAction(snap: QueryDocumentSnapshot<DocumentData>): DisciplinaryAction {
  const d = snap.data()
  return {
    id: snap.id,
    employeeId: String(d.employeeId ?? ''),
    type: d.type,
    date: String(d.date ?? ''),
    issuedBy: String(d.issuedBy ?? ''),
    policyRefs: Array.isArray(d.policyRefs) ? d.policyRefs.map(String) : [],
    narrative: String(d.narrative ?? ''),
    signatureId: (d.signatureId as string | null) ?? null,
    status: d.status,
    refusedWitnessEmployeeId: (d.refusedWitnessEmployeeId as string | null) ?? null,
    refusedAt: d.refusedAt,
    pdfStoragePath: (d.pdfStoragePath as string | null) ?? null,
    emailedTo: (d.emailedTo as string | null) ?? null,
    emailedAt: d.emailedAt,
    emailPending: Boolean(d.emailPending),
    emailPendingAt: d.emailPendingAt,
    employeeAccessRole: d.employeeAccessRole,
    locationId: (d.locationId as string | null) ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

/** The signed-in employee's own disciplinary history — the profile ladder widget's data source. */
export async function listMyDisciplinaryActions(employeeId: string): Promise<DisciplinaryAction[]> {
  try {
    const snap = await getDocs(
      query(collection(db, COLLECTIONS.disciplinaryActions), where('employeeId', '==', employeeId), orderBy('date', 'desc')),
    )
    return snap.docs.map(toDisciplinaryAction)
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}

/** Admin view of a specific (below-level) employee's history — same query shape, gated by `canAccessSensitive` server-side. */
export async function listDisciplinaryActionsForEmployee(employeeId: string): Promise<DisciplinaryAction[]> {
  return listMyDisciplinaryActions(employeeId)
}

export async function getDisciplinaryAction(id: string): Promise<DisciplinaryAction | null> {
  return readOrNullIfDenied(async () => {
    const snap = await getDoc(doc(db, COLLECTIONS.disciplinaryActions, id))
    return snap.exists() ? toDisciplinaryAction(snap as QueryDocumentSnapshot<DocumentData>) : null
  })
}
