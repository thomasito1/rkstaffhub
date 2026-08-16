import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
  type RulesTestContext,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { collection, doc, getDocs, query, setDoc, updateDoc, deleteDoc, getDoc, where } from 'firebase/firestore'
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * `admin.firestore()` (inside `withSecurityRulesDisabled`) returns the
 * COMPAT-namespaced `firebase.firestore.Firestore` type, not the modular
 * `Firestore` from `firebase/firestore` — they're structurally compatible at
 * every call site in this repo that inlines the call, but a named helper
 * function parameter needs its OWN type matching what's actually passed.
 */
type CompatFirestore = ReturnType<RulesTestContext['firestore']>

import { ROLE_DEFAULTS } from '../../src/lib/permissions/defaults'

/**
 * disciplinaryActions + disciplinaryLadder — spec §4, §12, §17, Phase 4.
 *
 * The MOST sensitive collection in this app (Rafa's own ruling): full trio
 * (create/update/delete all Cloud-Function-only, on every role including
 * owner), strict below-level, NO PEER-FILE READS — two Managers cannot see
 * each other's, two GMs cannot see each other's, two Supervisors cannot see
 * each other's. Staff read only their own.
 *
 * ONE deliberate, spec-driven exception to "no peer reads": OWNER. Spec §4
 * states plainly "Owners see all," with no below-level carve-out for the
 * Owner tier specifically, and `canAccessSensitive()` (the same below-level
 * helper this file's sibling collections all use) already encodes that
 * exemption everywhere else in this ruleset (`myRole() == 'owner'` short-
 * circuits the rank comparison entirely, so an Owner can already read a
 * peer Owner's compensation, permission overrides, and tip reports).
 * `viewableDisciplineRoles('owner')` mirrors that same exemption by
 * including 'owner' in its own returned set — unlike every other tier's
 * entry, which excludes its own role. This file tests that boundary
 * EXPLICITLY (an Owner CAN read another Owner's disciplinary action) rather
 * than assuming it should fail closed like every other tier, because the
 * spec text is unambiguous and the pattern is already load-bearing
 * elsewhere in this file. See the final report for how this was verified,
 * not assumed.
 *
 * `employeeAccessRole` is denormalized directly onto each disciplinaryAction
 * document (same shape as `TipReport.employeeAccessRole`), so unlike the
 * signature-boundary tests below (which DO need real target `employees`
 * docs, because `canAccessSensitive()` looks the target up), the
 * disciplinaryActions boundary tests only need the field set on the action
 * document itself.
 *
 * Requires the Firestore emulator. Run via: npm run test:rules:emulated
 */

const PROJECT_ID = 'demo-rk-staffhub'
let testEnv: RulesTestEnvironment

function ctx(uid: string, employeeId: string, role: string) {
  return testEnv.authenticatedContext(uid, { employeeId, role }).firestore()
}

function actionPayload(employeeId: string, employeeAccessRole: string | undefined, over: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    employeeId,
    type: 'verbal-warning',
    date: '2026-08-10',
    issuedBy: 'emp-mgr-foh',
    policyRefs: [],
    narrative: 'Late arrival, 8/10.',
    signatureId: null,
    status: 'issued',
    refusedWitnessEmployeeId: null,
    refusedAt: null,
    pdfStoragePath: null,
    emailedTo: null,
    emailPending: false,
    locationId: null,
    createdAt: new Date('2026-08-10T18:00:00Z'),
    updatedAt: new Date('2026-08-10T18:00:00Z'),
    ...over,
  }
  if (employeeAccessRole !== undefined) base.employeeAccessRole = employeeAccessRole
  return base
}

function ladderPayload(over: Record<string, unknown> = {}) {
  return {
    steps: [
      { order: 1, type: 'verbal-warning', thresholdCount: 2, consequenceText: 'Next incident: written warning', consequenceTextEs: 'Próximo incidente: amonestación escrita' },
      { order: 2, type: 'written-warning', thresholdCount: 1, consequenceText: 'Next incident: write-up', consequenceTextEs: 'Próximo incidente: acta' },
    ],
    locationId: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...over,
  }
}

