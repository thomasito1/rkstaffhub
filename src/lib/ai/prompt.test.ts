import { describe, expect, it } from 'vitest'

import { buildGenerationPrompt } from './prompt'
import type { GenerationContext } from './promptContext'

const CONTEXT: GenerationContext = {
  weekId: '2026-08-10',
  laborTargetPct: 40,
  requirements: [{ date: '2026-08-10', dayOfWeek: 'mon', roleId: 'server', minSkillLevel: 1, countNeeded: 2 }],
  employees: [],
  roles: [],
}

describe('buildGenerationPrompt', () => {
  it('documents the strict JSON contract in the system prompt', () => {
    const { system } = buildGenerationPrompt(CONTEXT)
    expect(system).toContain('"shifts"')
    expect(system).toContain('"rationale"')
    expect(system).toContain('STRICT JSON ONLY')
  })

  it('embeds the serialized context in the user prompt', () => {
    const { user } = buildGenerationPrompt(CONTEXT)
    expect(user).toContain('"weekId":"2026-08-10"')
    expect(user).toContain('"countNeeded":2')
  })

  it('omits any instructions block when none is given', () => {
    const { user } = buildGenerationPrompt(CONTEXT)
    expect(user).not.toContain('manager reviewing this draft')
  })

  it('omits the instructions block for an empty/whitespace-only instructions string', () => {
    const { user } = buildGenerationPrompt(CONTEXT, '   ')
    expect(user).not.toContain('manager reviewing this draft')
  })

  it('embeds manager free-text instructions verbatim when supplied (regenerate flow)', () => {
    const { user } = buildGenerationPrompt(CONTEXT, 'Give Robin Saturday off, heavier bar coverage Friday.')
    expect(user).toContain('manager reviewing this draft')
    expect(user).toContain('Give Robin Saturday off, heavier bar coverage Friday.')
  })

  it('is deterministic — the same context always produces the same prompt', () => {
    const a = buildGenerationPrompt(CONTEXT, 'same instructions')
    const b = buildGenerationPrompt(CONTEXT, 'same instructions')
    expect(a).toEqual(b)
  })
})
