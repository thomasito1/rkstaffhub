/**
 * The strict JSON contract an LLM provider's raw text response must satisfy
 * (spec §13, Rafa's guardrail #3: "strict JSON contract"). PURE — no
 * provider/network code here, just shape validation of already-received
 * text. `functions/src/ai/generate.ts` calls `parseAiResponse` on whatever
 * text the active provider returned; anything that fails this parse is a
 * hard failure of the generation call (not a per-shift problem — a provider
 * that can't even produce well-formed JSON gets no draft at all, since there
 * is nothing here to run the conflicts engine against).
 *
 * Deliberately narrow: this checks SHAPE only (right fields, right types,
 * date/time strings that look like dates/times). It does NOT check whether a
 * shift is actually assignable — that is validateShifts.ts's job, one layer
 * up, using the real conflicts engine. A shift can pass this parse and still
 * get demoted to an open shift with a reason.
 */

export interface AiGeneratedShift {
  /** `null` = the model itself chose to leave this slot open. */
  employeeId: string | null
  /** "YYYY-MM-DD" */
  date: string
  /** "HH:mm", 24h */
  startTime: string
  /** "HH:mm", 24h */
  endTime: string
  roleId: string
}

export interface ParsedAiResponse {
  shifts: AiGeneratedShift[]
  /** A short human-readable summary of the model's own reasoning — becomes `AiDraftMeta.promptSummary`. */
  rationale: string
}

export type AiContractErrorCode = 'not-json' | 'wrong-shape' | 'invalid-shift'

export interface AiContractError {
  code: AiContractErrorCode
  detail: string
}

export type ParseAiResponseResult =
  | { ok: true; data: ParsedAiResponse }
  | { ok: false; error: AiContractError }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Strips a markdown code fence if the model wrapped its JSON in one
 * (```json ... ``` is a common instruction-following quirk across all three
 * providers this app targets) — a formatting nicety to tolerate, not part of
 * the contract itself. Anything else that isn't valid JSON still fails.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)
  return fenced ? (fenced[1] ?? '').trim() : trimmed
}

function isValidShift(value: unknown): value is AiGeneratedShift {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.employeeId !== null && typeof v.employeeId !== 'string') return false
  if (typeof v.date !== 'string' || !DATE_RE.test(v.date)) return false
  if (typeof v.startTime !== 'string' || !TIME_RE.test(v.startTime)) return false
  if (typeof v.endTime !== 'string' || !TIME_RE.test(v.endTime)) return false
  if (typeof v.roleId !== 'string' || v.roleId.trim() === '') return false
  return true
}

export function parseAiResponse(rawText: string): ParseAiResponseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(rawText))
  } catch {
    return { ok: false, error: { code: 'not-json', detail: 'Response was not valid JSON.' } }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: { code: 'wrong-shape', detail: 'Response must be a JSON object.' } }
  }
  const obj = parsed as Record<string, unknown>

  if (!Array.isArray(obj.shifts)) {
    return { ok: false, error: { code: 'wrong-shape', detail: '"shifts" must be an array.' } }
  }
  if (typeof obj.rationale !== 'string') {
    return { ok: false, error: { code: 'wrong-shape', detail: '"rationale" must be a string.' } }
  }

  const shifts: AiGeneratedShift[] = []
  for (const [i, candidate] of obj.shifts.entries()) {
    if (!isValidShift(candidate)) {
      return {
        ok: false,
        error: { code: 'invalid-shift', detail: `shifts[${i}] is missing or has a malformed field.` },
      }
    }
    shifts.push(candidate)
  }

  return { ok: true, data: { shifts, rationale: obj.rationale } }
}