function signaturePayload(employeeId: string, over: Record<string, unknown> = {}) {
  return {
    employeeId,
    targetType: 'disciplinaryAction',
    targetId: 'action-1',
    policyVersion: null,
    signatureImagePath: `signatures/${employeeId}/sig1.png`,
    signedAt: new Date('2026-08-10T18:10:00Z'),
    pdfStoragePath: null,
    emailedTo: null,
    emailPending: false,
    language: 'en',
    createdAt: new Date('2026-08-10T18:10:00Z'),
    ...over,
  }
}

async function seedEmployee(
  db: CompatFirestore,
  id: string,
  accessRole: string,
  department: string,
  overrides: Record<string, boolean> = {},
) {
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
    permissionOverrides: overrides,
  })
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

    await seedEmployee(db, 'emp-owner', 'owner', 'Admin')
    await seedEmployee(db, 'emp-owner2', 'owner', 'Admin')
    await seedEmployee(db, 'emp-gm', 'gm', 'Admin')
    await seedEmployee(db, 'emp-gm2', 'gm', 'Admin')
    await seedEmployee(db, 'emp-mgr-foh', 'manager', 'FOH')
    await seedEmployee(db, 'emp-mgr-foh2', 'manager', 'FOH')
    // Supervisor's role defaults do NOT include discipline.view (see
    // src/lib/permissions/defaults.ts's SUPERVISOR list) — an explicit
    // override grants it here, isolating "does the below-level BOUNDARY
    // hold for this tier" from "does this tier get the permission by
    // default" (a different, already-covered question).
    await seedEmployee(db, 'emp-sup-foh', 'supervisor', 'FOH', { 'discipline.view': true })
    await seedEmployee(db, 'emp-sup-foh2', 'supervisor', 'FOH')
    await seedEmployee(db, 'emp-staff-foh', 'staff', 'FOH')
    await seedEmployee(db, 'emp-staff-foh2', 'staff', 'FOH')

    await setDoc(doc(db, 'disciplinaryActions/action-staff'), actionPayload('emp-staff-foh', 'staff'))
    await setDoc(doc(db, 'disciplinaryActions/action-sup'), actionPayload('emp-sup-foh', 'supervisor'))
    await setDoc(doc(db, 'disciplinaryActions/action-sup-peer'), actionPayload('emp-sup-foh2', 'supervisor'))
    await setDoc(doc(db, 'disciplinaryActions/action-mgr'), actionPayload('emp-mgr-foh', 'manager'))
    await setDoc(doc(db, 'disciplinaryActions/action-mgr-peer'), actionPayload('emp-mgr-foh2', 'manager'))
    await setDoc(doc(db, 'disciplinaryActions/action-gm'), actionPayload('emp-gm', 'gm'))
    await setDoc(doc(db, 'disciplinaryActions/action-gm-peer'), actionPayload('emp-gm2', 'gm'))
    await setDoc(doc(db, 'disciplinaryActions/action-owner'), actionPayload('emp-owner', 'owner'))
    await setDoc(doc(db, 'disciplinaryActions/action-owner-peer'), actionPayload('emp-owner2', 'owner'))
    // A pre-existing record from before employeeAccessRole was denormalized
    // — fails closed to 'owner', same as TipReport's matching legacy test.
    await setDoc(doc(db, 'disciplinaryActions/action-legacy'), actionPayload('emp-mgr-foh2', undefined))

    await setDoc(doc(db, 'disciplinaryLadder/ladder-main'), ladderPayload())
  })
})

// ── disciplinaryActions — write lockdown ────────────────────────────────────

