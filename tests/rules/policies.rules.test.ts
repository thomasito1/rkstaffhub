import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { doc, setDoc, updateDoc, deleteDoc, getDoc } from 'firebase/firestore'
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest'

import { ROLE_DEFAULTS } from '../../src/lib/permissions/defaults'

/**
 * policies + signatures — spec §12, Phase 4.
 *
 * `policies` is the handbook: broadly readable (`allow read: if hasIdentity()`
 * — every employee needs to read what they're being asked to sign), but an
 * edit is NEVER a mutation of an existing version. `policies.manage` may
 * `create` a new version, and the ONLY `update` this rule permits on an
 * existing document is flipping `isCurrent` (+ `updatedAt`) on the superseded
 * doc — `request.resource.data.diff(resource.data).affectedKeys().hasOnly([...])`
 * — so this file proves both that the narrow update shape succeeds AND that
 * touching any other field (even one!) on an otherwise-legal update is
 * rejected, for a `policies.manage` holder same as anyone else. `delete` is
 * unconditionally `false` — a permanent historical record, no version is
 * ever removed, even by an owner.
 *
 * `signatures` has NO client-writable shape at all — `submitSignature`/
 * `recordRefusedToSign` are Cloud-Function-only, so create/update/delete are
 * asserted denied on every role including owner. Reads split by how
 * sensitive the TARGET is: a policy-targeted signature is a `policies.manage`
 * concern (roster-wide "who hasn't signed yet"), not a `discipline.view` one.
 * The disciplinary-targeted half of signatures' read boundary (below-level,
 * no-peer-file) is exercised in disciplinary.rules.test.ts alongside
 * `disciplinaryActions`, since it reuses the exact same `canAccessSensitive`
 * boundary that file is already set up to probe tier-by-tier.
 *
 * Requires the Firestore emulator. Run via: npm run test:rules:emulated
 */

const PROJECT_ID = 'demo-rk-staffhub'
let testEnv: RulesTestEnvironment

function ctx(uid: string, employeeId: string, role: string) {
  return testEnv.authenticatedContext(uid, { employeeId, role }).firestore()
}

function policyPayload(over: Record<string, unknown> = {}) {
  return {
    familyId: 'handbook-dress-code',
    title: 'Dress Code',
    titleEs: 'Código de Vestimenta',
    bodyMarkdown: '# Dress code\n\nBlack, non-slip shoes required.',
    bodyMarkdownEs: '# Código de Vestimenta\n\nZapatos negros antideslizantes requeridos.',
    version: 1,
    category: 'policy',
    requiresSignature: true,
    activeFrom: '2026-08-01',
    isCurrent: true,
    locationId: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...over,
  }
}

function signaturePayload(employeeId: string, over: Record<string, unknown> = {}) {
  return {
    employeeId,
    targetType: 'policy',
    targetId: 'policy-dress-code',
    policyVersion: 1,
    signatureImagePath: `signatures/${employeeId}/sig1.png`,
    signedAt: new Date('2026-08-10T15:00:00Z'),
    pdfStoragePath: null,
    emailedTo: null,
    emailPending: false,
    language: 'en',
    createdAt: new Date('2026-08-10T15:00:00Z'),
    ...over,
  }
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

    const people: Array<[string, string, string, Record<string, boolean>?]> = [
      ['emp-owner', 'owner', 'Admin'],
      ['emp-gm', 'gm', 'Admin'],
      ['emp-mgr-foh', 'manager', 'FOH'],
      ['emp-staff-foh', 'staff', 'FOH'],
      // No default policies.manage AND no discipline.view — an override
      // grants exactly one, isolating "may view policy-target signatures"
      // from "may view discipline-target signatures" (which a Manager would
      // otherwise conflate, since MANAGER's defaults already include
      // discipline.view — see src/lib/permissions/defaults.ts).
      ['emp-sup-policies', 'supervisor', 'FOH', { 'policies.manage': true }],
    ]

    for (const [id, accessRole, department, overrides] of people) {
      await setDoc(doc(db, `employees/${id}`), {
        employeeNumber: id.slice(-4),
        firstName: id,
        lastName: 'Test',
        email: `${id}@example.com`,
        accessRole,
        department,
        status: 'active',
        employmentType: 'hourly-tipped',
        clockRequired: true,
        tipsRequired: true,
        language: 'en',
        shiftRoles: [{ roleId: 'server', skillLevel: 2, isPrimary: true }],
        authUids: [`uid-${id}`],
        hireDate: '2025-01-01',
      })
      await setDoc(doc(db, `employees/${id}/private/admin`), {
        schedulingNotes: '',
        permissionOverrides: overrides ?? {},
      })
    }

    await setDoc(doc(db, 'policies/policy-dress-code'), policyPayload())
    await setDoc(doc(db, 'signatures/sig-staff-policy'), signaturePayload('emp-staff-foh'))
  })
})

