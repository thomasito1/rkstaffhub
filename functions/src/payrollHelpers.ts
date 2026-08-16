/**
 * Payroll Firestore glue — shared by `payrollActions.ts` (lock/unlock),
 * `payrollExport.ts` (CSV), and the punch/tip edit callables' locked-period
 * check (`punchActions.ts`).
 */

import { HttpsError } from 'firebase-functions/v2/https'

import { COLLECTIONS, db } from './firebase'
import type { PayPeriodDoc } from './model'

/** Restaurant-local "YYYY-MM-DD" for an arbitrary instant — same convention as `punchActions.ts`'s own `isoDateOf`. */
export function isoDateOfInstant(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date)
}

/**
 * The `payPeriod` (if any) whose `[startDate, endDate]` contains `isoDate`.
 * Periods are expected never to overlap, so at most one match — `limit(5)`
 * is a safety margin for malformed data, not an expected count.
 */
export async function findPayPeriodForDate(
  isoDate: string,
): Promise<(PayPeriodDoc & { id: string }) | null> {
  const snap = await db
    .collection(COLLECTIONS.payPeriods)
    .where('startDate', '<=', isoDate)
    .orderBy('startDate', 'desc')
    .limit(5)
    .get()

  for (const doc of snap.docs) {
    const period = doc.data() as PayPeriodDoc
    if (period.endDate && period.endDate >= isoDate) {
      return { id: doc.id, ...period }
    }
  }
  return null
}

/**
 * Throws if `isoDate` falls inside a `locked` pay period — spec §11: "no
 * more punch/tip edits without unlock by Owner/GM." Silent no-op when no
 * period covers the date at all (an edit to a punch outside any defined
 * period is not something this check should ever block).
 */
export async function assertPeriodNotLocked(isoDate: string): Promise<void> {
  const period = await findPayPeriodForDate(isoDate)
  if (period?.status === 'locked') {
    throw new HttpsError(
      'failed-precondition',
      'This pay period is locked. Ask an Owner/GM to unlock it first.',
      { code: 'payroll/period-locked' },
    )
  }
}
