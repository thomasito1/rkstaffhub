import type { TFunction } from 'i18next'

import { isFirebaseError } from '@/lib/firebaseError'
import type { TradeErrorCode } from '@/lib/scheduling/tradeEligibility'

/**
 * Every code a rejected claim/accept/approve/decline call can carry
 * (`TradeActionRejected.code`/`.details`, spec §7) mapped to a clear
 * user-facing message, instead of one generic "action failed" toast.
 */
const CODES: TradeErrorCode[] = [
  'trade/not-open',
  'trade/not-pending',
  'trade/not-pool',
  'trade/not-direct',
  'trade/shift-changed',
  'trade/wrong-recipient',
  'trade/wrong-approver',
  'trade/override-reason-required',
  'trade/ineligible-role',
  'trade/ineligible-skill',
  'trade/ineligible-department',
  'trade/ineligible-time-off',
  'trade/ineligible-double-booked',
  'trade/inactive-employee',
]

/** Strip the leading "trade/" for a compact i18n key segment. */
function keySegment(code: TradeErrorCode): string {
  return code.slice('trade/'.length).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

export function tradeErrorMessage(t: TFunction, err: unknown): string {
  for (const code of CODES) {
    if (isFirebaseError(err, code)) {
      return t(`shiftPool.errors.${keySegment(code)}`)
    }
  }
  return t('shiftPool.errors.generic')
}
