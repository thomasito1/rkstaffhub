import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest'

import { ROLE_DEFAULTS } from '../../src/lib/permissions/defaults'

/**
 * Firestore rules tests — spec §4 and §17 enforced SERVER-SIDE.
 *
 * The unit tests in src/lib/permissions cover the client helpers. These prove
 * the same rules hold when the client is hostile, which is the only version
 * that actually matters.
 *
 * Requires the Firestore emulator. Run via:  npm run test:rules:emulated
 */

const PROJECT_ID = 'demo-rk-staffhub'
let testEnv: RulesTestEnvironment

/** Authenticated context carrying the custom claims a real session would have. */
function ctx(uid: string, employeeId: string, role: string) {
  return testEnv.authenticatedContext(uid, { employeeId, role }).firestore()
}

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  })
})

afterAll(async () => {
  await testEnv?.cleanup()
})

beforeEach(async () => {
  await testEnv.clearFirestore()

  // Seed baseline docs with rules disabled.
  await testEnv.withSecurityRulesDisabled(async (admin) => {
    const db = admin.firestore()

    await setDoc(doc(db, 'permissions/roleDefaults'), { defaults: ROLE_DEFAULTS })

    const people: Array<[string, string, string]> = [
      ['emp-owner', 'owner', 'Admin'],
      ['emp-gm', 'gm', 'Admin'],
      ['emp-mgr-a', 'manager', 'FOH'],
      ['emp-mgr-b', 'manager', 'FOH'],
      ['emp-sup', 'supervisor', 'FOH'],
      ['emp-staff-a', 'staff', 'FOH'],
      ['emp-staff-b', 'staff', 'FOH'],
    ]

    for (const [id, accessRole, department] of people) {
      await setDoc(doc(db, `employees/${id}`), {
        employeeNumber: id.slice(-4),
        firstName: id,
        lastName: 'Test',
        email: `${id}@example.com`,
        accessRole,
        department,
        status: 'active',
        employmentType: 'hourly',
        clockRequired: true,
        tipsRequired: false,
        language: 'en',
        shiftRoles: [],
        authUids: [`uid-${id}`],
        hireDate: '2025-01-01',
      })
      await setDoc(doc(db, `employees/${id}/private/compensation`), {
        hourlyRate: 15,
        salaryAmount: null,
        salaryPeriod: null,
      })
      await setDoc(doc(db, `employees/${id}/private/admin`), {
        schedulingNotes: 'private note',
        permissionOverrides: {},
      })
    }
  })
})

describe('employees — roster reads', () => {
  it('lets any signed-in employee read the roster', async () => {
    const staff = ctx('uid-emp-staff-a', 'emp-staff-a', 'staff')
    await assertSucceeds(getDoc(doc(staff, 'employees/emp-staff-b')))
  })

  it('denies an unauthenticated read', async () => {
    const anon = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(doc(anon, 'employees/emp-staff-a')))
  })
})

describe('compensation — own rate yes, others gated (spec §17)', () => {
  it('lets an employee read their OWN rate', async () => {
    const staff = ctx('uid-emp-staff-a', 'emp-staff-a', 'staff')
    await assertSucceeds(getDoc(doc(staff, 'employees/emp-staff-a/private/compensation')))
  })

  it("denies staff reading a colleague's rate", async () => {
    const staff = ctx('uid-emp-staff-a', 'emp-staff-a', 'staff')
    await assertFails(getDoc(doc(staff, 'employees/emp-staff-b/private/compensation')))
  })

  it("denies a manager reading staff rates (managers lack employees.editPay)", async () => {
    const mgr = ctx('uid-emp-mgr-a', 'emp-mgr-a', 'manager')
    await assertFails(getDoc(doc(mgr, 'employees/emp-staff-a/private/compensation')))
  })

  it('lets the GM read staff rates', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertSucceeds(getDoc(doc(gm, 'employees/emp-staff-a/private/compensation')))
  })

  it('DENIES the GM reading an OWNER rate — nobody looks upward', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertFails(getDoc(doc(gm, 'employees/emp-owner/private/compensation')))
  })

  it('lets an owner read anyone', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertSucceeds(getDoc(doc(owner, 'employees/emp-gm/private/compensation')))
  })
})

