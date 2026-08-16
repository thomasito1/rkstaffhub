import type { TFunction } from 'i18next'

import { isFirebaseError } from '@/lib/firebaseError'
import { PayrollActionRejected } from '@/lib/payroll/payrollActions'

/**
 * `lockPayPeriod`/`unlockPayPeriod` reject with plain `HttpsError` codes
 * (`failed-precondition`, `permission-denied`, `not-found`, …) rather than
 * the app-specific `trade/*`/`punch/*` code families the trade/clock
 * screens map — see `functions/src/payrollActions.ts`, which never sets
 * `details.code`. `failed-precondition` means two different things
 * depending on which action rejected (already locked vs. not locked to
 * unlock), so `action` disambiguates which message to show — mirrors
 * `tradeErrors.ts`/`clock/shared.ts`'s own "map the rejection to a clear
 * user-facing string" shape for this action's own error family.
 */
export function payrollActionErrorMessage(
  t: TFunction,
  err: unknown,
  action: 'lock' | 'unlock',
): string {
  if (!(err instanceof PayrollActionRejected)) {
    return t('settings.payroll.errors.generic')
  }
  if (isFirebaseError(err, 'failed-precondition')) {
    return action === 'lock'
      ? t('settings.payroll.errors.alreadyLocked')
      : t('settings.payroll.errors.notLocked')
  }
  if (isFirebaseError(err, 'permission-denied')) {
    return t('settings.payroll.errors.ownerGmOnly')
  }
  if (isFirebaseError(err, 'not-found')) {
    return t('settings.payroll.errors.periodNotFound')
  }
  if (isFirebaseError(err, 'invalid-argument')) {
    return t('settings.payroll.errors.reasonRequired')
  }
  return t('settings.payroll.errors.generic')
}

export function payrollExportErrorMessage(t: TFunction, err: unknown): string {
  if (!(err instanceof PayrollActionRejected)) {
    return t('settings.payroll.errors.generic')
  }
  return t('settings.payroll.errors.exportFailed')
}
