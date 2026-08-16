/**
 * Signature data access — `signatures/{signatureId}` (spec §12, Phase 4).
 * Written exclusively by `submitSignature` (`src/lib/hr/hrActions.ts`);
 * firestore.rules denies all client create/update/delete here too.
 */
import { collection, getDoc, getDocs, doc, query, where, type DocumentData, type QueryDocumentSnapshot } from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import type { Signature, SignatureTargetType } from '@/types/models'

import { isPermissionDenied, readOrNullIfDenied } from './errors'

function toSignature(snap: QueryDocumentSnapshot<DocumentData>): Signature {
  const d = snap.data()
  return {
    id: snap.id,
    employeeId: String(d.employeeId ?? ''),
    targetType: d.targetType,
    targetId: String(d.targetId ?? ''),
    policyVersion: (d.policyVersion as number | null) ?? null,
    signatureImagePath: String(d.signatureImagePath ?? ''),
    signedAt: d.signedAt,
    pdfStoragePath: (d.pdfStoragePath as string | null) ?? null,
    emailedTo: (d.emailedTo as string | null) ?? null,
    emailedAt: d.emailedAt,
    emailPending: Boolean(d.emailPending),
    emailPendingAt: d.emailPendingAt,
    language: d.language,
    createdAt: d.createdAt,
  }
}

/** Every signature the signed-in employee has ever submitted — "have I signed the current handbook?" checks filter this by targetId/policyVersion. */
export async function listMySignatures(employeeId: string): Promise<Signature[]> {
  try {
    const snap = await getDocs(query(collection(db, COLLECTIONS.signatures), where('employeeId', '==', employeeId)))
    return snap.docs.map(toSignature)
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}

/** A specific signature by its own doc id (e.g. to render its PDF/signed-at info on a disciplinary action's detail view). */
export async function getSignature(id: string): Promise<Signature | null> {
  return readOrNullIfDenied(async () => {
    const snap = await getDoc(doc(db, COLLECTIONS.signatures, id))
    return snap.exists() ? toSignature(snap as QueryDocumentSnapshot<DocumentData>) : null
  })
}

/** Find a signature against a specific target (policy or disciplinaryAction) for one employee — client-side filter over `listMySignatures`'s result, since `targetType`+`targetId`+`employeeId` together would need a composite index for a query-side equivalent. */
export function findSignatureForTarget(
  signatures: Signature[],
  targetType: SignatureTargetType,
  targetId: string,
): Signature | null {
  return signatures.find((s) => s.targetType === targetType && s.targetId === targetId) ?? null
}