describe('disciplinaryActions — every write is Cloud-Function-only (issueDisciplinaryAction/recordRefusedToSign), on every role', () => {
  it('DENIES a staff member creating their own disciplinary action directly', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      setDoc(doc(staff, 'disciplinaryActions/action-direct'), actionPayload('emp-staff-foh', 'staff')),
    )
  })

  it('DENIES a supervisor (with discipline.view) creating a disciplinary action directly', async () => {
    const sup = ctx('uid-emp-sup-foh', 'emp-sup-foh', 'supervisor')
    await assertFails(
      setDoc(doc(sup, 'disciplinaryActions/action-direct'), actionPayload('emp-staff-foh', 'staff')),
    )
  })

  it('DENIES a manager (discipline.view + discipline.issue) creating a disciplinary action directly', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(
      setDoc(doc(mgr, 'disciplinaryActions/action-direct'), actionPayload('emp-staff-foh', 'staff')),
    )
  })

  it('DENIES a manager updating an existing disciplinary action directly (e.g. narrative edit)', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(updateDoc(doc(mgr, 'disciplinaryActions/action-staff'), { narrative: 'Edited.' }))
  })

  it('DENIES a GM creating a disciplinary action directly', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertFails(
      setDoc(doc(gm, 'disciplinaryActions/action-direct'), actionPayload('emp-staff-foh', 'staff')),
    )
  })

  it('DENIES an owner creating a disciplinary action directly', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(
      setDoc(doc(owner, 'disciplinaryActions/action-direct'), actionPayload('emp-staff-foh', 'staff')),
    )
  })

  it('denies deleting a disciplinary action under any role, including owner', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(deleteDoc(doc(owner, 'disciplinaryActions/action-staff')))
  })
})

// ── disciplinaryActions — self always reads own ─────────────────────────────

describe('disciplinaryActions — an employee always reads their OWN actions (isSelf)', () => {
  it('lets a plain staff member read their own action', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(getDoc(doc(staff, 'disciplinaryActions/action-staff')))
  })

  it('lets a manager read their own action (isSelf, independent of discipline.view)', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(getDoc(doc(mgr, 'disciplinaryActions/action-mgr')))
  })
})

describe("disciplinaryActions — a coworker with NEITHER isSelf NOR discipline.view is denied entirely", () => {
  it("DENIES a plain staff member reading a COWORKER's action", async () => {
    const peer = ctx('uid-emp-staff-foh2', 'emp-staff-foh2', 'staff')
    await assertFails(getDoc(doc(peer, 'disciplinaryActions/action-staff')))
  })
})

// ── disciplinaryActions — below-level boundary, tier by tier ────────────────

describe('disciplinaryActions — below-level boundary: OWNER (spec §4 "Owners see all" — the one deliberate exception to no-peer-reads)', () => {
  it("lets an owner read a GM's action", async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertSucceeds(getDoc(doc(owner, 'disciplinaryActions/action-gm')))
  })

  it("lets an owner read a manager's action", async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertSucceeds(getDoc(doc(owner, 'disciplinaryActions/action-mgr')))
  })

  it("lets an owner read a supervisor's action", async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertSucceeds(getDoc(doc(owner, 'disciplinaryActions/action-sup')))
  })

  it("lets an owner read a staff member's action", async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertSucceeds(getDoc(doc(owner, 'disciplinaryActions/action-staff')))
  })

  it("lets an owner read a PEER OWNER's action — 'Owners see all' has no below-level carve-out (matches canAccessSensitive()'s existing owner exemption everywhere else in this ruleset)", async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertSucceeds(getDoc(doc(owner, 'disciplinaryActions/action-owner-peer')))
  })
})

describe('disciplinaryActions — below-level boundary: GM (no peer reads)', () => {
  it("lets a GM read a manager's action", async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertSucceeds(getDoc(doc(gm, 'disciplinaryActions/action-mgr')))
  })

  it("lets a GM read a supervisor's action", async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertSucceeds(getDoc(doc(gm, 'disciplinaryActions/action-sup')))
  })

  it("lets a GM read a staff member's action", async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertSucceeds(getDoc(doc(gm, 'disciplinaryActions/action-staff')))
  })

  it("DENIES a GM reading a PEER GM's action", async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertFails(getDoc(doc(gm, 'disciplinaryActions/action-gm-peer')))
  })

  it("DENIES a GM reading an OWNER's action (above their level)", async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertFails(getDoc(doc(gm, 'disciplinaryActions/action-owner')))
  })
})

