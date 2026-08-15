import { describe, it, expect } from 'vitest'
import {
  hasPermission,
  canAccessSensitive,
  canApproveForDepartment,
  canActOn,
  viewableTipRoles,
  type Actor,
} from './index'
import { ROLE_DEFAULTS } from './defaults'
import { ACCESS_ROLES, PERMISSION_KEYS, type AccessRole } from '@/types/models'

function actor(role: AccessRole, over: Partial<Actor> = {}): Actor {
  return {
    id: `${role}-1`,
    accessRole: role,
    department: 'FOH',
    ...over,
  }
}

const target = (role: AccessRole, id = `${role}-target`) => ({ id, accessRole: role })

describe('role defaults matrix', () => {
  it('defines every permission key for every role', () => {
    for (const role of ACCESS_ROLES) {
      for (const key of PERMISSION_KEYS) {
        expect(
          ROLE_DEFAULTS[role][key],
          `${role} is missing ${key}`,
        ).toBeTypeOf('boolean')
      }
    }
  })

  it('gives the owner every permission', () => {
    for (const key of PERMISSION_KEYS) {
      expect(hasPermission(actor('owner'), key)).toBe(true)
    }
  })

  it('withholds only ai.configureKeys from the GM (spec §4)', () => {
    const gm = actor('gm')
    expect(hasPermission(gm, 'ai.configureKeys')).toBe(false)
    for (const key of PERMISSION_KEYS) {
      if (key === 'ai.configureKeys') continue
      expect(hasPermission(gm, key), `gm should hold ${key}`).toBe(true)
    }
  })

  it('withholds payroll export, pay edits and settings from a manager', () => {
    const mgr = actor('manager')
    expect(hasPermission(mgr, 'schedule.publish')).toBe(true)
    expect(hasPermission(mgr, 'discipline.issue')).toBe(true)
    expect(hasPermission(mgr, 'payroll.view')).toBe(true)

    expect(hasPermission(mgr, 'payroll.export')).toBe(false)
    expect(hasPermission(mgr, 'payroll.lockPeriod')).toBe(false)
    expect(hasPermission(mgr, 'employees.editPay')).toBe(false)
    expect(hasPermission(mgr, 'permissions.manage')).toBe(false)
    expect(hasPermission(mgr, 'settings.manage')).toBe(false)
    expect(hasPermission(mgr, 'ai.configureKeys')).toBe(false)
  })

  it('limits a supervisor to view/lite keys', () => {
    const sup = actor('supervisor')
    expect(hasPermission(sup, 'schedule.view')).toBe(true)
    expect(hasPermission(sup, 'availability.viewAll')).toBe(true)
    expect(hasPermission(sup, 'tips.viewAll')).toBe(true)
    expect(hasPermission(sup, 'tasks.manage')).toBe(true)

    expect(hasPermission(sup, 'schedule.publish')).toBe(false)
    expect(hasPermission(sup, 'availability.approve')).toBe(false)
    expect(hasPermission(sup, 'trades.approve')).toBe(false)
    expect(hasPermission(sup, 'punches.edit')).toBe(false)
    expect(hasPermission(sup, 'discipline.view')).toBe(false)
  })

  it('limits staff to self-service keys', () => {
    const staff = actor('staff')
    expect(hasPermission(staff, 'timeclock.punchSelf')).toBe(true)
    expect(hasPermission(staff, 'tips.reportSelf')).toBe(true)
    expect(hasPermission(staff, 'trades.request')).toBe(true)
    expect(hasPermission(staff, 'schedule.view')).toBe(true)

    expect(hasPermission(staff, 'tips.viewAll')).toBe(false)
    expect(hasPermission(staff, 'punches.viewAll')).toBe(false)
    expect(hasPermission(staff, 'employees.view')).toBe(false)
    expect(hasPermission(staff, 'schedule.edit')).toBe(false)
  })
})

describe('permission overrides', () => {
  it('grants a key the role default denies', () => {
    const a = actor('manager', {
      permissionOverrides: { 'payroll.export': true },
    })
    expect(hasPermission(a, 'payroll.export')).toBe(true)
  })

  it('revokes a key the role default grants', () => {
    const a = actor('manager', {
      permissionOverrides: { 'schedule.publish': false },
    })
    expect(hasPermission(a, 'schedule.publish')).toBe(false)
  })

  it('treats an absent override as "inherit", not "deny"', () => {
    const a = actor('manager', { permissionOverrides: {} })
    expect(hasPermission(a, 'schedule.publish')).toBe(true)
  })

  it('can revoke from an owner', () => {
    const a = actor('owner', {
      permissionOverrides: { 'ai.configureKeys': false },
    })
    expect(hasPermission(a, 'ai.configureKeys')).toBe(false)
  })

  it('denies everything for a null actor', () => {
    for (const key of PERMISSION_KEYS) {
      expect(hasPermission(null, key)).toBe(false)
    }
  })
})

