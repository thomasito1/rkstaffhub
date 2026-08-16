/**
 * Builds the actual prompt text sent to the active provider (spec §13).
 * PURE deterministic string templating — no provider-specific formatting
 * here (a provider module wraps this into its own request shape).
 *
 * The system prompt is the ENTIRE strict-JSON contract in prose + schema —
 * `contract.ts`'s `parseAiResponse` enforces the same shape server-side, so
 * a provider that ignores these instructions simply fails validation rather
 * than producing a schedule that silently drifts from what's checked.
 */

import type { GenerationContext } from './promptContext'

export interface GenerationPrompt {
  system: string
  user: string
}

const SYSTEM_PROMPT = `You are a restaurant staff scheduling assistant. You will be given a JSON
context describing open shift requirements for one week, the employees
available to fill them, their skills, hourly rates, availability, approved
time off, and how many hours each has recently averaged (for fairness).

Respond with STRICT JSON ONLY — no prose, no markdown, no code fence — matching
exactly this shape:

{
  "shifts": [
    { "employeeId": "emp-123" | null, "date": "YYYY-MM-DD", "startTime": "HH:mm", "endTime": "HH:mm", "roleId": "server" }
  ],
  "rationale": "A short (2-4 sentence) plain-English summary of your approach."
}

Rules, in priority order:
1. Only propose shifts for (date, roleId) pairs that appear in "requirements" — never invent a role or date not listed. Propose up to "countNeeded" shifts per requirement line; fewer is fine if no suitable employee exists, but never propose duplicates beyond countNeeded.
2. Never schedule an employee outside their "availability" for that day, and never on a date in their "onApprovedTimeOffDates" — if no available, skilled employee exists for a slot, set "employeeId" to null for that shift rather than force an unsuitable assignment.
3. Never schedule the same employee for two overlapping shifts.
4. Only assign an employee to a roleId they hold in "shiftRoles" at the requirement's own "minSkillLevel" or higher (direct match; role coverage is handled separately and you do not need to reason about it).
5. Be overtime-averse: avoid pushing an employee's total scheduled hours this week (their existing "scheduledHoursThisWeek" plus whatever you assign) past 40 hours where a suitable alternative exists.
6. Favor fairness: all else equal, prefer an employee with a LOWER "recentAverageWeeklyHours" over one who has been getting more hours recently.
7. Respect "laborTargetPct" as a soft goal, not a hard constraint — prefer lower hourly rates when candidates are otherwise equally suitable, but never leave a slot unfilled solely to hit a labor percentage.

Every proposed shift is independently re-validated against the real scheduling
rules after you respond — an assignment that turns out to violate one becomes
an open shift with a reason, so when in doubt, propose your best guess rather
than leaving a slot open.`

/** Serializes the context compactly — this is machine-read by the provider's own tokenizer, not a human, so no pretty-printing indentation is worth the extra tokens. */
function serializeContext(context: GenerationContext): string {
  return JSON.stringify(context)
}

export function buildGenerationPrompt(context: GenerationContext, instructions?: string | null): GenerationPrompt {
  const trimmedInstructions = instructions?.trim()
  const instructionsBlock = trimmedInstructions
    ? `\n\nThe manager reviewing this draft has asked for the following changes on top of the rules above — follow them as closely as the rules allow, and if a request conflicts with a hard rule (rule 1-4 above), prefer the rule and explain the conflict in "rationale":\n"${trimmedInstructions}"`
    : ''

  const user = `Context:\n${serializeContext(context)}${instructionsBlock}`

  return { system: SYSTEM_PROMPT, user }
}
