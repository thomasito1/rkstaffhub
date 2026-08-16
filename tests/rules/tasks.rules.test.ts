import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { collection, doc, getDocs, query, setDoc, updateDoc, deleteDoc, getDoc, where } from 'firebase/firestore'
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'

import { ROLE_DEFAULTS } from '../../src/lib/permissions/defaults'

/**
 * tasks (definitions) + taskInstances — spec §10, Phase 3(b), enforced
 * SERVER-SIDE.
 *
 * `tasks/{taskDefId}` is `tasks.manage`-gated for BOTH read and write —
 * nobody else ever reads a definition directly, since every materialized
 * `taskInstance` denormalizes title/titleEs/dueRule/requiresPhoto at
 * creation time (see `TaskInstance`'s doc comment in `src/types/models.ts`).
 *
 * `taskInstances/{instanceId}` has NO client-writable surface at all —
 * materialization and completion both run under the Admin SDK
 * (`functions/src/tasksScheduled.ts`/`taskActions.ts`), same shape as
 * `punches`/`tipReports` — so this file's job for that half is proving
 * every write is denied unconditionally, on every role, and that reads stay
 * correctly scoped: self (assignee, any department) OR
 * `mayViewPoolInstance()` (`tasks.manage` any department, or
 * `tasks.complete` + still-unclaimed + matching department). The department half is the same
 * list-query-safety shape as `punches`' `mayViewPunch()` — see
 * `punchesTipsTrades.rules.test.ts`'s LIST-query describe blocks for the
 * precedent this mirrors: a `list` request is evaluated against the
 * query's POTENTIAL result set using only the query's own where()-pinned
 * values and the caller's claims, never real per-document data, and is
 * denied WHOLESALE if it can't prove every possible match is allowed.
 *
 * Requires the Firestore emulator. Run via: npm run test:rules:emulated
 */

const PROJECT_ID = 'demo-rk-staffhub'
let testEnv: RulesTestEnvironment

function ctx(uid: string, employeeId: string, role: string) {
  return testEnv.authenticatedContext(uid, { employeeId, role }).firestore()
}

function taskDefPayload(over: Record<string, unknown> = {}) {
  return {
    title: 'Wipe down counters',
    titleEs: 'Limpiar los mostradores',
    description: 'Wipe every prep counter down before close.',
    descriptionEs: 'Limpia cada mostrador de preparación antes de cerrar.',
    cadence: 'daily',
    assignTo: { type: 'department', ids: ['FOH'] },
    dueRule: 'end-of-shift',
    requiresPhoto: false,
    active: true,
    locationId: null,
    ...over,
  }
}

function taskInstancePayload(over: Record<string, unknown> = {}) {
  return {
    taskDefId: 'taskdef-counters',
    title: 'Wipe down counters',
    titleEs: 'Limpiar los mostradores',
    dueRule: 'end-of-shift',
    requiresPhoto: false,
    cadence: 'daily',
    period: '2026-08-10',
    shiftId: null,
    // null = unclaimed pool instance (role/department assignTo).
    assigneeEmployeeId: null,
    status: 'open',
    completedBy: null,
    completedAt: null,
    notes: null,
    photoPath: null,
    department: 'FOH',
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

    // Role defaults: 'staff' has tasks.complete but NOT tasks.manage.
    // 'supervisor' and 'manager' both have tasks.manage (SUPERVISOR grants
    // it, MANAGER inherits from SUPERVISOR) — see src/lib/permissions/defaults.ts.
    const people: Array<[string, string, string]> = [
      ['emp-owner', 'owner', 'Admin'],
      ['emp-mgr-foh', 'manager', 'FOH'],
      ['emp-sup-foh', 'supervisor', 'FOH'],
      ['emp-staff-foh', 'staff', 'FOH'],
      ['emp-staff-foh2', 'staff', 'FOH'],
      ['emp-staff-boh', 'staff', 'BOH'],
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
        permissionOverrides: {},
      })
    }

    await setDoc(doc(db, 'tasks/taskdef-counters'), taskDefPayload())
  })
})

// ── tasks (definitions) ───────────────────────────────────────────────────────

