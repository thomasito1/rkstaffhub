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
 * Punches, tipReports, trades — spec §7, §8, §9, §17, enforced SERVER-SIDE.
 *
 * Punches and tipReports have almost no client-writable surface at all: every
 * mutation goes through a Cloud Function (recordPunch/editPunch/editTipReport)
 * because each one needs either a server timestamp (§8) or an editHistory
 * entry plus an auditLog write (§17) — this file's job is proving that
 * writing them AS A CLIENT is denied unconditionally, on every role, and that
 * reads stay correctly scoped.
 *
 * Trades DO have a client-writable slice (post + cancel-your-own-open-post),
 * because nothing irreversible happens until a manager approves — that half
 * gets real positive+negative coverage; the Cloud-Function-only transitions
 * (claim/accept/approve) just need proving a bare client update can't reach
 * them either.
 *
 * Requires the Firestore emulator. Run via: npm run test:rules:emulated
 */

const PROJECT_ID = 'demo-rk-staffhub'
let testEnv: RulesTestEnvironment

function ctx(uid: string, employeeId: string, role: string) {
  return testEnv.authenticatedContext(uid, { employeeId, role }).firestore()
}

const WEEK_ID = '2026-08-10'
const SHIFT_ID = 'shift-server-foh'

function punchPayload(employeeId: string, over: Record<string, unknown> = {}) {
  return {
    employeeId,
    shiftId: null,
    type: 'in',
    timestamp: new Date('2026-08-10T15:30:00Z'),
    deviceTimestamp: new Date('2026-08-10T15:30:00Z'),
    geo: { lat: 25.9865, lng: -80.3389, accuracy: 12, insideFence: true },
    selfieStoragePath: `punch-selfies/${employeeId}/2026-08/p1.jpg`,
    manualBy: null,
    manualReason: null,
    flagged: false,
    flagReason: null,
    editedBy: null,
    editHistory: [],
    // Denormalized at creation time (Aug 14 2026 fix) so the department
    // read-scope check needs no cross-document get() — see firestore.rules'
    // punchDepartment() doc comment. Default matches emp-staff-foh's own.
    department: 'FOH',
    locationId: null,
    ...over,
  }
}

function tipReportPayload(employeeId: string, over: Record<string, unknown> = {}) {
  return {
    employeeId,
    date: '2026-08-10',
    shiftId: null,
    amount: 88,
    reportedAt: new Date('2026-08-10T22:05:00Z'),
    editedBy: null,
    editHistory: [],
    // Denormalized at creation time (Aug 14 2026 fix) — see firestore.rules'
    // tipReportEmployeeRole() doc comment. Default matches emp-staff-foh's own.
    employeeAccessRole: 'staff',
    locationId: null,
    ...over,
  }
}

function directTradePayload(over: Record<string, unknown> = {}) {
  return {
    type: 'direct',
    shiftId: SHIFT_ID,
    weekId: WEEK_ID,
    fromEmployeeId: 'emp-staff-foh',
    postedBy: 'emp-staff-foh',
    toEmployeeId: 'emp-staff-foh2',
    claimedBy: null,
    status: 'open',
    approvedBy: null,
    declineReason: null,
    department: 'FOH',
    eligibilitySnapshot: { roleId: 'server', requiredSkillLevel: 1 },
    message: null,
    expiresAt: new Date('2026-08-12T22:05:00Z'),
    locationId: null,
    ...over,
  }
}

function poolTradePayload(over: Record<string, unknown> = {}) {
  return {
    type: 'pool',
    shiftId: SHIFT_ID,
    weekId: WEEK_ID,
    fromEmployeeId: 'emp-staff-foh',
    postedBy: 'emp-staff-foh',
    toEmployeeId: null,
    claimedBy: null,
    status: 'open',
    approvedBy: null,
    declineReason: null,
    department: 'FOH',
    eligibilitySnapshot: { roleId: 'server', requiredSkillLevel: 1 },
    message: null,
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

    const people: Array<[string, string, string]> = [
      ['emp-owner', 'owner', 'Admin'],
      ['emp-mgr-foh', 'manager', 'FOH'],
      ['emp-mgr-boh', 'manager', 'BOH'],
      ['emp-mgr-foh2', 'manager', 'FOH'],
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

    await setDoc(doc(db, `schedules/${WEEK_ID}`), {
      weekId: WEEK_ID,
      status: 'published',
      publishedAt: new Date('2026-08-07T23:59:00Z'),
      publishedBy: 'emp-mgr-foh',
      laborTargetPct: 42,
      aiDraftMeta: null,
    })
    await setDoc(doc(db, `schedules/${WEEK_ID}/shifts/${SHIFT_ID}`), {
      employeeId: 'emp-staff-foh',
      date: '2026-08-10',
      startTime: '16:00',
      endTime: '22:00',
      roleId: 'server',
      requiredSkillLevel: 1,
      department: 'FOH',
      station: 'Floor',
      notes: null,
      isOnCall: false,
      status: 'published',
      locationId: null,
    })

    await setDoc(doc(db, 'punches/punch-foh'), punchPayload('emp-staff-foh'))
    await setDoc(doc(db, 'tipReports/tip-foh'), tipReportPayload('emp-staff-foh'))
  })
})

