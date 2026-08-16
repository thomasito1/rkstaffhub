import { describe, expect, it } from 'vitest'

import { computeLadderPosition, type LadderActionLike, type LadderStepLike } from './disciplinaryLadder'

const STEPS: LadderStepLike[] = [
  { order: 1, type: 'written-warning', thresholdCount: 2, consequenceText: 'Next incident: written warning', consequenceTextEs: 'Próximo incidente: amonestación escrita' },
  { order: 2, type: 'writeup', thresholdCount: 3, consequenceText: 'Next incident: write-up', consequenceTextEs: 'Próximo incidente: reporte formal' },
  { order: 3, type: 'final-warning', thresholdCount: 4, consequenceText: 'Next incident: final warning', consequenceTextEs: 'Próximo incidente: advertencia final' },
  { order: 4, type: 'suspension', thresholdCount: 5, consequenceText: 'Next incident: suspension/termination review', consequenceTextEs: 'Próximo incidente: revisión de suspensión/despido' },
]

function action(status: LadderActionLike['status'] = 'issued'): LadderActionLike {
  return { type: 'verbal-warning', status }
}

describe('computeLadderPosition', () => {
  it('is at no step and shows the FIRST step as next, with zero counted actions', () => {
    const result = computeLadderPosition([], STEPS)
    expect(result.actionCount).toBe(0)
    expect(result.currentStep).toBeNull()
    expect(result.nextStep).toEqual(STEPS[0])
  })

  it('only counts issued/signed/refused-to-sign actions, never a draft', () => {
    const actions = [action('draft'), action('draft')]
    const result = computeLadderPosition(actions, STEPS)
    expect(result.actionCount).toBe(0)
  })

  it('counts signed and refused-to-sign the same as issued', () => {
    const actions = [action('issued'), action('signed'), action('refused-to-sign')]
    const result = computeLadderPosition(actions, STEPS)
    expect(result.actionCount).toBe(3)
  })

  it('is exactly AT a step once its threshold is reached, with the NEXT step up next', () => {
    const actions = [action(), action()] // 2 actions
    const result = computeLadderPosition(actions, STEPS)
    expect(result.actionCount).toBe(2)
    expect(result.currentStep).toEqual(STEPS[0]) // threshold 2 reached
    expect(result.nextStep).toEqual(STEPS[1]) // threshold 3 next
  })

  it('is BELOW a step until its threshold is reached (1 action, threshold-2 step not yet hit)', () => {
    const result = computeLadderPosition([action()], STEPS)
    expect(result.actionCount).toBe(1)
    expect(result.currentStep).toBeNull()
    expect(result.nextStep).toEqual(STEPS[0])
  })

  it('lands on the HIGHEST step whose threshold has been met, not just any met step', () => {
    const actions = Array.from({ length: 4 }, () => action())
    const result = computeLadderPosition(actions, STEPS)
    expect(result.actionCount).toBe(4)
    expect(result.currentStep).toEqual(STEPS[2]) // threshold 4
    expect(result.nextStep).toEqual(STEPS[3]) // threshold 5
  })

  it('has no next step once the highest-order step is reached', () => {
    const actions = Array.from({ length: 5 }, () => action())
    const result = computeLadderPosition(actions, STEPS)
    expect(result.actionCount).toBe(5)
    expect(result.currentStep).toEqual(STEPS[3])
    expect(result.nextStep).toBeNull()
  })

  it('stays at the highest step even past its threshold (6 actions, still step 4)', () => {
    const actions = Array.from({ length: 6 }, () => action())
    const result = computeLadderPosition(actions, STEPS)
    expect(result.currentStep).toEqual(STEPS[3])
    expect(result.nextStep).toBeNull()
  })

  it('handles an empty ladder config gracefully', () => {
    const result = computeLadderPosition([action(), action()], [])
    expect(result.currentStep).toBeNull()
    expect(result.nextStep).toBeNull()
  })

  it('sorts steps by order regardless of input order', () => {
    const shuffled = [STEPS[2], STEPS[0], STEPS[3], STEPS[1]] as LadderStepLike[]
    const actions = [action(), action()]
    const result = computeLadderPosition(actions, shuffled)
    expect(result.currentStep).toEqual(STEPS[0])
    expect(result.nextStep).toEqual(STEPS[1])
  })
})
