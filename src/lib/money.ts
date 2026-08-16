/**
 * Integer-cents money — Phase 3(c) payroll (spec §11), ruled by Rafa: no
 * float ever represents or accumulates a monetary amount. `Employee.
 * hourlyRate`/`salaryAmount` are stored as dollar `number`s (a Phase 0
 * decision predating this file, not reopened here) — `dollarsToCents()` is
 * the ONE place that float is ever read, converting it once at the boundary.
 * Every payroll computation downstream operates on the `Cents` (a plain
 * integer `number`, branded only at the type level) this produces; formatting
 * back to a dollar string for display/CSV is the only place a float
 * reappears, and only transiently, never accumulated or fed back into more
 * math.
 *
 * Firebase-free (like `deadlines.ts`/`format.ts`) so it can symlink into
 * `functions/` the same way `tradeEligibility.ts` does.
 */

/** An integer count of cents. Not a distinct runtime type — just documents intent at call sites. */
export type Cents = number

/** Reads a dollar amount (Employee.hourlyRate, salaryAmount, a tip report's amount, a manual entry) into integer cents. The ONE float-touches-money boundary. */
export function dollarsToCents(dollars: number): Cents {
  return Math.round(dollars * 100)
}

/** Cents → a plain dollar number, for handing to `formatCurrency`/a CSV column — never fed back into further cents arithmetic. */
export function centsToDollars(cents: Cents): number {
  return cents / 100
}

/** Sums a list of cents amounts — plain integer addition, never touches a float. */
export function sumCents(amounts: Cents[]): Cents {
  return amounts.reduce((total, c) => total + c, 0)
}

/**
 * `hours × an hourly cents rate → cents`. `hours` is inherently fractional
 * (37.75h is real), so this is the one arithmetic step that multiplies by a
 * non-integer — the RESULT is rounded to the nearest cent immediately, so no
 * fractional-cent value ever exists or propagates. Round-half-up, matching
 * how a payroll system should round in the employee's favor at each line
 * item rather than accumulating drift.
 */
export function centsForHours(hourlyRateCents: Cents, hours: number): Cents {
  return Math.round(hourlyRateCents * hours)
}

/** A dollar-formatted string ("1,234.56", no currency symbol) for a CSV column — plain cents-to-string, never round-trips through display-locale formatting. */
export function centsToCsvString(cents: Cents): string {
  const negative = cents < 0
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100)
  const remainder = abs % 100
  return `${negative ? '-' : ''}${dollars}.${String(remainder).padStart(2, '0')}`
}
