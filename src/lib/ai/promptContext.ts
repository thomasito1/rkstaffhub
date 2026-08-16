/**
 * Assembles the JSON-serializable generation context embedded in the AI
 * prompt (spec §13, Rafa's guardrail #2): availability, time off, active
 * template requirements (incl. dated variants), roles+skills, rates, labor
 * target, recent-hours fairness. PURE — every input here is already-fetched
 * plain data; `functions/src/ai/generate.ts` does the Firestore reads and
 * the recent-weeks hours averaging, this module only shapes what it's given.
 *
 * The requirement list reuses `computeWeekFulfillment` from
 * `../scheduling/fulfillment` UNMODIFIED (guardrail #2's "no
 * reimplementation") — that function already resolves seasonal dated
 * variants ("most-specific-match-wins") and counts real existing shifts, so
 * this module only has to subtract `have` from `count` to know what's still
 * needed. A week with nothing built yet has `have: 0` everywhere; a
 * regenerate call on a partially-built draft naturally asks the model for
 * only the REMAINING gap, never duplicate coverage.
 */

import type { TemplateFulfillment } from '../scheduling/fulfillment'
import { weekdayKeyOfDate } from './dateHelpers'
import type { AvailabilityDayLike } from '../scheduling/conflicts'
import type { WeekdayKey } from '../../types/models'

export interface AiRequirementContext {
  date: string
  dayOfWeek: WeekdayKey
  roleId: string
  minSkillLevel: 1 | 2 | 3
  /** `max(0, count - have)` — the model is asked to fill this many, never told about slots already covered. */
  countNeeded: number
}

export interface AiEmployeeContext {
  id: string
  name: string
  department: string
  shiftRoles: { roleId: string; skillLevel: 1 | 2 | 3 }[]
  hourlyRate: number | null
  salaryAmount: number | null
  salaryPeriod: 'weekly' | 'monthly' | null
  /** Hours already on this employee's schedule for the week being generated (0 for a brand-new draft). */
  scheduledHoursThisWeek: number
  /** Average weekly hours over the trailing lookback window — the fairness signal (spec §13's "recent-weeks fairness data"). */
  recentAverageWeeklyHours: number
  availability: Record<WeekdayKey, AvailabilityDayLike>
  /** "YYYY-MM-DD" dates within this week the employee is on APPROVED leave — never scheduled against. */
  onApprovedTimeOffDates: string[]
}

export interface AiRoleContext {
  id: string
  name: string
  department: string
  canCoverRoleIds: string[]
}

export interface GenerationContext {
  weekId: string
  laborTargetPct: number | null
  requirements: AiRequirementContext[]
  employees: AiEmployeeContext[]
  roles: AiRoleContext[]
}

export interface BuildGenerationContextInput {
  weekId: string
  laborTargetPct: number | null
  templateFulfillment: TemplateFulfillment[]
  employees: Omit<AiEmployeeContext, 'availability' | 'onApprovedTimeOffDates'>[]
  availabilityByEmployee: Record<string, Record<WeekdayKey, AvailabilityDayLike>>
  /** Employee id → every approved time-off date overlapping this week (already filtered/expanded by the caller). */
  approvedTimeOffDatesByEmployee: Record<string, string[]>
  roles: AiRoleContext[]
}

export function buildGenerationContext(input: BuildGenerationContextInput): GenerationContext {
  const requirements: AiRequirementContext[] = []
  for (const tf of input.templateFulfillment) {
    for (const req of tf.requirements) {
      const countNeeded = Math.max(0, req.count - req.have)
      if (countNeeded > 0) {
        requirements.push({
          date: tf.date,
          dayOfWeek: weekdayKeyOfDate(tf.date),
          roleId: req.roleId,
          minSkillLevel: req.minSkillLevel,
          countNeeded,
        })
      }
    }
  }

  const employees: AiEmployeeContext[] = input.employees.map((e) => ({
    ...e,
    availability: input.availabilityByEmployee[e.id] ?? ({} as Record<WeekdayKey, AvailabilityDayLike>),
    onApprovedTimeOffDates: input.approvedTimeOffDatesByEmployee[e.id] ?? [],
  }))

  return {
    weekId: input.weekId,
    laborTargetPct: input.laborTargetPct,
    requirements,
    employees,
    roles: input.roles,
  }
}

/**
 * `${date}::${roleId}` → the resolved requirement line's own skill/department
 * — shared with `validateShifts.ts` so a proposed shift's skill floor and
 * department come from the SAME resolved-template data the prompt itself
 * was built from, never re-derived differently. Built from the identical
 * `templateFulfillment`/`roles` inputs `buildGenerationContext` uses, so
 * the two are always in lockstep for a single generation call.
 */
export function buildRoleSpecLookup(
  templateFulfillment: TemplateFulfillment[],
  roles: AiRoleContext[],
): Record<string, { minSkillLevel: 1 | 2 | 3; department: string }> {
  const departmentByRoleId = new Map(roles.map((r) => [r.id, r.department]))
  const lookup: Record<string, { minSkillLevel: 1 | 2 | 3; department: string }> = {}
  for (const tf of templateFulfillment) {
    for (const req of tf.requirements) {
      const key = `${tf.date}::${req.roleId}`
      // A roleId can appear in more than one requirement line for the same
      // day-part at different minSkillLevels (spec §6's "4 Servers min-L1,
      // at least one L3" example) — keep the LOWEST bar, since that is the
      // one a validly-proposed shift for this slot must clear at minimum;
      // the higher-level line is a separate, independently-checked count
      // the fulfillment engine already tracks on its own.
      const existing = lookup[key]
      if (!existing || req.minSkillLevel < existing.minSkillLevel) {
        lookup[key] = { minSkillLevel: req.minSkillLevel, department: departmentByRoleId.get(req.roleId) ?? '' }
      }
    }
  }
  return lookup
}