describe('disciplinaryActions — below-level boundary: MANAGER (no peer reads — spec §12: "Managers can\'t see other managers\' files")', () => {
  it("lets a manager read a supervisor's action", async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(getDoc(doc(mgr, 'disciplinaryActions/action-sup')))
  })

  it("lets a manager read a staff member's action", async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(getDoc(doc(mgr, 'disciplinaryActions/action-staff')))
  })

  it("DENIES a manager reading a PEER manager's action", async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(getDoc(doc(mgr, 'disciplinaryActions/action-mgr-peer')))
  })

  it("DENIES a manager reading a GM's action (above their level)", async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(getDoc(doc(mgr, 'disciplinaryActions/action-gm')))
  })

  it("DENIES a manager reading a PEER manager's LEGACY action missing employeeAccessRole (fails closed to 'owner', never widens)", async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(getDoc(doc(mgr, 'disciplinaryActions/action-legacy')))
  })
})

describe('disciplinaryActions — below-level boundary: SUPERVISOR (with an explicit discipline.view override; no peer reads)', () => {
  it("lets a supervisor (discipline.view override) read a staff member's action", async () => {
    const sup = ctx('uid-emp-sup-foh', 'emp-sup-foh', 'supervisor')
    await assertSucceeds(getDoc(doc(sup, 'disciplinaryActions/action-staff')))
  })

  it("DENIES a supervisor (discipline.view override) reading a PEER supervisor's action", async () => {
    const sup = ctx('uid-emp-sup-foh', 'emp-sup-foh', 'supervisor')
    await assertFails(getDoc(doc(sup, 'disciplinaryActions/action-sup-peer')))
  })

  it("DENIES a supervisor (discipline.view override) reading a manager's action (above their level)", async () => {
    const sup = ctx('uid-emp-sup-foh', 'emp-sup-foh', 'supervisor')
    await assertFails(getDoc(doc(sup, 'disciplinaryActions/action-mgr')))
  })

  it('DENIES a supervisor WITHOUT the discipline.view override from reading even a below-level staff action', async () => {
    const sup2 = ctx('uid-emp-sup-foh2', 'emp-sup-foh2', 'supervisor')
    await assertFails(getDoc(doc(sup2, 'disciplinaryActions/action-staff')))
  })
})

// ── disciplinaryActions — LIST queries (membership-check pattern) ──────────

describe('disciplinaryActions — LIST queries mirror tipReports\' membership-check pattern exactly (a rank COMPARISON is never provable for a list)', () => {
  it('lets a manager list disciplinary actions scoped to viewableDisciplineRoles via a real where(employeeAccessRole in [...]) query', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    const snap = await assertSucceeds(
      getDocs(
        query(
          collection(mgr, 'disciplinaryActions'),
          where('employeeAccessRole', 'in', ['supervisor', 'staff']),
        ),
      ),
    )
    const ids = snap.docs.map((d) => d.id)
    expect(ids).toEqual(expect.arrayContaining(['action-staff', 'action-sup', 'action-sup-peer']))
    // A manager peer's own-rank action is excluded by the query's own 'in'
    // filter, not by a per-document rule check.
    expect(ids).not.toContain('action-mgr')
    expect(ids).not.toContain('action-mgr-peer')
  })

  it("lets the owner list every action via the same query shape, including a PEER OWNER's — owner's viewableDisciplineRoles includes every role", async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    const snap = await assertSucceeds(
      getDocs(
        query(
          collection(owner, 'disciplinaryActions'),
          where('employeeAccessRole', 'in', ['owner', 'gm', 'manager', 'supervisor', 'staff']),
        ),
      ),
    )
    const ids = snap.docs.map((d) => d.id)
    expect(ids).toEqual(
      expect.arrayContaining(['action-owner', 'action-owner-peer', 'action-gm', 'action-mgr', 'action-sup', 'action-staff']),
    )
  })

  it('DENIES a manager WITH discipline.view who omits the employeeAccessRole where() clause entirely (unfiltered list)', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(getDocs(collection(mgr, 'disciplinaryActions')))
  })

  it('DENIES a staff member (no discipline.view) attempting the admin list query shape at all', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      getDocs(query(collection(staff, 'disciplinaryActions'), where('employeeAccessRole', 'in', ['staff']))),
    )
  })

  it("DENIES a manager who pads the employeeAccessRole 'in' array to include their OWN rank — can't smuggle a peer's file through by widening the filter", async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(
      getDocs(
        query(
          collection(mgr, 'disciplinaryActions'),
          where('employeeAccessRole', 'in', ['manager', 'supervisor', 'staff']),
        ),
      ),
    )
  })
})

