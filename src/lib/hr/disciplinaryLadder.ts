/**
 * Escalation ladder computation — spec §12: "Each employee's profile shows a
 * progress ladder widget: which step they're on, what the next occurrence
 * triggers." Pure, Firebase-free (mirrors `fulfillment.ts`/`overtime.ts`'s
 * shape) so both the staff profile widget and the disciplinary admin screen
 * compute from the SAME function.
 *
 * MODEL (an interpretation of spec's own example — "2 verbal warnings → next
 * incident = written warning; written + 1 more = write-up; then final
 * warning; then suspension/termination review" — worth confirming with Rafa
 * if the exact semantics ever need to be more precise than this): steps are
 * a single ORDERED ladder, not independent per-type counters. Each step's
 * `thresholdCount` is the CUMULATIVE total of counted actions (any type —
 * the example escalates severity across mixed types, not "N of the exact
 * same type") at which that step's consequence takes effect. An employee's
 * `currentStep` is the highest-order step whose threshold has been reached;
 * `nextStep` is the very next one up. `draft` actions never count — only
 * `issued`/`signed`/`refused-to-sign` are real, finished actions.
 */

export type LadderActionStatus = 'draft' | 'issued' | 'signed' | 'refused-to-sign'

export interface LadderActionLike {
  type: string
  status: LadderActionStatus
}

export interface LadderStepLike {
  order: number
  type: string
  thresholdCount: number
  consequenceText: string
  consequenceTextEs: string
}

export interface LadderPosition {
  /** How many counted (non-draft) actions the employee has accumulated. */
  actionCount: number
  /** The highest-order step whose threshold has been reached, or null if none has. */
  currentStep: LadderStepLike | null
  /** The next step up from `currentStep`, or null if already at (or past) the highest step. */
  nextStep: LadderStepLike | null
}

function countsTowardLadder(action: LadderActionLike): boolean {
  return action.status === 'issued' || action.status === 'signed' || action.status === 'refused-to-sign'
}

export function computeLadderPosition(
  actions: LadderActionLike[],
  steps: LadderStepLike[],
): LadderPosition {
  const actionCount = actions.filter(countsTowardLadder).length
  const sortedSteps = [...steps].sort((a, b) => a.order - b.order)

  let currentStep: LadderStepLike | null = null
  let nextStep: LadderStepLike | null = null

  for (const step of sortedSteps) {
    if (step.thresholdCount <= actionCount) {
      currentStep = step
    } else if (nextStep === null) {
      nextStep = step
    }
  }

  return { actionCount, currentStep, nextStep }
}