// ── policies — read ──────────────────────────────────────────────────────────

describe('policies — read is broad (the handbook)', () => {
  it('lets a plain staff member read a policy', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(getDoc(doc(staff, 'policies/policy-dress-code')))
  })

  it('lets policies.manage holders read a policy too', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertSucceeds(getDoc(doc(gm, 'policies/policy-dress-code')))
  })
})

// ── policies — create ────────────────────────────────────────────────────────

describe('policies — create requires policies.manage', () => {
  it('lets an owner (policies.manage) create a new policy version', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertSucceeds(
      setDoc(doc(owner, 'policies/policy-dress-code-v2'), policyPayload({ version: 2 })),
    )
  })

  it('lets a GM (policies.manage) create a new policy version', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertSucceeds(
      setDoc(doc(gm, 'policies/policy-dress-code-v2'), policyPayload({ version: 2 })),
    )
  })

  it('DENIES a manager (no policies.manage by default) creating a policy', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(
      setDoc(doc(mgr, 'policies/policy-new'), policyPayload({ familyId: 'policy-new' })),
    )
  })

  it('DENIES a plain staff member creating a policy', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      setDoc(doc(staff, 'policies/policy-new'), policyPayload({ familyId: 'policy-new' })),
    )
  })
})

// ── policies — delete is ALWAYS denied ──────────────────────────────────────

describe('policies — delete is ALWAYS denied, even for policies.manage holders', () => {
  it('DENIES an owner deleting a policy (permanent historical record)', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(deleteDoc(doc(owner, 'policies/policy-dress-code')))
  })

  it('DENIES a GM deleting a policy', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertFails(deleteDoc(doc(gm, 'policies/policy-dress-code')))
  })

  it('DENIES a plain staff member deleting a policy', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(deleteDoc(doc(staff, 'policies/policy-dress-code')))
  })
})

// ── policies — update is narrow: {isCurrent, updatedAt} ONLY ───────────────

describe('policies — update permits ONLY {isCurrent, updatedAt}, even for policies.manage holders', () => {
  it('lets a policies.manage holder flip isCurrent + updatedAt (the supersede-on-new-version shape)', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertSucceeds(
      updateDoc(doc(gm, 'policies/policy-dress-code'), {
        isCurrent: false,
        updatedAt: new Date('2026-08-16T00:00:00Z'),
      }),
    )
  })

  it('DENIES a policies.manage holder changing bodyMarkdown, even alongside a legal isCurrent+updatedAt change', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertFails(
      updateDoc(doc(gm, 'policies/policy-dress-code'), {
        isCurrent: false,
        updatedAt: new Date('2026-08-16T00:00:00Z'),
        bodyMarkdown: '# Rewritten body',
      }),
    )
  })

  it('DENIES a policies.manage holder changing title alone', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(updateDoc(doc(owner, 'policies/policy-dress-code'), { title: 'New Title' }))
  })

  it('DENIES a policies.manage holder changing version alone', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(updateDoc(doc(owner, 'policies/policy-dress-code'), { version: 2 }))
  })

  it('DENIES a non-policies.manage holder even attempting the otherwise-legal isCurrent+updatedAt shape', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(
      updateDoc(doc(mgr, 'policies/policy-dress-code'), {
        isCurrent: false,
        updatedAt: new Date('2026-08-16T00:00:00Z'),
      }),
    )
  })
})

// ── signatures — every write is Cloud-Function-only, on every role ─────────

