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
      await setDoc(doc(db, 'tipReports/tip-mgr'), tipReportPayload('emp-mgr-foh2'))
    })
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(getDoc(doc(mgr, 'tipReports/tip-mgr')))
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