// ── punches ──────────────────────────────────────────────────────────────────

describe('punches — every write is Cloud-Function-only (spec §8, §17)', () => {
  it('lets the employee read their own punch', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(getDoc(doc(staff, 'punches/punch-foh')))
  })

  it("denies a same-department PEER reading another employee's punch (no punches.viewAll)", async () => {
    const peer = ctx('uid-emp-staff-foh2', 'emp-staff-foh2', 'staff')
    await assertFails(getDoc(doc(peer, 'punches/punch-foh')))
  })

  it('lets a same-department manager with punches.viewAll read it', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(getDoc(doc(mgr, 'punches/punch-foh')))
  })

  it('DENIES a cross-department manager, even with punches.viewAll', async () => {
    const mgr = ctx('uid-emp-mgr-boh', 'emp-mgr-boh', 'manager')
    await assertFails(getDoc(doc(mgr, 'punches/punch-foh')))
  })

  it('denies the employee creating their OWN punch directly (must go through recordPunch)', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      setDoc(doc(staff, 'punches/punch-direct'), punchPayload('emp-staff-foh')),
    )
  })

  it('denies a manager editing a punch directly (must go through editPunch)', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(
      updateDoc(doc(mgr, 'punches/punch-foh'), { flagged: true }),
    )
  })

  it('denies deleting a punch under any role', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(deleteDoc(doc(owner, 'punches/punch-foh')))
  })
})

describe('punches — LIST queries (Shifts & Tips admin, Aug 14 2026 regression coverage)', () => {
  // A single-document getDoc() proving a rule "looks right" does NOT prove a
  // real getDocs() QUERY works. Firestore evaluates a `list` against the
  // query's POTENTIAL result set — using only the query's own where()-pinned
  // values and the caller's claims, never real per-document data — and
  // denies the WHOLE request if it can't prove every possible match is
  // allowed ("security rules are not filters"). A department comparison
  // against `resource.data.department` is only provable when the query
  // itself pins `department` via where(), which is why these mirror
  // `src/lib/db/punches.ts`'s actual query shape instead of a bare
  // `collection()` read — an unfiltered admin-shaped query denies outright
  // for anyone but Owner/GM, get()-free rule or not.
  it('lets a same-department manager list punches with punches.viewAll via a real query scoped by their own department', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      const db = admin.firestore()
      await setDoc(doc(db, 'punches/punch-boh'), punchPayload('emp-staff-boh', { department: 'BOH' }))
    })
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    const snap = await assertSucceeds(
      getDocs(query(collection(mgr, 'punches'), where('department', '==', 'FOH'))),
    )
    const ids = snap.docs.map((d) => d.id)
    expect(ids).toContain('punch-foh')
    // BOH is excluded by the query's own filter, not a per-document rule check.
    expect(ids).not.toContain('punch-boh')
  })

  it('lets the owner list punches across every department via an unfiltered query — ownerOrGm() is caller-only, so no department where() is needed', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      const db = admin.firestore()
      await setDoc(doc(db, 'punches/punch-boh'), punchPayload('emp-staff-boh', { department: 'BOH' }))
    })
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    const snap = await assertSucceeds(getDocs(collection(owner, 'punches')))
    expect(snap.docs.map((d) => d.id)).toEqual(expect.arrayContaining(['punch-foh', 'punch-boh']))
  })

  it('DENIES a manager without punches.viewAll even with the same department filter — isSelf() is still unconstrained by the query, so Firestore can only deny outright, not return empty', async () => {
    // Supervisor's role defaults grant schedule.view etc. but not
    // punches.viewAll (spec §4). The department filter alone can't save this
    // query: with hasPerm('punches.viewAll') statically false, the rule
    // collapses to isSelf(subjectEmployeeId()), which still isn't pinned by
    // any where() clause — some other FOH employee's punch would fail it —
    // so Firestore denies the whole list. This is correct and secure: the
    // app never issues this query for a caller lacking the permission in
    // the first place (ShiftsAndTipsPage gates the whole screen on it).
    const supervisor = ctx('uid-emp-staff-foh2', 'emp-staff-foh2', 'supervisor')
    await assertFails(
      getDocs(query(collection(supervisor, 'punches'), where('department', '==', 'FOH'))),
    )
  })
})

