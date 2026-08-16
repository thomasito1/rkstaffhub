import type { TFunction } from 'i18next'

import { isFirebaseError } from '@/lib/firebaseError'

/**
 * `completeTaskInstance` (functions/src/taskActions.ts) throws plain
 * `HttpsError` codes — no custom `task/*` namespace like trades' — so this
 * mapper is a straight code → i18n key table instead of `tradeErrors.ts`'s
 * enumerated-code list. `failed-precondition` covers two distinct server
 * messages (task no longer open, or missing a required photo); since the UI
 * always sends a photo when one is required, the realistic case is "no
 * longer open" (someone else finished it first), so that's the wording used.
 */
export function taskErrorMessage(t: TFunction, err: unknown): string {
  if (isFirebaseError(err, 'not-found')) return t('tasks.errors.notFound')
  if (isFirebaseError(err, 'failed-precondition')) return t('tasks.errors.noLongerAvailable')
  if (isFirebaseError(err, 'permission-denied')) return t('tasks.errors.notEligible')
  return t('tasks.errors.generic')
}
