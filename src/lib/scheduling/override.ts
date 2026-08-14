/**
 * Client wrapper for the `recordScheduleOverride` Cloud Function — see
 * `functions/src/scheduleOverride.ts` for what it verifies and why the write
 * cannot happen client-side.
 *
 * Call this ONLY when `findConflicts()` (src/lib/scheduling/conflicts.ts)
 * reports a `skill-too-low` block with `overridable: true` and the manager has
 * supplied a reason. For every other assignment — no conflicts, or only
 * `warn`-severity ones — use `updateShift()` from `src/lib/db/schedules.ts`
 * directly; firestore.rules already permits that write for `schedule.edit`
 * holders, and routing it through a Function would just add latency for
 * nothing this callable independently re-verifies.
 */
import { httpsCallable, type FunctionsError } from 'firebase/functions'
import { functions } from '@/lib/firebase'

export interface ScheduleOverrideInput {
  weekId: string
  shiftId: string
  employeeId: string
  /** Required. Rejected empty/whitespace by the Function, not just the UI. */
  reason: string
}

export interface ScheduleOverrideResult {
  weekId: string
  shiftId: string
  employeeId: string
  effectiveSkillLevel: number
  requiredSkillLevel: number
}

export class ScheduleOverrideRejected extends Error {
  constructor(
    message: string,
    public readonly code: FunctionsError['code'],
  ) {
    super(message)
    this.name = 'ScheduleOverrideRejected'
  }
}

/**
 * Assigns the shift AND logs the override reason to `auditLog`, atomically.
 * Throws `ScheduleOverrideRejected` with the Function's error code — notably
 * `failed-precondition` when the candidate turns out NOT to need an override
 * (their skill was fine after all) and `aborted` when the shift changed under
 * the manager mid-edit. Surface both as retryable, not as a generic failure.
 */
export async function recordScheduleOverride(
  input: ScheduleOverrideInput,
): Promise<ScheduleOverrideResult> {
  const call = httpsCallable<ScheduleOverrideInput, ScheduleOverrideResult>(
    functions,
    'recordScheduleOverride',
  )
  try {
    const res = await call(input)
    return res.data
  } catch (err) {
    const fnErr = err as FunctionsError
    throw new ScheduleOverrideRejected(fnErr.message ?? 'Override failed', fnErr.code)
  }
}