describe('canAccessSensitive — the below-your-level rule (spec §4)', () => {
  it('lets anyone see their own sensitive data', () => {
    const me = actor('staff', { id: 'emp-1' })
    expect(canAccessSensitive(me, { id: 'emp-1', accessRole: 'staff' })).toBe(true)
  })

  it('lets an owner see everyone, including other owners', () => {
    const owner = actor('owner', { id: 'owner-1' })
    for (const role of ACCESS_ROLES) {
      expect(canAccessSensitive(owner, target(role))).toBe(true)
    }
    expect(canAccessSensitive(owner, { id: 'owner-2', accessRole: 'owner' })).toBe(true)
  })

  it('DENIES equal rank — a manager cannot open another manager', () => {
    const mgr = actor('manager', { id: 'mgr-1' })
    expect(canAccessSensitive(mgr, { id: 'mgr-2', accessRole: 'manager' })).toBe(false)
  })

  it('denies looking upward', () => {
    expect(canAccessSensitive(actor('supervisor'), target('manager'))).toBe(false)
    expect(canAccessSensitive(actor('manager'), target('gm'))).toBe(false)
    expect(canAccessSensitive(actor('gm'), target('owner'))).toBe(false)
    expect(canAccessSensitive(actor('staff'), target('supervisor'))).toBe(false)
  })

  it('allows looking strictly downward', () => {
    expect(canAccessSensitive(actor('gm'), target('manager'))).toBe(true)
    expect(canAccessSensitive(actor('manager'), target('supervisor'))).toBe(true)
    expect(canAccessSensitive(actor('manager'), target('staff'))).toBe(true)
    expect(canAccessSensitive(actor('supervisor'), target('staff'))).toBe(true)
  })

  it('denies staff any sensitive access to another staff member', () => {
    const a = actor('staff', { id: 'emp-1' })
    expect(canAccessSensitive(a, { id: 'emp-2', accessRole: 'staff' })).toBe(false)
  })

  it('denies on null actor or target', () => {
    expect(canAccessSensitive(null, target('staff'))).toBe(false)
    expect(canAccessSensitive(actor('owner'), null)).toBe(false)
  })
})

describe('department scoping for approvals (spec §4)', () => {
  it('lets owner and GM bypass department', () => {
    expect(canApproveForDepartment(actor('owner', { department: 'FOH' }), 'BOH')).toBe(true)
    expect(canApproveForDepartment(actor('gm', { department: 'Admin' }), 'BOH')).toBe(true)
  })

  it('confines a manager to their own department', () => {
    const fohMgr = actor('manager', { department: 'FOH' })
    expect(canApproveForDepartment(fohMgr, 'FOH')).toBe(true)
    expect(canApproveForDepartment(fohMgr, 'BOH')).toBe(false)
  })
})

describe('canActOn — permission AND below-level together', () => {
  it('requires both to pass', () => {
    const mgr = actor('manager', { id: 'mgr-1' })

    // Holds punches.edit, and target is below → allowed.
    expect(canActOn(mgr, 'punches.edit', target('staff'))).toBe(true)

    // Holds punches.edit, but target is equal rank → blocked by below-level.
    expect(canActOn(mgr, 'punches.edit', { id: 'mgr-2', accessRole: 'manager' })).toBe(false)

    // Target is below, but the manager lacks employees.editPay → blocked.
    expect(canActOn(mgr, 'employees.editPay', target('staff'))).toBe(false)
  })
})

describe('viewableTipRoles — mirrors firestore.rules for list-query safety (Aug 14 2026)', () => {
  it('owner sees every role, including other owners (blanket bypass)', () => {
    expect(viewableTipRoles('owner')).toEqual(['owner', 'gm', 'manager', 'supervisor', 'staff'])
  })

  it('every non-owner role excludes its own rank (equal-rank is denied, spec §4)', () => {
    expect(viewableTipRoles('gm')).not.toContain('gm')
    expect(viewableTipRoles('manager')).not.toContain('manager')
    expect(viewableTipRoles('supervisor')).not.toContain('supervisor')
  })

  it('gm sees manager, supervisor, staff — strictly below', () => {
    expect(viewableTipRoles('gm')).toEqual(['manager', 'supervisor', 'staff'])
  })

  it('manager sees supervisor, staff — strictly below', () => {
    expect(viewableTipRoles('manager')).toEqual(['supervisor', 'staff'])
  })

  it('supervisor sees staff only', () => {
    expect(viewableTipRoles('supervisor')).toEqual(['staff'])
  })

  it('staff sees no one else\'s tips (self-access is handled separately, not via this list)', () => {
    expect(viewableTipRoles('staff')).toEqual([])
  })
})
