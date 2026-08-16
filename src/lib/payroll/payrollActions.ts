/**
 * Client wrappers for the payroll Cloud Functions — see
 * `functions/src/payrollActions.ts`/`payrollExport.ts` for what each
 * independently re-verifies and why lock/unlock/export cannot be plain
 * client writes (firestore.rules: `payPeriods` is Cloud-Function-only).
 */
import { httpsCallable, type FunctionsError } from 'firebase/functions'
import { functions } from '@/lib/firebase'

export class PayrollActionRejected extends Error {
  constructor(
    message: string,
    public readonly code: FunctionsError['code'],
    public readonly details: unknown,
  ) {
    super(message)
    this.name = 'PayrollActionRejected'
  }
}

async function callPayrollAction<Req, Res>(name: string, input: Req): Promise<Res> {
  const call = httpsCallable<Req, Res>(functions, name)
  try {
    const res = await call(input)
    return res.data
  } catch (err) {
    const fnErr = err as FunctionsError
    throw new PayrollActionRejected(fnErr.message ?? 'Payroll action failed', fnErr.code, fnErr.details)
  }
}

export interface LockPayPeriodResult {
  periodId: string
  status: 'locked'
}

export function lockPayPeriod(periodId: string): Promise<LockPayPeriodResult> {
  return callPayrollAction('lockPayPeriod', { periodId })
}

export interface UnlockPayPeriodResult {
  periodId: string
  status: 'review'
}

/** Owner/GM only, enforced server-side — a required, non-empty `reason` (spec §11's "logged"). */
export function unlockPayPeriod(periodId: string, reason: string): Promise<UnlockPayPeriodResult> {
  return callPayrollAction('unlockPayPeriod', { periodId, reason })
}

export type CsvVariant = 'generic' | 'gusto' | 'adp'

export interface ExportPayPeriodCsvResult {
  csv: string
  fileName: string
  /** True when the period wasn't locked/exported at export time — the UI should warn before triggering the download. */
  isDraft: boolean
}

export function exportPayPeriodCsv(periodId: string, variant: CsvVariant): Promise<ExportPayPeriodCsvResult> {
  return callPayrollAction('exportPayPeriodCsv', { periodId, variant })
}

/** Triggers a browser download of the CSV string the export callable returned — no Storage round-trip needed for a file this size. */
export function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
