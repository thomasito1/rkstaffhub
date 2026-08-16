import { useCallback, useEffect, useState } from 'react'

import { getAppSettings, getEmployeeCompensation, getPayPeriod, listEmployees, listPunchesInRange, listTipReportsInRange } from '@/lib/db'
import { RESTAURANT_TZ } from '@/lib/format'
import { bucketPunchesIntoDailyHours, type DailyHours, type PunchLike } from '@/lib/payroll/dailyHours'
import { addDaysToIsoDate, allocateHoursToPeriod, workweekRangeCoveringPeriod, workweeksCoveringPeriod } from '@/lib/payroll/overtime'
import { computePayrollRow, type PayPeriodFrequency, type PayrollRow } from '@/lib/payroll/payrollRows'
import { centsForHours, type Cents } from '@/lib/money'
import type { Employee, PayPeriod, Punch } from '@/types/models'

/**
 * One workweek's OT split as it lands inside the selected period — spec
 * §11's "per-workweek view". `weekStart`/`weekEnd` are the workweek's own
 * Mon-Sun bounds (not clipped to the period) so the UI can label the row
 * "Aug 3 - Aug 9"; `regularHours`/`otHours` ARE clipped to the intersection
 * of that week and the period, since a period boundary can land mid-week.
 *
 * `hourlyGrossCents` is computed here with the exact same
 * rate/1.5x-OT-rate/round-per-line formula `payrollRows.ts`'s
 * `computePayrollRow` uses internally (that file is read-only this phase) —
 * reusing `centsForHours` from `money.ts` rather than re-deriving it keeps
 * this a thin reapplication of the existing primitive, not a parallel
 * reimplementation. Always 0 for an `accountabilityOnly` row.
 */
export interface WorkweekBreakdown {
  weekId: string
  weekStart: string
  weekEnd: string
  regularHours: number
  otHours: number
  hourlyGrossCents: Cents
}

export interface PayrollWorkshopRow {
  employee: Employee
  row: PayrollRow
  workweeks: WorkweekBreakdown[]
}

export interface PayrollWorkshopData {
  loading: boolean
  loadError: boolean
  period: PayPeriod | null
  payPeriodFrequency: PayPeriodFrequency
  rows: PayrollWorkshopRow[]
  reload: () => Promise<void>
}

function toMillisOrNull(value: unknown): number | null {
  if (value && typeof value === 'object' && 'toMillis' in value) {
    try {
      return (value as { toMillis(): number }).toMillis()
    } catch {
      return null
    }
  }
  return null
}

function isoDateOfMs(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: RESTAURANT_TZ }).format(new Date(ms))
}

function groupByEmployeeId<T extends { employeeId: string }>(items: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const list = map.get(item.employeeId)
    if (list) list.push(item)
    else map.set(item.employeeId, [item])
  }
  return map
}

function dailyHoursForEmployee(employeeId: string, punches: Punch[]): DailyHours[] {
  const punchLikes: PunchLike[] = []
  for (const p of punches) {
    const ms = toMillisOrNull(p.timestamp)
    if (ms === null) continue
    punchLikes.push({ employeeId, type: p.type, timestampMs: ms })
  }
  return bucketPunchesIntoDailyHours(punchLikes, isoDateOfMs)
}

/** Every workweek touching `periodStart..periodEnd`, each week's OT split clipped to that intersection — see `WorkweekBreakdown`'s own doc comment. */
function buildWorkweekBreakdowns(
  dailyHours: DailyHours[],
  periodStart: string,
  periodEnd: string,
  hourlyRateCents: Cents | null,
  accountabilityOnly: boolean,
): WorkweekBreakdown[] {
  return workweeksCoveringPeriod(periodStart, periodEnd).map((weekId) => {
    const weekStart = weekId
    const weekEnd = addDaysToIsoDate(weekId, 6)
    const sliceStart = weekStart > periodStart ? weekStart : periodStart
    const sliceEnd = weekEnd < periodEnd ? weekEnd : periodEnd
    const { regularHours, otHours } = allocateHoursToPeriod(dailyHours, sliceStart, sliceEnd)
    const regularPayCents = !accountabilityOnly && hourlyRateCents != null ? centsForHours(hourlyRateCents, regularHours) : 0
    const otPayCents =
      !accountabilityOnly && hourlyRateCents != null ? centsForHours(Math.round(hourlyRateCents * 1.5), otHours) : 0
    return {
      weekId,
      weekStart,
      weekEnd,
      regularHours,
      otHours,
      hourlyGrossCents: regularPayCents + otPayCents,
    }
  })
}