describe('signatures — every write is Cloud-Function-only (submitSignature/recordRefusedToSign), on every role', () => {
  it("denies the employee creating their OWN signature directly (must go through submitSignature)", async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      setDoc(doc(staff, 'signatures/sig-direct'), signaturePayload('emp-staff-foh')),
    )
  })

  it('DENIES an owner creating a signature directly', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(
      setDoc(doc(owner, 'signatures/sig-owner-direct'), signaturePayload('emp-staff-foh')),
    )
  })

  it('DENIES a policies.manage holder updating a signature directly', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertFails(
      updateDoc(doc(gm, 'signatures/sig-staff-policy'), { emailedTo: 'staff@example.com' }),
    )
  })

  it('denies deleting a signature under any role, including owner', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(deleteDoc(doc(owner, 'signatures/sig-staff-policy')))
  })
})

describe('signatures — read splits by target sensitivity (spec §12)', () => {
  it('lets the signing employee read their OWN signature', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(getDoc(doc(staff, 'signatures/sig-staff-policy')))
  })

  it('lets a policies.manage holder read a policy-targeted signature belonging to someone else', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertSucceeds(getDoc(doc(gm, 'signatures/sig-staff-policy')))
  })

  it('lets a policies.manage-ONLY holder (no discipline.view) read a policy-targeted signature too', async () => {
    const supPolicies = ctx('uid-emp-sup-policies', 'emp-sup-policies', 'supervisor')
    await assertSucceeds(getDoc(doc(supPolicies, 'signatures/sig-staff-policy')))
  })

  it('DENIES a policies.manage-ONLY holder (no discipline.view) reading a disciplinaryAction-targeted signature', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(
        doc(admin.firestore(), 'signatures/sig-staff-discipline'),
        signaturePayload('emp-staff-foh', {
          targetType: 'disciplinaryAction',
          targetId: 'action-1',
          policyVersion: null,
        }),
      )
    })
    const supPolicies = ctx('uid-emp-sup-policies', 'emp-sup-policies', 'supervisor')
    await assertFails(getDoc(doc(supPolicies, 'signatures/sig-staff-discipline')))
  })

  it('DENIES a random staff member (neither policies.manage nor discipline.view) reading a coworker\'s policy-targeted signature', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      const db = admin.firestore()
      await setDoc(doc(db, 'employees/emp-staff-foh2'), {
        employeeNumber: '9002',
        firstName: 'emp-staff-foh2',
        lastName: 'Test',
        email: 'emp-staff-foh2@example.com',
        accessRole: 'staff',
        department: 'FOH',
        status: 'active',
        employmentType: 'hourly-tipped',
        clockRequired: true,
        tipsRequired: true,
        language: 'en',
        shiftRoles: [{ roleId: 'server', skillLevel: 2, isPrimary: true }],
        authUids: ['uid-emp-staff-foh2'],
        hireDate: '2025-01-01',
      })
      await setDoc(doc(db, 'employees/emp-staff-foh2/private/admin'), {
        schedulingNotes: '',
        permissionOverrides: {},
      })
    })
    const peer = ctx('uid-emp-staff-foh2', 'emp-staff-foh2', 'staff')
    await assertFails(getDoc(doc(peer, 'signatures/sig-staff-policy')))
  })

  it('DENIES a random staff member reading a coworker\'s disciplinaryAction-targeted signature', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      const db = admin.firestore()
      await setDoc(doc(db, 'employees/emp-staff-foh2'), {
        employeeNumber: '9002',
        firstName: 'emp-staff-foh2',
        lastName: 'Test',
        email: 'emp-staff-foh2@example.com',
        accessRole: 'staff',
        department: 'FOH',
        status: 'active',
        employmentType: 'hourly-tipped',
        clockRequired: true,
        tipsRequired: true,
        language: 'en',
        shiftRoles: [{ roleId: 'server', skillLevel: 2, isPrimary: true }],
        authUids: ['uid-emp-staff-foh2'],
        hireDate: '2025-01-01',
      })
      await setDoc(doc(db, 'employees/emp-staff-foh2/private/admin'), {
        schedulingNotes: '',
        permissionOverrides: {},
      })
      await setDoc(
        doc(db, 'signatures/sig-staff-discipline'),
        signaturePayload('emp-staff-foh', {
          targetType: 'disciplinaryAction',
          targetId: 'action-1',
          policyVersion: null,
        }),
      )
    })
    const peer = ctx('uid-emp-staff-foh2', 'emp-staff-foh2', 'staff')
    await assertFails(getDoc(doc(peer, 'signatures/sig-staff-discipline')))
  })
})