describe('tasks (definitions) — tasks.manage-gated read AND write (spec §10)', () => {
  it('lets a tasks.manage holder (supervisor) read a definition', async () => {
    const sup = ctx('uid-emp-sup-foh', 'emp-sup-foh', 'supervisor')
    await assertSucceeds(getDoc(doc(sup, 'tasks/taskdef-counters')))
  })

  it('lets a tasks.manage holder (manager) read a definition', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(getDoc(doc(mgr, 'tasks/taskdef-counters')))
  })

  it('lets a tasks.manage holder create a new definition', async () => {
    const sup = ctx('uid-emp-sup-foh', 'emp-sup-foh', 'supervisor')
    await assertSucceeds(
      setDoc(doc(sup, 'tasks/taskdef-new'), taskDefPayload({ title: 'Restock napkins' })),
    )
  })

  it('lets a tasks.manage holder update a definition', async () => {
    const sup = ctx('uid-emp-sup-foh', 'emp-sup-foh', 'supervisor')
    await assertSucceeds(
      updateDoc(doc(sup, 'tasks/taskdef-counters'), { active: false }),
    )
  })

  it("DENIES a plain staff member (has tasks.complete, NOT tasks.manage) reading a definition", async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(getDoc(doc(staff, 'tasks/taskdef-counters')))
  })

  it("DENIES a plain staff member (tasks.complete only) creating a definition", async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      setDoc(doc(staff, 'tasks/taskdef-hostile'), taskDefPayload()),
    )
  })

  it("DENIES a plain staff member (tasks.complete only) updating a definition", async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      updateDoc(doc(staff, 'tasks/taskdef-counters'), { active: false }),
    )
  })

  it('DENIES a staff member listing the whole definitions collection', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(getDocs(collection(staff, 'tasks')))
  })
})

// ── taskInstances — write lockdown ────────────────────────────────────────────

describe('taskInstances — every write is Cloud-Function-only, on every role (spec §10, §17)', () => {
  it('denies the assignee creating their OWN instance directly', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      setDoc(
        doc(staff, 'taskInstances/inst-direct'),
        taskInstancePayload({ assigneeEmployeeId: 'emp-staff-foh' }),
      ),
    )
  })

  it('denies the assignee updating their own instance (e.g. self-marking done, must go through completeTaskInstance)', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(
        doc(admin.firestore(), 'taskInstances/inst-mine'),
        taskInstancePayload({ assigneeEmployeeId: 'emp-staff-foh' }),
      )
    })
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      updateDoc(doc(staff, 'taskInstances/inst-mine'), { status: 'done', completedBy: 'emp-staff-foh' }),
    )
  })

  it('denies a manager creating an instance directly', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(
      setDoc(doc(mgr, 'taskInstances/inst-mgr-direct'), taskInstancePayload()),
    )
  })

  it('denies a manager updating an instance directly', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'taskInstances/inst-pool-foh'), taskInstancePayload())
    })
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(
      updateDoc(doc(mgr, 'taskInstances/inst-pool-foh'), { status: 'missed' }),
    )
  })

  it('denies even a tasks.manage holder (supervisor) creating an instance directly', async () => {
    const sup = ctx('uid-emp-sup-foh', 'emp-sup-foh', 'supervisor')
    await assertFails(
      setDoc(doc(sup, 'taskInstances/inst-sup-direct'), taskInstancePayload()),
    )
  })

  it('denies even a tasks.manage holder (supervisor) updating an instance directly', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'taskInstances/inst-pool-foh'), taskInstancePayload())
    })
    const sup = ctx('uid-emp-sup-foh', 'emp-sup-foh', 'supervisor')
    await assertFails(
      updateDoc(doc(sup, 'taskInstances/inst-pool-foh'), { assigneeEmployeeId: 'emp-sup-foh' }),
    )
  })

  it('denies deleting an instance under any role, including owner', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'taskInstances/inst-del'), taskInstancePayload())
    })
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(deleteDoc(doc(owner, 'taskInstances/inst-del')))
  })
})

// ── taskInstances — read, self ────────────────────────────────────────────────

describe('taskInstances — read, self (isSelf(assigneeEmployeeId), regardless of department)', () => {
  it('lets an employee read an instance assigned to them even when it belongs to a DIFFERENT department', async () => {
    // emp-staff-foh is FOH; the instance itself is denormalized as BOH
    // (e.g. covering a cross-department fill-in shift). isSelf() must win
    // on identity alone, independent of the department comparison.
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(
        doc(admin.firestore(), 'taskInstances/inst-cross-dept-self'),
        taskInstancePayload({ assigneeEmployeeId: 'emp-staff-foh', department: 'BOH' }),
      )
    })
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(getDoc(doc(staff, 'taskInstances/inst-cross-dept-self')))
  })

  it("DENIES a same-department PEER (tasks.complete, not the assignee) reading another employee's ALREADY-ASSIGNED instance", async () => {
    // Found by this file's own first pass (Aug 16 2026): mayViewPoolInstance()
    // originally checked department only, so any tasks.complete holder could
    // read a coworker's already-claimed instance (notes, completedBy,
    // photoPath) in their own department — not just an unclaimed pool one.
    // Fixed in firestore.rules by adding isUnclaimedPoolInstance()
    // (assigneeEmployeeId == null) to mayViewPoolInstance(), mirroring
    // trades' mayReadTrade() requiring status == 'open' before a
    // same-department non-party gets a read.
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(
        doc(admin.firestore(), 'taskInstances/inst-assigned-peer'),
        taskInstancePayload({ assigneeEmployeeId: 'emp-staff-foh2', department: 'FOH' }),
      )
    })
    const peer = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(getDoc(doc(peer, 'taskInstances/inst-assigned-peer')))
  })
})