// ── tipReports ───────────────────────────────────────────────────────────────

describe('tipReports — below-level scoped, every write Cloud-Function-only (spec §4, §8, §17)', () => {
  it('lets the employee read their own tip report', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(getDoc(doc(staff, 'tipReports/tip-foh')))
  })

  it('denies a same-department PEER reading it (tips of others are below-level sensitive, spec §4)', async () => {
    const peer = ctx('uid-emp-staff-foh2', 'emp-staff-foh2', 'staff')
    await assertFails(getDoc(doc(peer, 'tipReports/tip-foh')))
  })

  it('lets a strictly-higher-rank manager with tips.viewAll read it', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(getDoc(doc(mgr, 'tipReports/tip-foh')))
  })

  it("DENIES an EQUAL-RANK manager reading another manager's tip report", async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      const db = admin.firestore()
      await setDoc(
        doc(db, 'tipReports/tip-mgr'),
        tipReportPayload('emp-mgr-foh2', { employeeAccessRole: 'manager' }),
      )
    })
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(getDoc(doc(mgr, 'tipReports/tip-mgr')))
  })

  it("DENIES an EQUAL-RANK manager even when the record predates employeeAccessRole (fails closed to 'owner')", async () => {
    // A record missing the denormalized field must never read as MORE
    // permissive than one that has it — tipReportEmployeeRole()'s fallback
    // is 'owner', the highest rank, so an equal-rank manager is still denied.
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      const db = admin.firestore()
      const { employeeAccessRole: _drop, ...withoutRole } = tipReportPayload('emp-mgr-foh2')
      await setDoc(doc(db, 'tipReports/tip-mgr-legacy'), withoutRole)
    })
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(getDoc(doc(mgr, 'tipReports/tip-mgr-legacy')))
  })

  it('denies the employee submitting their own tip report directly (must go through recordPunch)', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      setDoc(doc(staff, 'tipReports/tip-direct'), tipReportPayload('emp-staff-foh')),
    )
  })

  it('denies a manager editing a tip amount directly (must go through editTipReport)', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(updateDoc(doc(mgr, 'tipReports/tip-foh'), { amount: 0 }))
  })
})

describe('tipReports — LIST queries (Shifts & Tips admin, Aug 14 2026 regression coverage)', () => {
  // Same rationale as punches' matching block. A RANK COMPARISON
  // (rank(myRole()) > rank(tipReportEmployeeRole())) can never be proven
  // for a list, even get()-free, because its truth still varies per
  // document and no where() pins it. mayViewTipReport() is a MEMBERSHIP
  // check instead (viewableTipRoles()), which the query mirrors exactly via
  // where('employeeAccessRole', 'in', ...) — see src/lib/db/tipReports.ts.
  it('lets a strictly-higher-rank manager list tip reports with tips.viewAll via a real query scoped to roles below their own', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      const db = admin.firestore()
      await setDoc(
        doc(db, 'tipReports/tip-mgr-peer'),
        tipReportPayload('emp-mgr-foh2', { employeeAccessRole: 'manager' }),
      )
    })
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    const snap = await assertSucceeds(
      getDocs(
        query(
          collection(mgr, 'tipReports'),
          where('date', '==', '2026-08-10'),
          where('employeeAccessRole', 'in', ['supervisor', 'staff']),
        ),
      ),
    )
    const ids = snap.docs.map((d) => d.id)
    expect(ids).toContain('tip-foh')
    // Equal rank (manager reading another manager) is excluded by the
    // query's own 'in' filter, not a per-document rule check.
    expect(ids).not.toContain('tip-mgr-peer')
  })

  it("lets the owner list every tip report via the same query shape, including a manager peer's — owner's viewableTipRoles includes every role", async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      const db = admin.firestore()
      await setDoc(
        doc(db, 'tipReports/tip-mgr-peer'),
        tipReportPayload('emp-mgr-foh2', { employeeAccessRole: 'manager' }),
      )
    })
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    const snap = await assertSucceeds(
      getDocs(
        query(
          collection(owner, 'tipReports'),
          where('date', '==', '2026-08-10'),
          where('employeeAccessRole', 'in', ['owner', 'gm', 'manager', 'supervisor', 'staff']),
        ),
      ),
    )
    expect(snap.docs.map((d) => d.id)).toEqual(expect.arrayContaining(['tip-foh', 'tip-mgr-peer']))
  })

  it('DENIES a staff member without tips.viewAll attempting the unscoped admin query shape', async () => {
    // viewableTipRoles('staff') is [] — the real listTipReportsInRange
    // short-circuits locally and never queries Firestore at all for this
    // caller (an empty 'in' array is an invalid query anyway). This proves
    // the defense-in-depth case: if a client attempted the admin query's
    // shape without a role filter regardless, Firestore denies the whole
    // request rather than filtering it down to empty — isSelf() is still
    // unconstrained by the query, and some other employee's tip report
    // would fail it.
    const peer = ctx('uid-emp-staff-foh2', 'emp-staff-foh2', 'staff')
    await assertFails(
      getDocs(query(collection(peer, 'tipReports'), where('date', '==', '2026-08-10'))),
    )
  })
})

