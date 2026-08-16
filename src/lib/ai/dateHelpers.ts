/**
 * Tiny date/weekday helper shared by the AI-generation pure modules (spec
 * §13, Phase 5). `fulfillment.ts`'s `dateForTemplateInWeek` already goes
 * weekday→date within a week; this is the inverse (date→weekday key),
 * needed to look up an employee's resolved availability for a specific
 * generated shift's date. Same UTC-noon-anchored math as
 * `dateForTemplateInWeek` to avoid local-timezone off-by-one on the date
 * boundary.
 */

import { WEEKDAY_KEYS, type WeekdayKey } from '../../types/models'

/** "2026-08-12" → 'wed'. Malformed input returns 'mon' rather than throwing — callers validate date shape earlier in the pipeline (contract.ts). */
export function weekdayKeyOfDate(date: string): WeekdayKey {
  const d = new Date(`${date}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return 'mon'
  const jsDay = d.getUTCDay() // 0 = Sunday .. 6 = Saturday
  const mondayFirstIndex = (jsDay + 6) % 7 // 0 = Monday .. 6 = Sunday
  return WEEKDAY_KEYS[mondayFirstIndex] ?? 'mon'
}