// ── taskInstances — read, pool visibility (list-query safety) ────────────────

describe('taskInstances — read, pool visibility for tasks.complete (list-query safety, mirrors punches)', () => {
  it('lets a tasks.complete holder list unclaimed pool instances via a real query scoped to their own department', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      const db = admin.firestore()
      await setDoc(doc(db, 'taskInstances/inst-pool-foh'), taskInstancePayload({ department: 'FOH' }))
      await setDoc(doc(db, 'taskInstances/inst-pool-boh'), taskInstancePayload({ department: 'BOH' }))
    })
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    const snap = await assertSucceeds(
      getDocs(
        query(
          collection(staff, 'taskInstances'),
          where('assigneeEmployeeId', '==', null),
          where('department', '==', 'FOH'),
          where('status', '==', 'open'),
        ),
      ),
    )
    const ids = snap.docs.map((d) => d.id)
    expect(ids).toContain('inst-pool-foh')
    // BOH is excluded by the query's own filter, not a per-document rule check.
    expect(ids).not.toContain('inst-pool-boh')
  })

  it('DENIES a tasks.complete holder who omits the department where() clause entirely — the fix does not depend on client cooperation', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'taskInstances/inst-pool-foh'), taskInstancePayload({ department: 'FOH' }))
    })
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      getDocs(query(collection(staff, 'taskInstances'), where('assigneeEmployeeId', '==', null))),
    )
  })

  it("DENIES a tasks.complete-only holder from a DIFFERENT department who pads the department where() clause to someone else's department", async () => {
    // emp-staff-boh's real department is BOH (resolved server-side from
    // their own employee record via myDepartment(), never from the
    // client's claim). A query pinned to where('department', '==', 'FOH')
    // is correctly SHAPED (has the where() clause at all) but pinned to a
    // department that isn't theirs — myDepartment() == 'FOH' is false for
    // this caller on every possible match, so the whole list is denied.
    // This is the exact "smuggle a peer's data by widening/padding the
    // filter" shape as tipReports' padded 'in' array test.
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'taskInstances/inst-pool-foh'), taskInstancePayload({ department: 'FOH' }))
    })
    const boh = ctx('uid-emp-staff-boh', 'emp-staff-boh', 'staff')
    await assertFails(
      getDocs(
        query(
          collection(boh, 'taskInstances'),
          where('assigneeEmployeeId', '==', null),
          where('department', '==', 'FOH'),
          where('status', '==', 'open'),
        ),
      ),
    )
  })

  it('DENIES a tasks.complete-only holder reading a single cross-department pool instance directly via getDoc', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'taskInstances/inst-pool-foh'), taskInstancePayload({ department: 'FOH' }))
    })
    const boh = ctx('uid-emp-staff-boh', 'emp-staff-boh', 'staff')
    await assertFails(getDoc(doc(boh, 'taskInstances/inst-pool-foh')))
  })
})

// ── taskInstances — read, tasks.manage cross-department ──────────────────────

describe('taskInstances — read, tasks.manage cross-department (admin Completion dashboard, spec §10)', () => {
  it('lets a tasks.manage holder read a single pool instance in a DIFFERENT department via getDoc', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'taskInstances/inst-pool-boh'), taskInstancePayload({ department: 'BOH' }))
    })
    // emp-mgr-foh is FOH; the instance is BOH.
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(getDoc(doc(mgr, 'taskInstances/inst-pool-boh')))
  })

  it('lets a tasks.manage holder list pool instances across every department via an UNFILTERED query — hasPerm() alone is provable, no department where() needed', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      const db = admin.firestore()
      await setDoc(doc(db, 'taskInstances/inst-pool-foh'), taskInstancePayload({ department: 'FOH' }))
      await setDoc(doc(db, 'taskInstances/inst-pool-boh'), taskInstancePayload({ department: 'BOH' }))
    })
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    const snap = await assertSucceeds(getDocs(collection(mgr, 'taskInstances')))
    expect(snap.docs.map((d) => d.id)).toEqual(
      expect.arrayContaining(['inst-pool-foh', 'inst-pool-boh']),
    )
  })

  it('lets a tasks.manage holder list pool instances filtered to ANOTHER department they do not belong to — the query filter is optional, not load-bearing, for this role', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'taskInstances/inst-pool-boh'), taskInstancePayload({ department: 'BOH' }))
    })
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    const snap = await assertSucceeds(
      getDocs(query(collection(mgr, 'taskInstances'), where('department', '==', 'BOH'))),
    )
    expect(snap.docs.map((d) => d.id)).toEqual(['inst-pool-boh'])
  })
})
