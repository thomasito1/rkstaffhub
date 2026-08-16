/**
 * Fulfillment engine — spec §6: "the builder shows requirement fulfillment
 * per day-part (met/unmet badge)."
 *
 * PURE, mirroring conflicts.ts exactly: plain data in, typed findings out, no
 * reads, no writes, no permission checks. This is the ONE place that answers
 * "what's required vs. what's covered" for a shiftTemplate's day-part — the
 * schedule builder renders its badge from this, and Phase 5's AI scheduler
 * (`functions/src/ai/generate.ts`) imports this SAME module for its prompt
 * context rather than reimplementing the requirement/coverage math
 * independently — `functions/src/lib/scheduling/fulfillment.ts` is a plain
 * symlink to this file, mirroring `src/lib/scheduling/`'s own directory
 * shape under `functions/src/` (same trick as `tradeEligibility.ts`'s
 * existing symlink, extended: this file's relative import of
 * `../../types/models` only resolves correctly because the mirrored
 * location keeps the same relative distance to a matching
 * `functions/src/types/models.ts` symlink — that's why this file uses a
 * relative import instead of the `@/types/models` alias Vite resolves on
 * the client: a bare alias specifier survives `tsc`'s type-checking but is
 * never rewritten in the emitted CommonJS, so it would 404 at runtime in
 * functions' plain `tsc`-then-`node` build, which has no bundler to resolve
 * it).
 *
 * A requirement line is checked against the FULL pool of same-day-part
 * shifts for its roleId, independently of every other line — not a
 * consumed/allocated split. So "4 Servers min-L1, at least one L3" is two
 * requirement lines (`{count:4, minSkillLevel:1}` and `{count:1,
 * minSkillLevel:3}`) both checked against the same server shifts; a shift
 * scheduled at L3 satisfies both bars at once, exactly as a manager reading
 * the template in English would expect, with no bin-packing needed.
 *
 * Fulfillment counts SLOTS CREATED, not slots STAFFED: an open shift
 * (employeeId null) counts the same as an assigned one. Whether every slot
 * has a person is a separate question the builder's own "Open Shifts" row
 * already answers — this badge only tells a manager whether they've built
 * enough shift cards for the day-part yet. Only a `cancelled` shift is
 * excluded; `dropped` is still a real slot, just unclaimed.
 *
 * A requirement line matches a shift on that shift's OWN assigned `roleId`
 * only. `shiftRoles.canCoverRoleIds` (trade/override eligibility — spec §7,
 * see tradeEligibility.ts) is never consulted here: a Bartender covering a
 * Server's shift does not change that shift's `roleId`, and even if it did,
 * cross-role coverage is a "who may work this slot" question, not a "does
 * this slot count toward the template's headcount" one. Templates describe
 * what's staffed (shift cards built, by their declared role), not what's
 * substitutable — ruled by Rafa, Aug 2026, so Phase 5's prompt builder states
 * this rule accurately rather than assuming coverage-eligible shifts of a
 * different roleId satisfy a requirement line.
 */

import { minutesOf } from './tradeEligibility'
import type { ShiftStatus, SkillLevel, WeekdayKey } from '../../types/models'
import { WEEKDAY_KEYS } from '../../types/models'

export interface RequirementLike {
  roleId: string
  count: number
  minSkillLevel: SkillLevel
}

export interface TemplateDateRangeLike {
  startDate: string // "YYYY-MM-DD", inclusive
  endDate: string // "YYYY-MM-DD", inclusive
}

export interface TemplateLike {
  id: string
  dayOfWeek: WeekdayKey
  startTime: string // "HH:mm"
  endTime: string // "HH:mm"
  requirements: RequirementLike[]
  /**
   * Groups a base template with its seasonal variant(s) for the same
   * `dayOfWeek` (Rafa's ruling, Aug 2026 — see `resolveActiveTemplatesForDate`).
   * Optional and defaults to the template's own `id` when absent, so an
   * untagged template is trivially its own singleton group — existing
   * templates with no variant concept behave exactly as before.
   */
  profileKey?: string
  /** `null`/absent = the undated base, always active. Non-null wins over the base for any date inside range. */
  dateRange?: TemplateDateRangeLike | null
}

export interface FulfillmentShiftLike {
  id?: string
  date: string // "YYYY-MM-DD"
  startTime: string // "HH:mm"
  endTime: string // "HH:mm"
  roleId: string
  requiredSkillLevel: SkillLevel
  status: ShiftStatus
}

export interface RequirementFulfillment extends RequirementLike {
  /** Matching shifts found for this line. */
  have: number
  met: boolean
}

