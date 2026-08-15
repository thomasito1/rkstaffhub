import { describe, it, expect } from 'vitest'
import {
  findCoverageCycle,
  findInvalidatedShifts,
  findTemplatesRequiringRole,
  type RoleNode,
  type TemplateForRoleCheck,
} from './roleHierarchy'
import type { EmployeeLike } from './conflicts'

const ROLES: RoleNode[] = [
  { id: 'bartender', canCoverRoleIds: ['server', 'host'] },
  { id: 'server', canCoverRoleIds: [] },
  { id: 'host', canCoverRoleIds: [] },
  { id: 'manager', canCoverRoleIds: [] },
]

describe('findCoverageCycle', () => {
  it('is null for an acyclic edit', () => {
    expect(findCoverageCycle(ROLES, 'manager', ['bartender', 'server'])).toBeNull()
  })

  it('catches self-coverage as a 1-node cycle', () => {
    const cycle = findCoverageCycle(ROLES, 'server', ['server'])
    expect(cycle).toEqual(['server', 'server'])
  })

  it('catches a two-node cycle introduced by the edit', () => {
    // server currently covers nothing; granting it bartender while bartender
    // already covers server closes a loop.
    const cycle = findCoverageCycle(ROLES, 'server', ['bartender'])
    expect(cycle).not.toBeNull()
    expect(cycle).toContain('server')
    expect(cycle).toContain('bartender')
  })

  it('catches a longer cycle spanning three roles', () => {
    const roles: RoleNode[] = [
      { id: 'a', canCoverRoleIds: ['b'] },
      { id: 'b', canCoverRoleIds: ['c'] },
      { id: 'c', canCoverRoleIds: [] },
    ]
    const cycle = findCoverageCycle(roles, 'c', ['a'])
    expect(cycle).not.toBeNull()
    expect(cycle).toEqual(expect.arrayContaining(['a', 'b', 'c']))
  })

  it('does not flag an unrelated existing cycle-free graph when editing a leaf', () => {
    expect(findCoverageCycle(ROLES, 'host', [])).toBeNull()
  })
})

function emp(shiftRoles: EmployeeLike['shiftRoles']): EmployeeLike {
  return { id: 'e1', status: 'active', shiftRoles }
}

describe('findInvalidatedShifts', () => {
  const COVERAGE = { bartender: ['server', 'host'], server: [], host: [] }

  it('flags a published shift whose assignee loses coverage', () => {
    const bartenderOnly = emp([{ roleId: 'bartender', skillLevel: 2 }])
    const shifts = [
      { id: 's1', roleId: 'server', employeeId: 'e1', status: 'published' },
    ]
    const affected = findInvalidatedShifts(
      shifts,
      new Map([['e1', bartenderOnly]]),
      'bartender',
      COVERAGE,
      ['host'], // server dropped
    )
    expect(affected).toEqual(['s1'])
  })

  it('does not flag someone who holds the role directly', () => {
    const directServer = emp([{ roleId: 'server', skillLevel: 1 }])
    const shifts = [
      { id: 's1', roleId: 'server', employeeId: 'e1', status: 'published' },
    ]
    const affected = findInvalidatedShifts(
      shifts,
      new Map([['e1', directServer]]),
      'bartender',
      COVERAGE,
      ['host'],
    )
    expect(affected).toEqual([])
  })

  it('ignores draft shifts — nothing is staffed against them yet', () => {
    const bartenderOnly = emp([{ roleId: 'bartender', skillLevel: 2 }])
    const shifts = [{ id: 's1', roleId: 'server', employeeId: 'e1', status: 'draft' }]
    const affected = findInvalidatedShifts(
      shifts,
      new Map([['e1', bartenderOnly]]),
      'bartender',
      COVERAGE,
      ['host'],
    )
    expect(affected).toEqual([])
  })

  it('ignores open shifts — no one to strand', () => {
    const shifts = [{ id: 's1', roleId: 'server', employeeId: null, status: 'published' }]
    const affected = findInvalidatedShifts(
      shifts,
      new Map(),
      'bartender',
      COVERAGE,
      ['host'],
    )
    expect(affected).toEqual([])
  })

  it('does not flag when coverage is only added, never removed', () => {
    const bartenderOnly = emp([{ roleId: 'bartender', skillLevel: 2 }])
    const shifts = [{ id: 's1', roleId: 'server', employeeId: 'e1', status: 'republished' }]
    const affected = findInvalidatedShifts(
      shifts,
      new Map([['e1', bartenderOnly]]),
      'bartender',
      COVERAGE,
      ['server', 'host', 'expo'],
    )
    expect(affected).toEqual([])
  })
})

describe('findTemplatesRequiringRole', () => {
  function tpl(over: Partial<TemplateForRoleCheck> = {}): TemplateForRoleCheck {
    return {
      id: 'tpl-1',
      name: 'Fri Dinner',
      requirements: [{ roleId: 'server', count: 2 }],
      ...over,
    }
  }

  it('flags a template whose requirements name the deactivated role with a positive count', () => {
    const affected = findTemplatesRequiringRole([tpl()], 'server')
    expect(affected).toEqual([tpl()])
  })

  it('does not flag a template that never requires the role', () => {
    const affected = findTemplatesRequiringRole(
      [tpl({ requirements: [{ roleId: 'bartender', count: 2 }] })],
      'server',
    )
    expect(affected).toEqual([])
  })

  it('does not flag a requirement line with a zero count — already meaningless', () => {
    const affected = findTemplatesRequiringRole(
      [tpl({ requirements: [{ roleId: 'server', count: 0 }] })],
      'server',
    )
    expect(affected).toEqual([])
  })

  it('flags multiple templates independently', () => {
    const monLunch = tpl({ id: 'tpl-mon', requirements: [{ roleId: 'server', count: 1 }] })
    const friDinner = tpl({ id: 'tpl-fri', requirements: [{ roleId: 'server', count: 4 }] })
    const bohOnly = tpl({ id: 'tpl-boh', requirements: [{ roleId: 'expo', count: 1 }] })
    const affected = findTemplatesRequiringRole([monLunch, friDinner, bohOnly], 'server')
    expect(affected.map((t) => t.id)).toEqual(['tpl-mon', 'tpl-fri'])
  })
})
