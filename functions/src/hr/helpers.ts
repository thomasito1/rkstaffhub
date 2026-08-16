/**
 * Shared HR Cloud Function glue — `disciplinaryActions.ts` and
 * `signatures.ts`. Disciplinary matters are the most sensitive class in this
 * app (Rafa's ruling), so the below-level check here is never optional and
 * never trusted from a client claim, same shape as `punchActions.ts`'s own
 * `requireBelowLevelTarget`.
 */

import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https'

import { COLLECTIONS, db } from '../firebase'
import { canAccessSensitive, type Actor } from '../permissions'
import type { EmployeeDoc } from '../model'
import type { HrErrorCode } from '../hrErrors'

export function throwHrError(httpsCode: FunctionsErrorCode, hrCode: HrErrorCode, message: string): never {
  throw new HttpsError(httpsCode, message, { code: hrCode })
}

/** The target employee, if `actor` may act on them (below-level or self). Never trusts a client-claimed rank. */
export async function requireBelowLevelTarget(actor: Actor, employeeId: string): Promise<EmployeeDoc> {
  const targetSnap = await db.collection(COLLECTIONS.employees).doc(employeeId).get()
  if (!targetSnap.exists) throw new HttpsError('not-found', 'That employee does not exist.')
  const target = targetSnap.data() as EmployeeDoc
  if (!target.accessRole || !canAccessSensitive(actor, { id: employeeId, accessRole: target.accessRole })) {
    throwHrError(
      'permission-denied',
      'hr/below-level-required',
      'You may only act on an HR record for someone below your access level.',
    )
  }
  return target
}

/** Restaurant-local "YYYY-MM-DD" for an arbitrary instant — matches `payrollHelpers.ts`'s own `isoDateOfInstant`. */
export function isoDateOfInstant(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date)
}

export function signatureImagePath(employeeId: string, signatureId: string): string {
  return `signature-images/${employeeId}/${signatureId}.png`
}

export function signedPdfPath(employeeId: string, signatureId: string): string {
  return `signed-pdfs/${employeeId}/${signatureId}.pdf`
}
