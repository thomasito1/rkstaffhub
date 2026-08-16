import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { collection, doc, getDocs, setDoc, updateDoc, deleteDoc, getDoc } from 'firebase/firestore'
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'

import { ROLE_DEFAULTS } from '../../src/lib/permissions/defaults'

/**
 * payPeriods — spec §11, Phase 3(c).
 *
 * The simplest gate in the whole ruleset: `allow read: if
 * hasPerm('payroll.view')`, `allow create, update, delete: if false`
 * unconditionally. No per-document department/rank scoping like
 * punches/tipReports/taskInstances — a flat hasPerm() check needs no
 * client-side query cooperation to hold, so a single-doc getDoc and an
 * unscoped list/getDocs must fail (or succeed) identically for the same
 * caller; there is no query SHAPE that could make an ineligible caller
 * provable, unlike the department-scoped collections' list-query-safety
 * tests.
 *
 * `payroll.view` was tightened OFF Manager's default grant set this session
 * (src/lib/permissions/defaults.ts — Rafa's ruling: "full sensitive-read
 * trio on payroll reads, Owner/GM only per matrix"). This file is the
 * regression guard for that change: manager/supervisor/staff must all be
 * denied both read shapes, on top of proving owner/gm both still succeed.
 *
 * Every write (lock/unlock/export-stamping) is Cloud-Function-only
 * (functions/src/payrollActions.ts / payrollExport.ts) — asserted here on
 * every role tier, including owner, mirroring taskInstances' "every write is
 * Cloud-Function-only, on every role" rigor in tasks.rules.test.ts.
 *
 * Requires the Firestore emulator. Run via: npm run test:rules:emulated
 */

const PROJECT_ID = 'demo-rk-staffhub'
let testEnv: RulesTestEnvironment

function ctx(uid: string, employeeId: string, role: string) {
  return testEnv.authenticatedContext(uid, { employeeId, role }).firestore()
}

function payPeriodPayload(over: Record<string, unknown> = {}) {
  return {
    startDate: '2026-08-10',
    endDate: '2026-08-16',
    status: 'open',
    lockedAt: null,
    lockedBy: null,
    unlockedAt: null,
    unlockedBy: null,
    unlockReason: null,
    exportedAt: null,
    exportedBy: null,
    exportFileName: null,
    locationId: null,
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

    // Role defaults: only 'owner' and 'gm' hold payroll.view after this
    // session's tightening — 'manager'/'supervisor'/'staff' do not (see
    // src/lib/permissions/defaults.ts's MANAGER comment block).
    const people: Array<[string, string, string]> = [
      ['emp-owner', 'owner', 'Admin'],
      ['emp-gm', 'gm', 'Admin'],
      ['emp-mgr-foh', 'manager', 'FOH'],
      ['emp-sup-foh', 'supervisor', 'FOH'],
      ['emp-staff-foh', 'staff', 'FOH'],
      // A manager with a PER-PERSON override granting payroll.view, proving
      // the rule reads effective permission (override ?? roleDefault), not a
      // hardcoded role check — see employees.rules.test.ts's
      // 'lets the GM write overrides for someone below them' for the
      // override shape this mirrors.
      ['emp-mgr-override', 'manager', 'FOH'],
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
        permissionOverrides: id === 'emp-mgr-override' ? { 'payroll.view': true } : {},
      })
    }

    await setDoc(doc(db, 'payPeriods/pp-current'), payPeriodPayload())
    await setDoc(doc(db, 'payPeriods/pp-prior'), payPeriodPayload({ startDate: '2026-08-03', endDate: '2026-08-09', status: 'locked' }))
  })
})

// ── read — cooperative: owner and gm both hold payroll.view ─────────────────

