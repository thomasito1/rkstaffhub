/**
 * Shared row-building + formatting helpers for the Shifts & Tips admin
 * screen (spec §9) — `ShiftsAndTipsPage.tsx` and its two modals
 * (`components/ManualPunchModal.tsx`, `components/PunchEditModal.tsx`).
 *
 * PAIRING PUNCHES INTO ROWS. `punches/{id}` is one document per tap — a
 * clock-in and its clock-out are two separate docs (db/punches.ts's own
 * comment). The admin table shows one ROW per shift-worth of punches, so
 * this module walks each employee's punches for a single restaurant-local
 * date in timestamp order, queueing 'in's and popping the earliest pending
 * one for each 'out' it meets (FIFO — correct for the common single-shift
 * day and for a same-day split shift, without needing shiftId to agree).
 * An 'in' with nothing left to pair becomes an OPEN row — never a fabricated
 * hours total (CLAUDE.md, spec §8's forgotten-clockout ruling).
 *
 * TIP REPORTS ARE PER (employeeId, date), NOT per punch pair — `clockOut`
 * and `manualPunch` both create at most one per day today. A day with more
 * than one completed pair (a split shift) attaches any report to the LAST
 * pair of that day, since that is the pair a fresh create-path report would
 * land on if the flag were resolved right now.
 */
import { firebaseErrorCode } from '@/lib/firebaseError'
import { RESTAURANT_TZ } from '@/lib/format'
import type { Employee, EmployeeShiftRole, Punch, ShiftRole, TipReport } from '@/types/models'

export function displayName(e: Pick<Employee, 'firstName' | 'lastName' | 'preferredName'>): string {
  const first = e.preferredName?.trim() ? e.preferredName : e.firstName
  return `${first} ${e.lastName}`.trim()
}

