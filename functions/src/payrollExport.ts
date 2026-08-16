/**
 * Pay period CSV export — spec §11: generic + Gusto-friendly + ADP-friendly
 * variants, all integer-cents through `centsToCsvString`, no float ever
 * touching a CSV column. Unreachable from a client write (there IS no
 * `payPeriods` write path other than this and `payrollActions.ts` — both
 * Cloud-Function-only); the export ITSELF returns CSV text in the callable
 * response rather than writing to Storage, since a restaurant this size's
 * payroll CSV is a few dozen rows — the client turns the returned string
 * into a downloaded file, no signed URL needed.
 *
 * GUSTO/ADP COLUMN MAPPINGS ARE BEST-EFFORT, NOT VERIFIED against a real
 * account or provider import spec — same "illustrative, not real" caveat
 * `PROGRESS.md` already carries for mockup 26's payroll figures. Confirm the
 * exact expected columns against Rafa's actual Gusto/ADP accounts before a
 * real payroll run ever uses these exports.
 *
 * Locking is NOT a prerequisite to export — an unlocked period can still be
 * exported (Rafa's ruling), but the filename is marked `_DRAFT` and the
 * response carries `isDraft: true` so the UI can warn. Exporting a period
 * that IS locked at the moment of export transitions its status to the
 * terminal `'exported'` (spec's own `PayPeriodStatus` enum); exporting an
 * unlocked one leaves `status` untouched — only `exportedAt`/`exportedBy`/
 * `exportFileName` get stamped, informationally, and it stays re-exportable.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

import { COLLECTIONS, PRIVATE, db } from './firebase'
import { requirePermission } from './permissions'
import { markAuditPending, writeAudit } from './audit'
import { centsToCsvString } from './money'
import { bucketPunchesIntoDailyHours, type PunchLike } from './payroll/dailyHours'
import { workweekRangeCoveringPeriod } from './payroll/overtime'
import { computePayrollRow, type PayPeriodFrequency } from './payroll/payrollRows'
import { isoDateOfInstant } from './payrollHelpers'
import type { CompensationDoc, EmployeeDoc, PayPeriodDoc, PunchDoc } from './model'

export type CsvVariant = 'generic' | 'gusto' | 'adp'

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function csvLine(fields: string[]): string {
  return fields.map(csvField).join(',')
}

interface ExportRow {
  employeeNumber: string
  name: string
  employmentType: string
  regularHours: number
  otHours: number
  rate: string // dollars string or ''
  hourlyGross: string
  tips: string
  salaryAmount: string // dollars string or ''
}

function toGenericCsv(rows: ExportRow[], periodLabel: string): string {
  const header = [
    'employeeNumber',
    'name',
    'type',
    'regularHours',
    'otHours',
    'rate',
    'hourlyGross',
    'tips',
    'salaryAmount',
    'period',
  ]
  const lines = rows.map((r) =>
    csvLine([
      r.employeeNumber,
      r.name,
      r.employmentType,
      String(r.regularHours),
      String(r.otHours),
      r.rate,
      r.hourlyGross,
      r.tips,
      r.salaryAmount,
      periodLabel,
    ]),
  )
  return [csvLine(header), ...lines].join('\n')
}

/** Best-effort Gusto hours-import shape — see file header caveat. */
function toGustoCsv(rows: ExportRow[], periodStart: string, periodEnd: string): string {
  const header = [
    'Employee ID',
    'Employee Name',
    'Regular Hours',
    'Overtime Hours',
    'Cash Tips',
    'Additional Earnings',
    'Period Start',
    'Period End',
  ]
  const lines = rows.map((r) =>
    csvLine([
      r.employeeNumber,
      r.name,
      String(r.regularHours),
      String(r.otHours),
      r.tips,
      r.salaryAmount,
      periodStart,
      periodEnd,
    ]),
  )
  return [csvLine(header), ...lines].join('\n')
}

/** Best-effort ADP hours-import shape — see file header caveat. */
function toAdpCsv(rows: ExportRow[], periodStart: string, periodEnd: string): string {
  const header = [
    'Employee File Number',
    'Employee Name',
    'Reg Hours',
    'O/T Hours',
    'Rate',
    'Other Earnings',
    'Pay Period Start',
    'Pay Period End',
  ]
  const lines = rows.map((r) =>
    csvLine([
      r.employeeNumber,
      r.name,
      String(r.regularHours),
      String(r.otHours),
      r.rate,
      String(Number(r.tips || '0') + Number(r.salaryAmount || '0')),
      periodStart,
      periodEnd,
    ]),
  )
  return [csvLine(header), ...lines].join('\n')
}

export interface ExportPayPeriodCsvRequest {
  periodId: string
  variant: CsvVariant
}

export interface ExportPayPeriodCsvResponse {
  csv: string
  fileName: string
  isDraft: boolean
}