export interface TemplateFulfillment {
  templateId: string
  /** The date this template's day-part falls on for the week being checked. */
  date: string
  requirements: RequirementFulfillment[]
  /** True iff every requirement line is met. A template with no requirements is trivially met. */
  met: boolean
}

/** Do two "HH:mm" ranges overlap? Handles a range crossing midnight (close at 02:00). Touching endpoints do NOT overlap. */
function timeRangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const aFrom = minutesOf(aStart)
  const bFrom = minutesOf(bStart)
  let aTo = minutesOf(aEnd)
  let bTo = minutesOf(bEnd)
  if (aTo <= aFrom) aTo += 24 * 60
  if (bTo <= bFrom) bTo += 24 * 60
  return aFrom < bTo && bFrom < aTo
}

/** The date within `weekStartIso`'s Mon-start week that `dayOfWeek` falls on. */
export function dateForTemplateInWeek(dayOfWeek: WeekdayKey, weekStartIso: string): string {
  const offset = WEEKDAY_KEYS.indexOf(dayOfWeek)
  const d = new Date(`${weekStartIso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + offset)
  return d.toISOString().slice(0, 10)
}

/** Every shift belonging to this template's day-part: same date, overlapping time range, not cancelled. */
function shiftsForTemplate(
  template: TemplateLike,
  date: string,
  shiftsOnDate: FulfillmentShiftLike[],
): FulfillmentShiftLike[] {
  return shiftsOnDate.filter(
    (s) =>
      s.date === date &&
      s.status !== 'cancelled' &&
      timeRangesOverlap(s.startTime, s.endTime, template.startTime, template.endTime),
  )
}

/**
 * Fulfillment for one template against a set of candidate shifts, at a given
 * date. `date` is required and filters internally — the caller does not need
 * to pre-scope `shifts` to that date, only supply everything that MIGHT be
 * relevant (e.g. the whole week).
 */
export function computeTemplateFulfillment(
  template: TemplateLike,
  shifts: FulfillmentShiftLike[],
  date: string,
): TemplateFulfillment {
  const relevant = shiftsForTemplate(template, date, shifts)

  const requirements: RequirementFulfillment[] = template.requirements.map((req) => {
    const have = relevant.filter(
      (s) => s.roleId === req.roleId && s.requiredSkillLevel >= req.minSkillLevel,
    ).length
    return { ...req, have, met: have >= req.count }
  })

  return {
    templateId: template.id,
    date,
    requirements,
    met: requirements.every((r) => r.met),
  }
}

/**
 * Among templates sharing the same `dayOfWeek`, picks ONE winner per
 * `profileKey` for `date` — "most-specific-match-wins" (Rafa's ruling, Aug
 * 2026, the first dated-variant feature on this collection): a template
 * whose `dateRange` contains `date` wins over the undated base. Deliberately
 * small — with only one seasonal variant expected per profileKey in
 * practice, two overlapping DATED variants for the same group is undefined
 * behavior (picks whichever the input order happens to find first), not a
 * feature to design around.
 */
export function resolveActiveTemplatesForDate<T extends TemplateLike>(
  templates: T[],
  dayOfWeek: WeekdayKey,
  date: string,
): T[] {
  const byProfileKey = new Map<string, T[]>()
  for (const t of templates) {
    if (t.dayOfWeek !== dayOfWeek) continue
    const key = t.profileKey ?? t.id
    const group = byProfileKey.get(key)
    if (group) group.push(t)
    else byProfileKey.set(key, [t])
  }

  const winners: T[] = []
  for (const group of byProfileKey.values()) {
    const dated = group.find(
      (t) => t.dateRange && t.dateRange.startDate <= date && date <= t.dateRange.endDate,
    )
    const base = group.find((t) => !t.dateRange)
    const winner = dated ?? base
    if (winner) winners.push(winner)
  }
  return winners
}

/**
 * Every template resolved to its date within `weekStartIso`'s week — first
 * resolving which variant is ACTIVE per day (`resolveActiveTemplatesForDate`),
 * so a base template and its seasonal variant never both contribute a
 * fulfillment result for the same day-part — each checked against only the
 * shifts that fall on that same date.
 */
export function computeWeekFulfillment(
  templates: TemplateLike[],
  shifts: FulfillmentShiftLike[],
  weekStartIso: string,
): TemplateFulfillment[] {
  const dayOfWeeks = new Set(templates.map((t) => t.dayOfWeek))
  const results: TemplateFulfillment[] = []
  for (const dayOfWeek of dayOfWeeks) {
    const date = dateForTemplateInWeek(dayOfWeek, weekStartIso)
    const active = resolveActiveTemplatesForDate(templates, dayOfWeek, date)
    for (const template of active) {
      results.push(computeTemplateFulfillment(template, shifts, date))
    }
  }
  return results
}
