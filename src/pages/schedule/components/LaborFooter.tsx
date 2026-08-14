import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { formatCurrency, formatHours, formatPercent } from '@/lib/format'
import { shiftHours } from '@/lib/scheduling/conflicts'
import type { EmployeeCompensation } from '@/lib/db'
import type { Employee, Shift } from '@/types/models'

/**
 * Per-day + week-total labor pill — mockup 11's footer layout.
 *
 * Cost is `hourlyRate x hours`, computed from real shift + employee data, never
 * from a stored total. Salaried employees are excluded from BOTH hours and
 * cost (spec §6 — an accountability-only clock-in is not payroll-affecting),
 * and so are open (unassigned) shifts, which have no rate to apply.
 */

const SALARIED_TYPES = new Set(['salaried-weekly', 'salaried-monthly'])

interface DayTotal {
  date: string
  hours: number
  cost: number
  sales: number | null
  pct: number | null
}

function computeDay(
  date: string,
  shifts: Shift[],
  employeesById: Map<string, Employee>,
  compensationByEmployee: Map<string, EmployeeCompensation | null>,
  sales: number | undefined,
): DayTotal {
  let hours = 0
  let cost = 0

  for (const shift of shifts) {
    if (shift.date !== date || shift.employeeId === null) continue
    const employee = employeesById.get(shift.employeeId)
    if (!employee || SALARIED_TYPES.has(employee.employmentType)) continue

    const shiftHrs = shiftHours(shift)
    hours += shiftHrs

    const rate = compensationByEmployee.get(shift.employeeId)?.hourlyRate
    if (typeof rate === 'number') cost += rate * shiftHrs
  }

  const salesValue = typeof sales === 'number' ? sales : null
  const pct = salesValue !== null && salesValue > 0 ? cost / salesValue : null

  return { date, hours, cost, sales: salesValue, pct }
}

/** Week hours + cost, real-data-computed — shared with PublishModal's summary strip. */
export function computeWeekLabor(
  weekDates: string[],
  shifts: Shift[],
  employeesById: Map<string, Employee>,
  compensationByEmployee: Map<string, EmployeeCompensation | null>,
): { hours: number; cost: number } {
  let hours = 0
  let cost = 0
  for (const date of weekDates) {
    const day = computeDay(date, shifts, employeesById, compensationByEmployee, undefined)
    hours += day.hours
    cost += day.cost
  }
  return { hours, cost }
}

export function LaborFooter({
  weekDates,
  shifts,
  employeesById,
  compensationByEmployee,
  laborTargetPct,
  projectedSalesByDate,
  projectedSalesTotal,
}: {
  weekDates: string[]
  shifts: Shift[]
  employeesById: Map<string, Employee>
  compensationByEmployee: Map<string, EmployeeCompensation | null>
  laborTargetPct: number
  projectedSalesByDate: Record<string, number>
  projectedSalesTotal: number | null
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language

  const days = useMemo(
    () =>
      weekDates.map((date) =>
        computeDay(date, shifts, employeesById, compensationByEmployee, projectedSalesByDate[date]),
      ),
    [weekDates, shifts, employeesById, compensationByEmployee, projectedSalesByDate],
  )

  const weekHours = days.reduce((sum, d) => sum + d.hours, 0)
  const weekCost = days.reduce((sum, d) => sum + d.cost, 0)
  const weekPct = projectedSalesTotal && projectedSalesTotal > 0 ? weekCost / projectedSalesTotal : null

  const targetFraction = laborTargetPct / 100

  return (
    <footer
      className="grid h-[74px] shrink-0 border-t border-line bg-page"
      style={{ gridTemplateColumns: '220px repeat(7, minmax(0, 1fr)) auto' }}
    >
      <div className="flex items-center border-r border-line bg-app px-4">
        <span className="text-meta font-bold text-ink">{t('scheduleBuilder.footer.labor')}</span>
      </div>

      {days.map((day) => (
        <div
          key={day.date}
          className="flex flex-col items-center justify-center gap-1 border-r border-line p-2"
        >
          {day.pct !== null ? (
            <span
              className={[
                'rounded-full px-2 py-0.5 text-[10px] font-bold',
                day.pct <= targetFraction ? 'bg-success-tint text-success' : 'bg-warning-tint text-warning',
              ].join(' ')}
            >
              {formatPercent(day.pct, lang)}
            </span>
          ) : null}
          <span className="tabular text-chip text-ink-muted">
            {t('scheduleBuilder.footer.dayHours', { hours: formatHours(day.hours, lang) })}
          </span>
          <span className="tabular text-chip font-semibold text-ink">
            {formatCurrency(day.cost, lang)}
          </span>
        </div>
      ))}

      <div className="flex items-center justify-end whitespace-nowrap px-6">
        <div className="text-right">
          <div className="tabular text-meta font-bold text-ink">
            {t('scheduleBuilder.footer.weekTotal', { hours: formatHours(weekHours, lang) })}
          </div>
          <div className="tabular text-chip text-ink-muted">
            {formatCurrency(weekCost, lang)}
            {weekPct !== null ? ` · ${formatPercent(weekPct, lang)}` : ''}
          </div>
        </div>
      </div>
    </footer>
  )
}
