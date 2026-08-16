/**
 * Admin (cross-employee) reads for `disciplinaryActions` — spec §4/§12/§17.
 *
 * `src/lib/db/disciplinaryActions.ts` (not touched by this module — see its
 * own header) exposes `listDisciplinaryActionsForEmployee(employeeId)`, which
 * queries with `where('employeeId', '==', employeeId)` only. That shape is
 * correct for the SELF case (an employee reading their own record — the
 * query's own filter value equals the caller's own `employeeId`, so
 * firestore.rules' `isSelf()` branch is provable by substitution and the
 * request succeeds), but it is NOT the shape the rules allow for an ADMIN
 * reading a DIFFERENT (below-level) employee's history: a Firestore `list`
 * request is all-or-nothing — the rule can only be proven safe for every
 * possible matching document using fields the query itself constrains, and
 * `employeeId ==` says nothing about `employeeAccessRole`, which is what
 * `mayViewAsAdmin()` actually checks. `tests/rules/disciplinary.rules.test.ts`
 * confirms this directly: an unfiltered (or wrongly-filtered) list is DENIED
 * outright, and the only tested, allowed admin shape is
 * `where('employeeAccessRole', 'in', viewableDisciplineRoles(actor.accessRole))`
 * — the exact same pattern already proven out for `tipReports`
 * (`listTipReportsInRange`) and `punches` (`department`) after the Aug 14
 * 2026 fix.
 *
 * So an admin screen that needs "this below-level employee's disciplinary
 * history" cannot ask Firestore for just that employee — it must fetch every
 * action the viewer is ALLOWED to see (bounded by role membership) and
 * filter to the one employee client-side. For a restaurant this size (~35
 * employees, disciplinary actions rare) that is a small read, and it is the
 * same "fetch broad, filter/group narrow" shape `ShiftsAndTipsPage` already
 * uses for punches/tips.
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
import { viewableDisciplineRoles } from '@/lib/permissions'
import type { AccessRole, DisciplinaryAction } from '@/types/models'

import { isPermissionDenied } from './errors'

/** The minimal caller shape this query needs to scope itself. */
export interface DisciplinaryActionListActor {
  accessRole: AccessRole
}

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

/**
 * Every disciplinary action the actor may view as an admin — the Disciplinary
 * Actions settings screen's data source, and the source the profile ladder
 * widget falls back to when rendering someone ELSE's (below-level) ladder
 * (their own ladder uses `listMyDisciplinaryActions` instead, since that
 * query shape works fine for self). Callers filter this down to one
 * employee's `employeeId` client-side; sorted newest-first by `date`.
 */
export async function listViewableDisciplinaryActions(
  actor: DisciplinaryActionListActor,
): Promise<DisciplinaryAction[]> {
  const roles = viewableDisciplineRoles(actor.accessRole)
  if (roles.length === 0) return []

  try {
    const snap = await getDocs(
      query(collection(db, COLLECTIONS.disciplinaryActions), where('employeeAccessRole', 'in', roles)),
    )
    return snap.docs.map(toDisciplinaryAction).sort((a, b) => b.date.localeCompare(a.date))
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}