describe('the equal-rank boundary — the rule most likely to regress', () => {
  it('DENIES a manager reading another MANAGER private admin data', async () => {
    const mgrA = ctx('uid-emp-mgr-a', 'emp-mgr-a', 'manager')
    await assertFails(getDoc(doc(mgrA, 'employees/emp-mgr-b/private/admin')))
  })

  it('DENIES staff reading another staff private admin data', async () => {
    const staffA = ctx('uid-emp-staff-a', 'emp-staff-a', 'staff')
    await assertFails(getDoc(doc(staffA, 'employees/emp-staff-b/private/admin')))
  })

  it('lets a manager read a SUPERVISOR private admin data (strictly below)', async () => {
    const mgr = ctx('uid-emp-mgr-a', 'emp-mgr-a', 'manager')
    await assertSucceeds(getDoc(doc(mgr, 'employees/emp-sup/private/admin')))
  })

  it('denies a supervisor reading a manager', async () => {
    const sup = ctx('uid-emp-sup', 'emp-sup', 'supervisor')
    await assertFails(getDoc(doc(sup, 'employees/emp-mgr-a/private/admin')))
  })
})

describe('privilege escalation is blocked', () => {
  it('denies staff promoting themselves', async () => {
    const staff = ctx('uid-emp-staff-a', 'emp-staff-a', 'staff')
    await assertFails(
      updateDoc(doc(staff, 'employees/emp-staff-a'), { accessRole: 'owner' }),
    )
  })

  it('denies staff editing their own employment type or clock requirement', async () => {
    const staff = ctx('uid-emp-staff-a', 'emp-staff-a', 'staff')
    await assertFails(
      updateDoc(doc(staff, 'employees/emp-staff-a'), { clockRequired: false }),
    )
    await assertFails(
      updateDoc(doc(staff, 'employees/emp-staff-a'), { employmentType: 'salaried-weekly' }),
    )
  })

  it('lets an employee update their own benign profile fields', async () => {
    const staff = ctx('uid-emp-staff-a', 'emp-staff-a', 'staff')
    await assertSucceeds(
      updateDoc(doc(staff, 'employees/emp-staff-a'), { phone: '(305) 555-0100' }),
    )
  })

  it('denies staff writing their own permission overrides', async () => {
    const staff = ctx('uid-emp-staff-a', 'emp-staff-a', 'staff')
    await assertFails(
      setDoc(doc(staff, 'employees/emp-staff-a/private/admin'), {
        permissionOverrides: { 'payroll.export': true },
      }),
    )
  })

  it('denies a manager writing permission overrides (lacks permissions.manage)', async () => {
    const mgr = ctx('uid-emp-mgr-a', 'emp-mgr-a', 'manager')
    await assertFails(
      setDoc(doc(mgr, 'employees/emp-staff-a/private/admin'), {
        permissionOverrides: { 'payroll.export': true },
      }),
    )
  })

  it('lets the GM write overrides for someone below them', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertSucceeds(
      setDoc(doc(gm, 'employees/emp-staff-a/private/admin'), {
        schedulingNotes: 'note',
        permissionOverrides: { 'payroll.view': true },
      }),
    )
  })

  it('denies deleting an employee — archive only (spec §18)', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    const { deleteDoc } = await import('firebase/firestore')
    await assertFails(deleteDoc(doc(owner, 'employees/emp-staff-a')))
  })
})

describe('auditLog is append-only from the server', () => {
  it('denies a client writing an audit entry, even an owner', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(
      setDoc(doc(owner, 'auditLog/entry-1'), { action: 'punch.edit', at: new Date() }),
    )
  })
})

describe('later-phase collections are denied by default', () => {
  it('denies reads of collections no phase has enabled yet', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(getDoc(doc(owner, 'punches/punch-1')))
    await assertFails(getDoc(doc(owner, 'schedules/2026-08-10')))
    await assertFails(getDoc(doc(owner, 'tipReports/tip-1')))
  })
})
