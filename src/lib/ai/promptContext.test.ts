import { describe, expect, it } from 'vitest'

import { buildGenerationContext, buildRoleSpecLookup, type BuildGenerationContextInput, type AiRoleContext } from './promptContext'
import type { TemplateFulfillment } from '../scheduling/fulfillment'

const ROLES: AiRoleContext[] = [
  { id: 'server', name: 'Server', department: 'FOH', canCoverRoleIds: [] },
  { id: 'bartender', name: 'Bartender', department: 'FOH', canCoverRoleIds: ['server'] },
]

function fulfillment(over: Partial<TemplateFulfillment> = {}): TemplateFulfillment {
  return {
    templateId: 'mon-lunch',
    date: '2026-08-10',
    requirements: [{ roleId: 'server', count: 2, minSkillLevel: 1, have: 0, met: false }],
    met: false,
    ...over,
  }
}

function baseInput(over: Partial<BuildGenerationContextInput> = {}): BuildGenerationContextInput {
  return {
    weekId: '2026-08-10',
    laborTargetPct: 40,
    templateFulfillment: [fulfillment()],
    employees: [
      {
        id: 'emp-1',
        name: 'Allison Rodriguez',
        department: 'FOH',
        shiftRoles: [{ roleId: 'server', skillLevel: 2 }],
        hourlyRate: 11,
        salaryAmount: null,
        salaryPeriod: null,
        scheduledHoursThisWeek: 0,
        recentAverageWeeklyHours: 32,
      },
    ],
    availabilityByEmployee: {},
    approvedTimeOffDatesByEmployee: {},
    roles: ROLES,
    ...over,
  }
}

describe('buildGenerationContext', () => {
  it('only asks for the REMAINING need (count - have), never the full count', () => {
    const ctx = buildGenerationContext(baseInput({ templateFulfillment: [fulfillment({ requirements: [{ roleId: 'server', count: 2, minSkillLevel: 1, have: 1, met: false }] })] }))
    expect(ctx.requirements).toEqual([{ date: '2026-08-10', dayOfWeek: 'mon', roleId: 'server', minSkillLevel: 1, countNeeded: 1 }])
  })

  it('omits a requirement line that is already fully met (countNeeded would be 0)', () => {
    const ctx = buildGenerationContext(baseInput({ templateFulfillment: [fulfillment({ requirements: [{ roleId: 'server', count: 2, minSkillLevel: 1, have: 2, met: true }] })] }))
    expect(ctx.requirements).toHaveLength(0)
  })

  it('never asks for a negative count when have exceeds count (over-staffed)', () => {
    const ctx = buildGenerationContext(baseInput({ templateFulfillment: [fulfillment({ requirements: [{ roleId: 'server', count: 2, minSkillLevel: 1, have: 5, met: true }] })] }))
    expect(ctx.requirements).toHaveLength(0)
  })

  it('attaches each employee their own resolved availability and time-off dates by id', () => {
    const ctx = buildGenerationContext(
      baseInput({
        availabilityByEmployee: { 'emp-1': { mon: { status: 'unavailable' } } as never },
        approvedTimeOffDatesByEmployee: { 'emp-1': ['2026-08-12'] },
      }),
    )
    expect(ctx.employees[0]?.availability).toEqual({ mon: { status: 'unavailable' } })
    expect(ctx.employees[0]?.onApprovedTimeOffDates).toEqual(['2026-08-12'])
  })

  it('defaults to empty availability/time-off for an employee with none supplied', () => {
    const ctx = buildGenerationContext(baseInput())
    expect(ctx.employees[0]?.availability).toEqual({})
    expect(ctx.employees[0]?.onApprovedTimeOffDates).toEqual([])
  })

  it('passes weekId/laborTargetPct/roles through unchanged', () => {
    const ctx = buildGenerationContext(baseInput())
    expect(ctx.weekId).toBe('2026-08-10')
    expect(ctx.laborTargetPct).toBe(40)
    expect(ctx.roles).toEqual(ROLES)
  })
})

describe('buildRoleSpecLookup', () => {
  it('maps date+roleId to the requirement line’s minSkillLevel and the role’s department', () => {
    const lookup = buildRoleSpecLookup([fulfillment()], ROLES)
    expect(lookup['2026-08-10::server']).toEqual({ minSkillLevel: 1, department: 'FOH' })
  })

  it('keeps the LOWEST minSkillLevel when the same role has two requirement lines for the same day-part', () => {
    const tf = fulfillment({
      requirements: [
        { roleId: 'server', count: 4, minSkillLevel: 1, have: 0, met: false },
        { roleId: 'server', count: 1, minSkillLevel: 3, have: 0, met: false },
      ],
    })
    const lookup = buildRoleSpecLookup([tf], ROLES)
    expect(lookup['2026-08-10::server']?.minSkillLevel).toBe(1)
  })

  it('returns an empty department for a roleId with no matching role record, rather than throwing', () => {
    const lookup = buildRoleSpecLookup([fulfillment({ requirements: [{ roleId: 'ghost-role', count: 1, minSkillLevel: 1, have: 0, met: false }] })], ROLES)
    expect(lookup['2026-08-10::ghost-role']).toEqual({ minSkillLevel: 1, department: '' })
  })
})