/**
 * The Payroll Workshop's per-period computation (spec §11, Phase 3(c)),
 * done ONCE per period selection and shared by both the per-period and
 * per-workweek views (`PayrollWorkshopRow.row` / `.workweeks`).
 *
 * Population is `status === 'active'` only — matching exactly which
 * employees `functions/src/payrollExport.ts`'s CSV export itself queries,
 * so what the reviewer sees on screen is the same population the export
 * will produce, not a superset or subset of it.
 *
 * Punches/tips are fetched ONCE for the whole roster (`listPunchesInRange`/
 * `listTipReportsInRange` already do a range-only Firestore query, no
 * `employeeId` equality — see their own doc comments) and then grouped by
 * employeeId in memory, rather than one query per employee — cheaper for a
 * ~35-person roster and the same "range query, filter in code" shape the
 * spec's own per-employee guidance is protecting against a bad composite
 * index either way.
 */
export function usePayrollWorkshopData(periodId: string | null, actor: Employee | null): PayrollWorkshopData {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [period, setPeriod] = useState<PayPeriod | null>(null)
  const [payPeriodFrequency, setPayPeriodFrequency] = useState<PayPeriodFrequency>('semimonthly')
  const [rows, setRows] = useState<PayrollWorkshopRow[]>([])

  const reload = useCallback(async () => {
    if (!periodId || !actor) {
      setPeriod(null)
      setRows([])
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(false)
    try {
      const [thisPeriod, settings, roster] = await Promise.all([
        getPayPeriod(periodId),
        getAppSettings(),
        listEmployees({ status: 'active' }),
      ])
      if (!thisPeriod) {
        setPeriod(null)
        setRows([])
        return
      }
      const frequency = settings?.payPeriod?.frequency ?? 'semimonthly'
      setPeriod(thisPeriod)
      setPayPeriodFrequency(frequency)

      const range = workweekRangeCoveringPeriod(thisPeriod.startDate, thisPeriod.endDate)
      const [allPunches, allTipReports] = await Promise.all([
        listPunchesInRange(range.start, range.end, actor),
        listTipReportsInRange(thisPeriod.startDate, thisPeriod.endDate, actor),
      ])
      const punchesByEmployee = groupByEmployeeId(allPunches)
      const tipsByEmployee = new Map<string, number>()
      for (const tr of allTipReports) {
        tipsByEmployee.set(tr.employeeId, (tipsByEmployee.get(tr.employeeId) ?? 0) + tr.amount)
      }

      const compensations = await Promise.all(roster.map((e) => getEmployeeCompensation(e.id)))

      const built: PayrollWorkshopRow[] = []
      roster.forEach((employee, i) => {
        const comp = compensations[i]
        // No compensation document at all (missing, or denied) — exclude
        // cleanly rather than rendering a row with fabricated/blank pay.
        if (!comp) return

        const dailyHours = dailyHoursForEmployee(employee.id, punchesByEmployee.get(employee.id) ?? [])
        const row = computePayrollRow(
          {
            employeeId: employee.id,
            employmentType: employee.employmentType,
            hourlyRateDollars: comp.hourlyRate,
            salaryAmountDollars: comp.salaryAmount,
            salaryPeriod: comp.salaryPeriod,
            clockRequired: employee.clockRequired,
            dailyHours,
            tipsDollars: tipsByEmployee.get(employee.id) ?? 0,
          },
          thisPeriod.startDate,
          thisPeriod.endDate,
          frequency,
        )
        const workweeks = buildWorkweekBreakdowns(
          dailyHours,
          thisPeriod.startDate,
          thisPeriod.endDate,
          row.hourlyRateCents,
          row.accountabilityOnly,
        )
        built.push({ employee, row, workweeks })
      })

      setRows(built)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [periodId, actor])

  useEffect(() => {
    void reload()
  }, [reload])

  return { loading, loadError, period, payPeriodFrequency, rows, reload }
}