// ── trades ───────────────────────────────────────────────────────────────────

describe('trades — post/cancel are client writes; claim/accept/approve are not (spec §7, §17)', () => {
  it('lets an employee post a DIRECT offer on their own shift', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(
      setDoc(doc(staff, 'trades/trade-direct'), directTradePayload()),
    )
  })

  it('lets an employee drop their own shift to the POOL', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(
      setDoc(doc(staff, 'trades/trade-pool'), poolTradePayload()),
    )
  })

  it("DENIES posting a trade on someone ELSE's shift", async () => {
    const otherStaff = ctx('uid-emp-staff-foh2', 'emp-staff-foh2', 'staff')
    await assertFails(
      setDoc(doc(otherStaff, 'trades/trade-steal'), directTradePayload()),
    )
  })

  it('DENIES a department/eligibilitySnapshot mismatch against the real shift', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      setDoc(
        doc(staff, 'trades/trade-lie'),
        poolTradePayload({ department: 'BOH' }),
      ),
    )
  })

  it('DENIES a plain staff member posting a manager-style open-shift drop (needs trades.manualAssign)', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      setDoc(
        doc(staff, 'trades/trade-mgr-style'),
        poolTradePayload({ fromEmployeeId: null, postedBy: 'emp-staff-foh' }),
      ),
    )
  })

  it('lets a manager with trades.manualAssign post an already-open shift to the pool', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(
      setDoc(
        doc(mgr, 'trades/trade-mgr-post'),
        poolTradePayload({ fromEmployeeId: null, postedBy: 'emp-mgr-foh' }),
      ),
    )
  })

  it('lets a same-department non-party read an OPEN pool trade', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'trades/trade-pool'), poolTradePayload())
    })
    const peer = ctx('uid-emp-staff-foh2', 'emp-staff-foh2', 'staff')
    await assertSucceeds(getDoc(doc(peer, 'trades/trade-pool')))
  })

  it('DENIES a same-department non-party reading an OPEN DIRECT offer addressed to someone else', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(
        doc(admin.firestore(), 'trades/trade-direct-other'),
        directTradePayload({ toEmployeeId: 'emp-staff-boh' }),
      )
    })
    // emp-staff-foh2 is FOH, same department as the trade, but is neither party.
    const peer = ctx('uid-emp-staff-foh2', 'emp-staff-foh2', 'staff')
    await assertFails(getDoc(doc(peer, 'trades/trade-direct-other')))
  })

  it('DENIES a cross-department employee reading an open pool trade', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'trades/trade-pool'), poolTradePayload())
    })
    const boh = ctx('uid-emp-staff-boh', 'emp-staff-boh', 'staff')
    await assertFails(getDoc(doc(boh, 'trades/trade-pool')))
  })

  it('lets the poster cancel their own still-open trade', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'trades/trade-cancel'), poolTradePayload())
    })
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(
      updateDoc(doc(staff, 'trades/trade-cancel'), {
        ...poolTradePayload({ status: 'cancelled' }),
      }),
    )
  })

  it("DENIES someone else cancelling a trade that isn't theirs", async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'trades/trade-cancel'), poolTradePayload())
    })
    const other = ctx('uid-emp-staff-foh2', 'emp-staff-foh2', 'staff')
    await assertFails(
      updateDoc(doc(other, 'trades/trade-cancel'), {
        ...poolTradePayload({ status: 'cancelled' }),
      }),
    )
  })

  it('DENIES a cancel that also sneaks in a claimedBy change', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'trades/trade-cancel'), poolTradePayload())
    })
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      updateDoc(doc(staff, 'trades/trade-cancel'), {
        ...poolTradePayload({ status: 'cancelled', claimedBy: 'emp-staff-foh2' }),
      }),
    )
  })

  it('DENIES a plain client update trying to approve a trade directly (must go through the Cloud Function)', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'trades/trade-approve'), poolTradePayload())
    })
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(
      updateDoc(doc(mgr, 'trades/trade-approve'), {
        ...poolTradePayload({ status: 'approved', claimedBy: 'emp-staff-foh2', approvedBy: 'emp-mgr-foh' }),
      }),
    )
  })

  it('denies deleting a trade under any role', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'trades/trade-del'), poolTradePayload())
    })
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(deleteDoc(doc(owner, 'trades/trade-del')))
  })
})