describe('payPeriods — read, payroll.view holders (owner, gm)', () => {
  it('lets an owner read a single period via getDoc', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertSucceeds(getDoc(doc(owner, 'payPeriods/pp-current')))
  })

  it('lets an owner list/getDocs the whole collection UNFILTERED — no where() clause needed to prove eligibility', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    const snap = await assertSucceeds(getDocs(collection(owner, 'payPeriods')))
    const ids = snap.docs.map((d) => d.id)
    expect(ids).toContain('pp-current')
    expect(ids).toContain('pp-prior')
  })

  it('lets a GM read a single period via getDoc', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertSucceeds(getDoc(doc(gm, 'payPeriods/pp-current')))
  })

  it('lets a GM list/getDocs the whole collection UNFILTERED', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    const snap = await assertSucceeds(getDocs(collection(gm, 'payPeriods')))
    const ids = snap.docs.map((d) => d.id)
    expect(ids).toContain('pp-current')
    expect(ids).toContain('pp-prior')
  })
})

// ── read — hostile: manager/supervisor/staff all now lack payroll.view ──────

describe('payPeriods — read, DENIED for non-holders (manager, supervisor, staff) — regression guard for this session\'s tightening', () => {
  it('DENIES a manager reading a single period via getDoc', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(getDoc(doc(mgr, 'payPeriods/pp-current')))
  })

  it('DENIES a manager listing/getDocs the whole collection', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(getDocs(collection(mgr, 'payPeriods')))
  })

  it('DENIES a supervisor reading a single period via getDoc', async () => {
    const sup = ctx('uid-emp-sup-foh', 'emp-sup-foh', 'supervisor')
    await assertFails(getDoc(doc(sup, 'payPeriods/pp-current')))
  })

  it('DENIES a supervisor listing/getDocs the whole collection', async () => {
    const sup = ctx('uid-emp-sup-foh', 'emp-sup-foh', 'supervisor')
    await assertFails(getDocs(collection(sup, 'payPeriods')))
  })

  it('DENIES a plain staff member reading a single period via getDoc', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(getDoc(doc(staff, 'payPeriods/pp-current')))
  })

  it('DENIES a plain staff member listing/getDocs the whole collection', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(getDocs(collection(staff, 'payPeriods')))
  })
})

// ── read — per-person override ───────────────────────────────────────────────

describe('payPeriods — read, effective permission (per-person override), not a hardcoded role check', () => {
  it('lets a manager with an explicit payroll.view override read a single period via getDoc', async () => {
    const mgr = ctx('uid-emp-mgr-override', 'emp-mgr-override', 'manager')
    await assertSucceeds(getDoc(doc(mgr, 'payPeriods/pp-current')))
  })

  it('lets a manager with an explicit payroll.view override list/getDocs the whole collection', async () => {
    const mgr = ctx('uid-emp-mgr-override', 'emp-mgr-override', 'manager')
    const snap = await assertSucceeds(getDocs(collection(mgr, 'payPeriods')))
    const ids = snap.docs.map((d) => d.id)
    expect(ids).toContain('pp-current')
    expect(ids).toContain('pp-prior')
  })
})

// ── write lockdown — every write is Cloud-Function-only, on every role ──────

describe('payPeriods — every write is Cloud-Function-only, on every role (lock/unlock/export are never raw client writes)', () => {
  it('denies an owner creating a period directly', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(setDoc(doc(owner, 'payPeriods/pp-new'), payPeriodPayload()))
  })

  it('denies an owner updating a period directly (e.g. raw-client lock attempt)', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(updateDoc(doc(owner, 'payPeriods/pp-current'), { status: 'locked' }))
  })

  it('denies an owner deleting a period directly', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(deleteDoc(doc(owner, 'payPeriods/pp-current')))
  })

  it('denies a GM creating a period directly', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertFails(setDoc(doc(gm, 'payPeriods/pp-new'), payPeriodPayload()))
  })

  it('denies a GM updating a period directly (e.g. raw-client unlock attempt)', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertFails(updateDoc(doc(gm, 'payPeriods/pp-prior'), { status: 'open', unlockReason: 'correction' }))
  })

  it('denies a GM deleting a period directly', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertFails(deleteDoc(doc(gm, 'payPeriods/pp-current')))
  })

  it('denies a manager creating a period directly', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(setDoc(doc(mgr, 'payPeriods/pp-new'), payPeriodPayload()))
  })

  it('denies a manager updating a period directly', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(updateDoc(doc(mgr, 'payPeriods/pp-current'), { status: 'locked' }))
  })

  it('denies a manager deleting a period directly', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(deleteDoc(doc(mgr, 'payPeriods/pp-current')))
  })
})