// ── disciplinaryLadder ───────────────────────────────────────────────────────

describe('disciplinaryLadder — read is broad (the profile ladder widget needs it for every employee); write requires settings.manage', () => {
  it('lets a plain staff member read the ladder (their own progress-widget copy)', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(getDoc(doc(staff, 'disciplinaryLadder/ladder-main')))
  })

  it('lets an owner (settings.manage) create/write the ladder', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertSucceeds(setDoc(doc(owner, 'disciplinaryLadder/ladder-new'), ladderPayload()))
  })

  it('lets a GM (settings.manage) update the ladder', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertSucceeds(
      updateDoc(doc(gm, 'disciplinaryLadder/ladder-main'), { updatedAt: new Date('2026-08-16T00:00:00Z') }),
    )
  })

  it('DENIES a manager (discipline.issue, but NOT settings.manage) writing the escalation ladder', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(
      updateDoc(doc(mgr, 'disciplinaryLadder/ladder-main'), { updatedAt: new Date('2026-08-16T00:00:00Z') }),
    )
  })

  it('DENIES a manager creating a new ladder document directly', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(setDoc(doc(mgr, 'disciplinaryLadder/ladder-new'), ladderPayload()))
  })

  it('DENIES a manager deleting the ladder', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(deleteDoc(doc(mgr, 'disciplinaryLadder/ladder-main')))
  })
})

// ── signatures — disciplinaryAction-target below-level boundary ────────────
// (Cloud-Function-only write path + policy-target reads are covered in
// policies.rules.test.ts; this is specifically the below-level boundary
// that reuses canAccessSensitive(), which — unlike disciplinaryActions'
// own denormalized employeeAccessRole field — DOES look the target
// employee up live, so it needs the real `employees` docs seeded above.)

describe("signatures — disciplinaryAction-targeted reads require discipline.view AND below-level (canAccessSensitive)", () => {
  it('lets a manager (discipline.view) read a below-level staff signature', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'signatures/sig-staff-discipline'), signaturePayload('emp-staff-foh'))
    })
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(getDoc(doc(mgr, 'signatures/sig-staff-discipline')))
  })

  it("DENIES a manager (discipline.view) reading a PEER manager's disciplinaryAction-targeted signature — same-level-or-above is denied even with discipline.view", async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'signatures/sig-mgr-discipline'), signaturePayload('emp-mgr-foh2'))
    })
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(getDoc(doc(mgr, 'signatures/sig-mgr-discipline')))
  })

  it('lets the signing employee read their OWN disciplinaryAction-targeted signature regardless of rank', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'signatures/sig-mgr-discipline'), signaturePayload('emp-mgr-foh2'))
    })
    const self = ctx('uid-emp-mgr-foh2', 'emp-mgr-foh2', 'manager')
    await assertSucceeds(getDoc(doc(self, 'signatures/sig-mgr-discipline')))
  })
})