export const exportPayPeriodCsv = onCall<ExportPayPeriodCsvRequest>(
  async (request): Promise<ExportPayPeriodCsvResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { periodId, variant } = request.data
    if (!periodId) throw new HttpsError('invalid-argument', 'periodId is required.')
    if (variant !== 'generic' && variant !== 'gusto' && variant !== 'adp') {
      throw new HttpsError('invalid-argument', 'variant must be generic, gusto, or adp.')
    }

    const actor = await requirePermission(uid, 'payroll.export')

    const periodRef = db.collection(COLLECTIONS.payPeriods).doc(periodId)
    const periodSnap = await periodRef.get()
    if (!periodSnap.exists) throw new HttpsError('not-found', 'That pay period no longer exists.')
    const period = periodSnap.data() as PayPeriodDoc
    if (!period.startDate || !period.endDate) {
      throw new HttpsError('failed-precondition', 'This pay period is missing its date range.')
    }

    const isDraft = period.status !== 'locked' && period.status !== 'exported'

    const settingsSnap = await db.collection(COLLECTIONS.settings).doc('app').get()
    const payPeriodFrequency: PayPeriodFrequency =
      (settingsSnap.data()?.payPeriod?.frequency as PayPeriodFrequency | undefined) ?? 'semimonthly'

    const range = workweekRangeCoveringPeriod(period.startDate, period.endDate)
    const rangeStart = new Date(`${range.start}T00:00:00-04:00`)
    const rangeEnd = new Date(`${range.end}T23:59:59-04:00`)

    const employeesSnap = await db
      .collection(COLLECTIONS.employees)
      .where('status', '==', 'active')
      .get()

    const rows: ExportRow[] = []

    for (const empDoc of employeesSnap.docs) {
      const employee = empDoc.data() as EmployeeDoc
      const employmentType = employee.employmentType ?? 'hourly'

      // Equality-only (employeeId), filtered to the widened range in code —
      // matches this codebase's own established convention
      // (`listPunchesForEmployeeOnDate`'s comment) of avoiding a new
      // composite index (`employeeId` equality + `timestamp` range) in favor
      // of an in-memory filter over one employee's own punches, which is
      // never a large set.
      const punchesSnap =
        employmentType === 'non-clocking'
          ? null
          : await db.collection(COLLECTIONS.punches).where('employeeId', '==', empDoc.id).get()

      const dailyHours = punchesSnap
        ? bucketPunchesIntoDailyHours(
            punchesSnap.docs
              .map((d) => d.data() as PunchDoc)
              .filter(
                (p): p is PunchDoc & { timestamp: FirebaseFirestore.Timestamp; type: 'in' | 'out' } =>
                  Boolean(p.timestamp && p.type) &&
                  p.timestamp!.toMillis() >= rangeStart.getTime() &&
                  p.timestamp!.toMillis() <= rangeEnd.getTime(),
              )
              .map(
                (p): PunchLike => ({
                  employeeId: empDoc.id,
                  type: p.type as 'in' | 'out',
                  timestampMs: p.timestamp.toDate().getTime(),
                }),
              ),
            (ms) => isoDateOfInstant(new Date(ms)),
          )
        : []

      // Same equality-only-then-filter-in-code shape as the punches fetch
      // above — avoids a new `tipReports(employeeId, date)` composite index.
      const tipsSnap = await db.collection(COLLECTIONS.tipReports).where('employeeId', '==', empDoc.id).get()
      const tipsDollars = tipsSnap.docs
        .filter((d) => {
          const date = d.data().date as string | undefined
          return typeof date === 'string' && date >= period.startDate! && date <= period.endDate!
        })
        .reduce((sum, d) => sum + Number(d.data().amount ?? 0), 0)

      const compSnap = await empDoc.ref.collection('private').doc(PRIVATE.compensation).get()
      const comp = (compSnap.exists ? compSnap.data() : {}) as CompensationDoc

      const row = computePayrollRow(
        {
          employeeId: empDoc.id,
          employmentType,
          hourlyRateDollars: comp.hourlyRate ?? null,
          salaryAmountDollars: comp.salaryAmount ?? null,
          salaryPeriod: comp.salaryPeriod ?? null,
          clockRequired: employee.clockRequired ?? false,
          dailyHours,
          tipsDollars,
        },
        period.startDate,
        period.endDate,
        payPeriodFrequency,
      )

      // Skip an employee with no pay-affecting activity at all this period —
      // no hours, no tips, no salary — rather than padding the export with
      // empty rows for someone who simply wasn't scheduled.
      if (row.grossCents === 0 && row.regularHours === 0 && row.otHours === 0) continue

      const name = [employee.preferredName || employee.firstName, employee.lastName].filter(Boolean).join(' ')
      rows.push({
        employeeNumber: employee.employeeNumber ?? empDoc.id,
        name,
        employmentType,
        regularHours: row.regularHours,
        otHours: row.otHours,
        rate: row.hourlyRateCents != null ? centsToCsvString(row.hourlyRateCents) : '',
        hourlyGross: centsToCsvString(row.hourlyGrossCents),
        tips: centsToCsvString(row.tipsCents),
        salaryAmount: row.salaryAmountCents != null ? centsToCsvString(row.salaryAmountCents) : '',
      })
    }

    const periodLabel = `${period.startDate}_${period.endDate}`
    const csv =
      variant === 'gusto'
        ? toGustoCsv(rows, period.startDate, period.endDate)
        : variant === 'adp'
          ? toAdpCsv(rows, period.startDate, period.endDate)
          : toGenericCsv(rows, periodLabel)

    const fileName = `payroll_${periodLabel}_${variant}${isDraft ? '_DRAFT' : ''}.csv`

    const update: Record<string, unknown> = {
      exportedAt: FieldValue.serverTimestamp(),
      exportedBy: actor.id,
      exportFileName: fileName,
      updatedAt: FieldValue.serverTimestamp(),
    }
    if (period.status === 'locked') update.status = 'exported'
    await periodRef.update(update)

    const audited = await writeAudit({
      action: 'payroll.export',
      actorEmployeeId: actor.id,
      actorUid: uid,
      targetType: 'payPeriod',
      targetId: periodId,
      reason: isDraft ? 'draft export (period not locked)' : null,
      before: { status: period.status ?? null },
      after: { exportFileName: fileName, variant },
    })
    if (!audited) await markAuditPending(periodRef, 'payroll.export')

    return { csv, fileName, isDraft }
  },
)
