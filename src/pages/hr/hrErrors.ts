import type { TFunction } from 'i18next'

import { isFirebaseError } from '@/lib/firebaseError'

/**
 * `submitSignature` (functions/src/signatures.ts) throws a plain `HttpsError`
 * for "policy no longer exists" but an app-specific `hr/invalid-signature-image`
 * code (in `details.code`, via `throwHrError`) for a malformed/empty signature
 * PNG — `isFirebaseError` checks `details.code` before the bare `code`, so a
 * single call here covers both shapes (same convention as `tasks/taskErrors.ts`).
 * `HrActionRejected` (src/lib/hr/hrActions.ts) already carries `.code`/`.details`
 * in exactly the shape `isFirebaseError` expects, so it can be passed straight
 * through without unwrapping.
 */
export function signatureErrorMessage(t: TFunction, err: unknown): string {
  if (isFirebaseError(err, 'hr/invalid-signature-image')) return t('hr.sign.error.invalidSignature')
  if (isFirebaseError(err, 'not-found')) return t('hr.sign.error.notFound')
  if (isFirebaseError(err, 'unauthenticated')) return t('hr.sign.error.notSignedIn')
  return t('hr.sign.error.generic')
}

/**
 * `submitSignature` for a `disciplinaryAction` target (functions/src/
 * signatures.ts) throws two app-specific codes `signatureErrorMessage` above
 * doesn't know about — `hr/not-own-target` (only the target employee may
 * sign their own action) and `hr/already-resolved` (someone already signed
 * or refused it, e.g. from another tab) — alongside the same generic/
 * invalid-image/not-found/not-signed-in shapes. A disciplinary action isn't
 * a policy, so its own "no longer exists" copy reads differently too.
 */
export function disciplinaryErrorMessage(t: TFunction, err: unknown): string {
  if (isFirebaseError(err, 'hr/invalid-signature-image')) return t('hr.disciplineSign.error.invalidSignature')
  if (isFirebaseError(err, 'hr/not-own-target')) return t('hr.disciplineSign.error.notOwnTarget')
  if (isFirebaseError(err, 'hr/already-resolved')) return t('hr.disciplineSign.error.alreadyResolved')
  if (isFirebaseError(err, 'not-found')) return t('hr.disciplineSign.error.notFound')
  if (isFirebaseError(err, 'unauthenticated')) return t('hr.sign.error.notSignedIn')
  return t('hr.sign.error.generic')
}

/**
 * `issueDisciplinaryAction`/`recordRefusedToSign` (functions/src/
 * disciplinaryActions.ts) — the admin-side callables. `hr/below-level-
 * required` is the one code specific to this pair (the server's own
 * below-level re-check firing on a target the UI should already have hidden
 * the action for, e.g. a stale employee picker); `hr/already-resolved`
 * covers a refusal race against a signature that just landed.
 */
export function disciplinaryActionErrorMessage(t: TFunction, err: unknown): string {
  if (isFirebaseError(err, 'hr/below-level-required')) return t('settings.discipline.error.belowLevelRequired')
  if (isFirebaseError(err, 'hr/already-resolved')) return t('settings.discipline.error.alreadyResolved')
  if (isFirebaseError(err, 'not-found')) return t('settings.discipline.error.notFound')
  if (isFirebaseError(err, 'invalid-argument')) return t('settings.discipline.error.invalidArgument')
  return t('hr.sign.error.generic')
}
