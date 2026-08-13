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
 * Degenerate-state rules tests.
 *
 * Every case here exercises a path where a rule could THROW instead of cleanly
 * returning false: a missing parent document, an absent field, an unknown role
 * claim, a signed-in user with no employeeId. Each must deny — and must deny
 * without an evaluation error.
 *
 * The "without an evaluation error" half cannot be asserted from inside the
 * test (assertFails passes for a throw too), so it is enforced by
 * scripts/check-rules-clean.mjs, which fails the run if the emulator reports
 * one. Run both together with: npm run test:rules:emulated
 */

const PROJECT_ID = 'demo-rk-staffhub'
let testEnv: RulesTestEnvironment

function ctx(uid: string, claims: Record<string, unknown>) {
  return testEnv.authenticatedContext(uid, claims).firestore()
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
  await testEnv.withSecurityRulesDisabled(async (admin) => {
    const db = admin.firestore()
    await setDoc(doc(db, 'permissions/roleDefaults'), { defaults: ROLE_DEFAULTS })

    // A complete, healthy manager — the control case.
    await setDoc(doc(db, 'employees/emp-mgr'), {
      firstName: 'Healthy',
      lastName: 'Manager',
      accessRole: 'manager',
      department: 'FOH',
      status: 'active',
    })
    await setDoc(doc(db, 'employees/emp-mgr/private/admin'), {
      permissionOverrides: {},
    })

    // A staff member with NO private/admin document at all.
    await setDoc(doc(db, 'employees/emp-no-admin'), {
      firstName: 'No',
      lastName: 'Admin',
      accessRole: 'staff',
      department: 'FOH',
      status: 'active',
    })

    // An employee document missing accessRole entirely.
    await setDoc(doc(db, 'employees/emp-no-role'), {
      firstName: 'No',
      lastName: 'Role',
      department: 'FOH',
      status: 'active',
    })
  })
})

describe('missing permissions/roleDefaults', () => {
  it('denies a privileged write when the defaults doc is absent', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      const { deleteDoc } = await import('firebase/firestore')
      await deleteDoc(doc(admin.firestore(), 'permissions/roleDefaults'))
    })

    const mgr = ctx('uid-mgr', { employeeId: 'emp-mgr', role: 'manager' })
    await assertFails(updateDoc(doc(mgr, 'employees/emp-no-admin'), { phone: '305' }))
  })
})

describe('missing private/admin (no overrides document)', () => {
  it('still resolves permissions from role defaults rather than throwing', async () => {
    // emp-no-admin has no private/admin doc. As staff they may edit their own
    // benign fields — this must SUCCEED, proving the missing doc degrades to
    // "no overrides" rather than erroring.
    const staff = ctx('uid-no-admin', { employeeId: 'emp-no-admin', role: 'staff' })
    await assertSucceeds(
      updateDoc(doc(staff, 'employees/emp-no-admin'), { phone: '(305) 555-0199' }),
    )
  })

  it('denies a privileged action for that same user', async () => {
    const staff = ctx('uid-no-admin', { employeeId: 'emp-no-admin', role: 'staff' })
    await assertFails(updateDoc(doc(staff, 'employees/emp-mgr'), { phone: '305' }))
  })
})

describe('missing parent employee document', () => {
  it('denies reading compensation under an employee that does not exist', async () => {
    const gm = ctx('uid-gm', { employeeId: 'emp-gm', role: 'gm' })
    await assertFails(getDoc(doc(gm, 'employees/emp-ghost/private/compensation')))
  })

  it('denies writing admin data under an employee that does not exist', async () => {
    const gm = ctx('uid-gm', { employeeId: 'emp-gm', role: 'gm' })
    await assertFails(
      setDoc(doc(gm, 'employees/emp-ghost/private/admin'), { schedulingNotes: 'x' }),
    )
  })
})

describe('employee document missing accessRole', () => {
  it('fails closed — a missing role is treated as the highest rank', async () => {
    const mgr = ctx('uid-mgr', { employeeId: 'emp-mgr', role: 'manager' })
    await assertFails(getDoc(doc(mgr, 'employees/emp-no-role/private/admin')))
  })
})

describe('malformed or absent claims', () => {
  it('denies a signed-in user carrying no employeeId claim', async () => {
    const orphan = ctx('uid-orphan', { role: 'manager' })
    await assertFails(updateDoc(doc(orphan, 'employees/emp-no-admin'), { phone: '305' }))
  })

  it('denies a user whose role claim is not a known access role', async () => {
    const bogus = ctx('uid-bogus', { employeeId: 'emp-mgr', role: 'superuser' })
    await assertFails(updateDoc(doc(bogus, 'employees/emp-no-admin'), { phone: '305' }))
  })

  it('denies an empty-string employeeId claim', async () => {
    const empty = ctx('uid-empty', { employeeId: '', role: 'owner' })
    await assertFails(updateDoc(doc(empty, 'employees/emp-no-admin'), { phone: '305' }))
  })

  it('still lets a well-formed owner through, proving the guards did not over-deny', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'employees/emp-owner'), {
        firstName: 'Real',
        lastName: 'Owner',
        accessRole: 'owner',
        department: 'Admin',
        status: 'active',
      })
    })
    const owner = ctx('uid-owner', { employeeId: 'emp-owner', role: 'owner' })
    await assertSucceeds(
      updateDoc(doc(owner, 'employees/emp-no-admin'), { phone: '(305) 555-0111' }),
    )
  })
})

describe('role escalation with degenerate payloads', () => {
  it('denies an update that omits accessRole while trying to escalate elsewhere', async () => {
    const staff = ctx('uid-no-admin', { employeeId: 'emp-no-admin', role: 'staff' })
    await assertFails(
      updateDoc(doc(staff, 'employees/emp-no-admin'), { accessRole: 'owner' }),
    )
  })

  it('denies a manager granting a role equal to their own', async () => {
    const mgr = ctx('uid-mgr', { employeeId: 'emp-mgr', role: 'manager' })
    await assertFails(
      updateDoc(doc(mgr, 'employees/emp-no-admin'), { accessRole: 'manager' }),
    )
  })
})