/** "2026-08-10" → a Date safely inside that calendar day in every US timezone. */
export function dateFromIso(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`)
}

/** A punch/tip-report timestamp field — Firestore Timestamp, or unset before the server round-trip. */
export function toDate(value: unknown): Date | null {
  if (value && typeof value === 'object' && 'toDate' in value) {
    return (value as { toDate(): Date }).toDate()
  }
  return null
}

export function millisOf(value: unknown): number {
  return toDate(value)?.getTime() ?? 0
}

/** Restaurant-local "HH:MM" (24h) — the value a native `<input type="time">` needs. */
export function restaurantTimeInputValue(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: RESTAURANT_TZ,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date)
  const hh = parts.find((p) => p.type === 'hour')?.value ?? '00'
  const mm = parts.find((p) => p.type === 'minute')?.value ?? '00'
  return `${hh}:${mm}`
}

export function hoursBetween(inDate: Date, outDate: Date): number {
  return (outDate.getTime() - inDate.getTime()) / (60 * 60 * 1000)
}

export function primaryShiftRole(employee: Employee): EmployeeShiftRole | undefined {
  return employee.shiftRoles.find((r) => r.isPrimary) ?? employee.shiftRoles[0]
}

export function roleDisplayName(role: ShiftRole | undefined, lang: string): string {
  if (!role) return ''
  return lang.startsWith('es') && role.nameEs ? role.nameEs : role.name
}

/** "Server · L2", or "" when the employee has no shift roles on file. */
export function roleLabel(
  employee: Employee,
  roleMap: Map<string, ShiftRole>,
  lang: string,
  levelShort: (level: number) => string,
): string {
  const primary = primaryShiftRole(employee)
  if (!primary) return ''
  const name = roleDisplayName(roleMap.get(primary.roleId), lang)
  if (!name) return ''
  return `${name} · ${levelShort(primary.skillLevel)}`
}

export interface PunchRow {
  key: string
  employeeId: string
  /** Restaurant-local "YYYY-MM-DD". */
  date: string
  inPunch: Punch | null
  outPunch: Punch | null
  tipReport: TipReport | null
  /** True only for a completed (in+out) row for a tipsRequired employee with no matching report. */
  missingTipReport: boolean
}

/**
 * Every punch pair (or lone open punch) across the given punches, one row
 * per shift-worth of taps. `tipsRequiredEmployeeIds` decides which rows can
 * even be missing a report — an employee who was never required to report
 * tips isn't "missing" one.
 */
export function buildPunchRows(
  punches: Punch[],
  tipReports: TipReport[],
  localDateOf: (p: Punch) => string | null,
  tipsRequiredEmployeeIds: Set<string>,
): PunchRow[] {
  const groups = new Map<string, Punch[]>()
  for (const p of punches) {
    const date = localDateOf(p)
    if (!date) continue
    const key = `${p.employeeId}|${date}`
    const arr = groups.get(key)
    if (arr) arr.push(p)
    else groups.set(key, [p])
  }

  const rows: PunchRow[] = []
  for (const [key, groupPunches] of groups) {
    const [employeeId, date] = key.split('|') as [string, string]
    const sorted = [...groupPunches].sort((a, b) => millisOf(a.timestamp) - millisOf(b.timestamp))
    const pendingIns: Punch[] = []
    let index = 0
    for (const p of sorted) {
      if (p.type === 'in') {
        pendingIns.push(p)
      } else {
        const inPunch = pendingIns.shift() ?? null
        rows.push({
          key: `${key}#${index++}`,
          employeeId,
          date,
          inPunch,
          outPunch: p,
          tipReport: null,
          missingTipReport: false,
        })
      }
    }
    for (const remaining of pendingIns) {
      rows.push({
        key: `${key}#${index++}`,
        employeeId,
        date,
        inPunch: remaining,
        outPunch: null,
        tipReport: null,
        missingTipReport: false,
      })
    }
  }

  // Attach each day's tip report(s) to that day's LAST completed pair.
  const tipsByKey = new Map<string, TipReport[]>()
  for (const tr of tipReports) {
    const k = `${tr.employeeId}|${tr.date}`
    const arr = tipsByKey.get(k)
    if (arr) arr.push(tr)
    else tipsByKey.set(k, [tr])
  }
  const completedByKey = new Map<string, PunchRow[]>()
  for (const r of rows) {
    if (!r.outPunch) continue
    const k = `${r.employeeId}|${r.date}`
    const arr = completedByKey.get(k)
    if (arr) arr.push(r)
    else completedByKey.set(k, [r])
  }
  for (const [k, candidates] of completedByKey) {
    const last = candidates.reduce((latest, r) =>
      millisOf(r.outPunch!.timestamp) > millisOf(latest.outPunch!.timestamp) ? r : latest,
    )
    const reports = tipsByKey.get(k)
    if (reports && reports[0]) {
      last.tipReport = reports[0]
    } else if (tipsRequiredEmployeeIds.has(last.employeeId)) {
      last.missingTipReport = true
    }
  }

  return rows
}

/**
 * `PunchErrorCode` (src/lib/punchErrors.ts) minus its "punch/" prefix — the
 * exact set of `clock.errors.*` keys already translated for the staff clock
 * screens (spec §8). Reusing them here means a rejection from `manualPunch`/
 * `editPunch`/`editTipReport` reads the same in the admin table as it does
 * on the clock, instead of a second, drifting copy of the same 12 strings.
 */
const KNOWN_PUNCH_ERROR_KEYS = new Set([
  'clock-not-required',
  'already-open',
  'no-open-punch',
  'selfie-missing',
  'selfie-invalid',
  'selfie-stale',
  'gps-imprecise',
  'outside-geofence',
  'shift-mismatch',
  'tips-required',
  'reason-required',
  'below-level-required',
  'period-locked',
])

/** A user-facing message for any error a punch/tip Cloud Function call rejects with. */
export function punchErrorMessage(err: unknown, t: (key: string) => string): string {
  const raw = firebaseErrorCode(err)
  const tail = raw?.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
  if (tail && KNOWN_PUNCH_ERROR_KEYS.has(tail)) return t(`clock.errors.${tail}`)
  return t('clock.errors.generic')
}
