/**
 * Per-employee payroll row for one pay period — spec §11's Workshop table.
 * Pure, Firebase-free (mirrors `overtime.ts`'s own reasoning for why it's
 * symlink-safe into `functions/` rather than importing `@/types/models`
 * across the build boundary — a local `EmploymentType` redeclaration here,
 * not an import, same "Like" pattern `tradeEligibility.ts` uses for
 * `EmployeeLike`/`ShiftLike`).
 *
 * Three rendering rules, ruled by Rafa:
 * - hourly/hourly-tipped: pay is hours-based (regular + 1.5x OT) + tips.
 * - salaried-with-punches (`clockRequired: true`): hours are still computed
 *   and shown — accountability only, spec §8's own phrase — but pay is the
 *   period-prorated salary, never hours-derived. `hourlyGrossCents` is
 *   always 0 for these; `accountabilityOnly: true` is what the Workshop UI
 *   keys its "accountability, not pay-affecting" rendering off.
 * - non-clocking: no hours at all, regardless of any punch data a caller
 *   might mistakenly pass in — salary only.
 */

import { centsForHours, dollarsToCents, sumCents, type Cents } from '../money'
import { allocateHoursToPeriod, type DailyHours } from './overtime'

export type EmploymentType = 'hourly-tipped' | 'hourly' | 'salaried-weekly' | 'salaried-monthly' | 'non-clocking'
export type PayPeriodFrequency = 'weekly' | 'biweekly' | 'semimonthly'
export type SalaryPeriod = 'weekly' | 'monthly'

/** How many pay periods (or salary periods, treated the same way) occur per year — the common unit `prorateSalaryToPeriodCents` annualizes through. */
const PERIODS_PER_YEAR: Record<PayPeriodFrequency | SalaryPeriod, number> = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
}

/**
 * Annualizes `salaryCents` via its own `salaryPeriod`, then divides by the
 * pay period's own frequency — e.g. a monthly salary into a semimonthly
 * period is exactly halved (24/12 = 2 periods per month, no annualization
 * drift); a weekly salary into a biweekly period is exactly doubled.
 */
export function prorateSalaryToPeriodCents(
  salaryCents: Cents,
  salaryPeriod: SalaryPeriod,
  payPeriodFrequency: PayPeriodFrequency,
): Cents {
  const annualCents = salaryCents * PERIODS_PER_YEAR[salaryPeriod]
  return Math.round(annualCents / PERIODS_PER_YEAR[payPeriodFrequency])
}

export interface PayrollRowInput {
  employeeId: string
  employmentType: EmploymentType
  hourlyRateDollars: number | null
  salaryAmountDollars: number | null
  salaryPeriod: SalaryPeriod | null
  clockRequired: boolean
  /** Every daily-hours entry across the FULL `workweekRangeCoveringPeriod` — not just the period's own dates (see `overtime.ts`). Ignored entirely for `non-clocking`. */
  dailyHours: DailyHours[]
  tipsDollars: number
}

export interface PayrollRow {
  employeeId: string
  employmentType: EmploymentType
  regularHours: number
  otHours: number
  hourlyRateCents: Cents | null
  regularPayCents: Cents
  otPayCents: Cents
  /** regularPayCents + otPayCents — 0 for any salaried/non-clocking row, since their pay never derives from hours. */
  hourlyGrossCents: Cents
  tipsCents: Cents
  salaryAmountCents: Cents | null
  /** True for salaried (any clockRequired setting) and non-clocking — hours shown, if any, are accountability-only and never affect pay. */
  accountabilityOnly: boolean
  /** The period's total pay: hourlyGrossCents + tipsCents for hourly types, salaryAmountCents (+ tipsCents, rare but not disallowed) for salaried/non-clocking. */
  grossCents: Cents
}

function isSalaried(employmentType: EmploymentType): boolean {
  return employmentType === 'salaried-weekly' || employmentType === 'salaried-monthly'
}

export function computePayrollRow(
  input: PayrollRowInput,
  periodStart: string,
  periodEnd: string,
  payPeriodFrequency: PayPeriodFrequency,
): PayrollRow {
  const { employeeId, employmentType, hourlyRateDollars, salaryAmountDollars, salaryPeriod, tipsDollars } = input
  const tipsCents = dollarsToCents(tipsDollars)
  const nonClocking = employmentType === 'non-clocking'
  const salaried = isSalaried(employmentType)
  const accountabilityOnly = salaried || nonClocking

  // Non-clocking never shows hours, even if dailyHours was (incorrectly) supplied.
  const { regularHours, otHours } = nonClocking
    ? { regularHours: 0, otHours: 0 }
    : allocateHoursToPeriod(input.dailyHours, periodStart, periodEnd)

  const hourlyRateCents = hourlyRateDollars != null ? dollarsToCents(hourlyRateDollars) : null

  // Hours-based pay only applies to hourly/hourly-tipped — salaried/non-clocking never derive pay from hours, per Rafa's ruling.
  const regularPayCents = !accountabilityOnly && hourlyRateCents != null ? centsForHours(hourlyRateCents, regularHours) : 0
  const otPayCents = !accountabilityOnly && hourlyRateCents != null ? centsForHours(Math.round(hourlyRateCents * 1.5), otHours) : 0
  const hourlyGrossCents = accountabilityOnly ? 0 : sumCents([regularPayCents, otPayCents])

  const salaryAmountCents =
    salaried && salaryAmountDollars != null && salaryPeriod != null
      ? prorateSalaryToPeriodCents(dollarsToCents(salaryAmountDollars), salaryPeriod, payPeriodFrequency)
      : nonClocking && salaryAmountDollars != null && salaryPeriod != null
        ? prorateSalaryToPeriodCents(dollarsToCents(salaryAmountDollars), salaryPeriod, payPeriodFrequency)
        : null

  const grossCents = sumCents([hourlyGrossCents, salaryAmountCents ?? 0, tipsCents])

  return {
    employeeId,
    employmentType,
    regularHours,
    otHours,
    hourlyRateCents,
    regularPayCents,
    otPayCents,
    hourlyGrossCents,
    tipsCents,
    salaryAmountCents,
    accountabilityOnly,
    grossCents,
  }
}
