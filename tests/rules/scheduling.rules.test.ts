import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest'

import { ROLE_DEFAULTS } from '../../src/lib/permissions/defaults'

/**
 * Scheduling rules — availability, schedules + shifts, shiftTemplates, timeOff.
 * Spec §5, §6, §17, enforced SERVER-SIDE.
 *
 * The failure this file exists to prevent is a DRAFT SCHEDULE REACHING STAFF.
 * Staff hold `schedule.view` by default, so the permission key alone proves
 * nothing; the week's own status is the gate, and the negative tests below
 * pin it from both directions (staff denied on a draft, allowed on a published
 * week for their department).
 *
 * Requires the Firestore emulator. Run via:  npm run test:rules:emulated
 */

const PROJECT_ID = 'demo-rk-staffhub'
let testEnv: RulesTestEnvironment

/** Authenticated context carrying the custom claims a real session would have. */
function ctx(uid: string, employeeId: string, role: string) {
  return testEnv.authenticatedContext(uid, { employeeId, role }).firestore()
}

const PUBLISHED_WEEK = '2026-08-10'
const DRAFT_WEEK = '2026-08-17'

/** A complete availability payload — the shape submitAvailability() writes. */
function availabilityPayload(employeeId: string, weekId: string, type: string) {
  return {
    employeeId,
    weekId,
    type,
    days: {
      mon: { status: 'available', from: null, to: null },
      tue: { status: 'available', from: null, to: null },
      wed: { status: 'unavailable', from: null, to: null },
      thu: { status: 'available', from: null, to: null },
      fri: { status: 'available', from: null, to: null },
      sat: { status: 'partial', from: '11:00', to: '23:00' },
      sun: { status: 'available', from: null, to: null },
    },
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    declineReason: null,
    locationId: null,
  }
}

function timeOffPayload(employeeId: string) {
  return {
    employeeId,
    startDate: '2026-08-24',
    endDate: '2026-08-26',
    category: 'unpaid',
    reason: 'Family trip',
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    conflicts: [],
    declineReason: null,
    locationId: null,
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
      ['emp-gm', 'gm', 'Admin'],
      ['emp-mgr-foh', 'manager', 'FOH'],
      ['emp-mgr-boh', 'manager', 'BOH'],
      // A manager who may build a schedule but not publish one — proves the
      // publish gate is a distinct key rather than a side effect of edit.
      ['emp-mgr-nopub', 'manager', 'FOH'],
      ['emp-sup', 'supervisor', 'FOH'],
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
        employmentType: 'hourly',
        clockRequired: true,
        tipsRequired: false,
        language: 'en',
        shiftRoles: [],
        authUids: [`uid-${id}`],
        hireDate: '2025-01-01',
      })
      await setDoc(doc(db, `employees/${id}/private/admin`), {
        schedulingNotes: 'private note',
        permissionOverrides:
          id === 'emp-mgr-nopub' ? { 'schedule.publish': false } : {},
      })
    }

    // Availability: one recurring baseline per staff member, plus a temporary
    // override for the published week.
    await setDoc(
      doc(db, 'availability/recurring_emp-staff-foh'),
      availabilityPayload('emp-staff-foh', 'recurring', 'recurring'),
    )
    await setDoc(
      doc(db, `availability/${PUBLISHED_WEEK}_emp-staff-foh`),
      availabilityPayload('emp-staff-foh', PUBLISHED_WEEK, 'temporary'),
    )
    await setDoc(
      doc(db, 'availability/recurring_emp-staff-foh2'),
      availabilityPayload('emp-staff-foh2', 'recurring', 'recurring'),
    )
    await setDoc(
      doc(db, 'availability/recurring_emp-staff-boh'),
      availabilityPayload('emp-staff-boh', 'recurring', 'recurring'),
    )

    // One published week and one draft week.
    await setDoc(doc(db, `schedules/${PUBLISHED_WEEK}`), {
      weekId: PUBLISHED_WEEK,
      status: 'published',
      publishedAt: new Date('2026-08-07T23:59:00Z'),
      publishedBy: 'emp-mgr-foh',
      laborTargetPct: 42,
      aiDraftMeta: null,
    })
    await setDoc(doc(db, `schedules/${DRAFT_WEEK}`), {
      weekId: DRAFT_WEEK,
      status: 'draft',
      publishedAt: null,
      publishedBy: null,
      laborTargetPct: 42,
      aiDraftMeta: null,
    })

    const shift = (over: Record<string, unknown>) => ({
      employeeId: null,
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
      ...over,
    })

    // Published week: a live FOH shift, a live BOH shift, and a shift added
    // after the publish that is still sitting at draft.
    await setDoc(
      doc(db, `schedules/${PUBLISHED_WEEK}/shifts/shift-foh`),
      shift({ employeeId: 'emp-staff-foh' }),
    )
    await setDoc(
      doc(db, `schedules/${PUBLISHED_WEEK}/shifts/shift-boh`),
      shift({ employeeId: 'emp-staff-boh', department: 'BOH', roleId: 'prep-cook' }),
    )
    await setDoc(
      doc(db, `schedules/${PUBLISHED_WEEK}/shifts/shift-unpublished`),
      shift({ employeeId: 'emp-staff-foh', status: 'draft' }),
    )
    // Draft week: even a shift marked published must not leak, because its
    // week has never gone out.
    await setDoc(
      doc(db, `schedules/${DRAFT_WEEK}/shifts/shift-draftweek`),
      shift({ employeeId: 'emp-staff-foh', date: '2026-08-17' }),
    )

    await setDoc(doc(db, 'shiftTemplates/mon-dinner'), {
      name: 'Mon Dinner',
      dayOfWeek: 'mon',
      startTime: '16:00',
      endTime: '23:00',
      requirements: [{ roleId: 'server', count: 2, minSkillLevel: 1 }],
      locationId: null,
    })

    await setDoc(doc(db, 'timeOff/req-foh'), timeOffPayload('emp-staff-foh'))
    await setDoc(doc(db, 'timeOff/req-boh'), timeOffPayload('emp-staff-boh'))
  })
})

// ── availability ─────────────────────────────────────────────────────────────

describe('availability — staff write only their OWN (spec §5)', () => {
  it('lets a staff member submit their own recurring baseline', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(
      setDoc(
        doc(staff, 'availability/recurring_emp-staff-foh'),
        availabilityPayload('emp-staff-foh', 'recurring', 'recurring'),
      ),
    )
  })

  it('lets a staff member submit their own week-specific override', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(
      setDoc(
        doc(staff, `availability/${PUBLISHED_WEEK}_emp-staff-foh`),
        availabilityPayload('emp-staff-foh', PUBLISHED_WEEK, 'temporary'),
      ),
    )
  })

  it("DENIES a staff member writing someone ELSE's availability", async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      setDoc(
        doc(staff, 'availability/recurring_emp-staff-foh2'),
        availabilityPayload('emp-staff-foh2', 'recurring', 'recurring'),
      ),
    )
  })

  it("DENIES parking your own submission under a colleague's document id", async () => {
    // Payload says "me", document key says "them". The id/payload agreement
    // check is what stops this from polluting the colleague's slot.
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      setDoc(
        doc(staff, 'availability/recurring_emp-staff-foh2'),
        availabilityPayload('emp-staff-foh', 'recurring', 'recurring'),
      ),
    )
  })

  it('DENIES a staff member approving their own submission', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      updateDoc(doc(staff, 'availability/recurring_emp-staff-foh'), {
        status: 'approved',
        reviewedBy: 'emp-staff-foh',
      }),
    )
  })

  it('lets a staff member withdraw their own temporary override', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(
      deleteDoc(doc(staff, `availability/${PUBLISHED_WEEK}_emp-staff-foh`)),
    )
  })

  it("DENIES a staff member deleting a colleague's availability", async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(deleteDoc(doc(staff, 'availability/recurring_emp-staff-foh2')))
  })
})

describe('availability — reads', () => {
  it('lets a staff member read their own', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(getDoc(doc(staff, 'availability/recurring_emp-staff-foh')))
  })

  it("DENIES a staff member reading a colleague's", async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(getDoc(doc(staff, 'availability/recurring_emp-staff-foh2')))
  })

  it('lets a supervisor read anyone (availability.viewAll)', async () => {
    const sup = ctx('uid-emp-sup', 'emp-sup', 'supervisor')
    await assertSucceeds(getDoc(doc(sup, 'availability/recurring_emp-staff-foh')))
  })
})

describe('availability — approval is permission + department (spec §5)', () => {
  it('lets an FOH manager approve an FOH submission', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(
      updateDoc(doc(mgr, 'availability/recurring_emp-staff-foh'), {
        status: 'approved',
        reviewedBy: 'emp-mgr-foh',
      }),
    )
  })

  it('DENIES an FOH manager approving a BOH submission', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(
      updateDoc(doc(mgr, 'availability/recurring_emp-staff-boh'), {
        status: 'approved',
        reviewedBy: 'emp-mgr-foh',
      }),
    )
  })

  it('DENIES a supervisor approving (no availability.approve)', async () => {
    const sup = ctx('uid-emp-sup', 'emp-sup', 'supervisor')
    await assertFails(
      updateDoc(doc(sup, 'availability/recurring_emp-staff-foh'), {
        status: 'approved',
        reviewedBy: 'emp-sup',
      }),
    )
  })

  it('lets a manager submit on behalf of their own staff (the §5 late path)', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(
      setDoc(
        doc(mgr, `availability/${PUBLISHED_WEEK}_emp-staff-foh`),
        availabilityPayload('emp-staff-foh', PUBLISHED_WEEK, 'temporary'),
      ),
    )
  })
})

describe('availability — owner/GM bypass department scoping', () => {
  it('lets the GM approve across departments', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertSucceeds(
      updateDoc(doc(gm, 'availability/recurring_emp-staff-boh'), {
        status: 'approved',
        reviewedBy: 'emp-gm',
      }),
    )
  })

  it('lets the owner approve across departments', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertSucceeds(
      updateDoc(doc(owner, 'availability/recurring_emp-staff-boh'), {
        status: 'approved',
        reviewedBy: 'emp-owner',
      }),
    )
  })
})

// ── schedules ────────────────────────────────────────────────────────────────

describe('schedules — a DRAFT MUST NEVER REACH STAFF (spec §17)', () => {
  it('lets a staff member read the PUBLISHED week', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(getDoc(doc(staff, `schedules/${PUBLISHED_WEEK}`)))
  })

  it('DENIES a staff member reading a DRAFT week', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(getDoc(doc(staff, `schedules/${DRAFT_WEEK}`)))
  })

  it('DENIES a supervisor reading a DRAFT week — schedule.view is not enough', async () => {
    const sup = ctx('uid-emp-sup', 'emp-sup', 'supervisor')
    await assertFails(getDoc(doc(sup, `schedules/${DRAFT_WEEK}`)))
  })

  it('lets a manager read a DRAFT week — they are the ones building it', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(getDoc(doc(mgr, `schedules/${DRAFT_WEEK}`)))
  })

  it('denies an unauthenticated read of a published week', async () => {
    const anon = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(doc(anon, `schedules/${PUBLISHED_WEEK}`)))
  })
})

describe('schedules — publishing is its own permission (spec §6)', () => {
  it('DENIES a supervisor publishing', async () => {
    const sup = ctx('uid-emp-sup', 'emp-sup', 'supervisor')
    await assertFails(
      updateDoc(doc(sup, `schedules/${DRAFT_WEEK}`), { status: 'published' }),
    )
  })

  it('DENIES a staff member publishing', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      updateDoc(doc(staff, `schedules/${DRAFT_WEEK}`), { status: 'published' }),
    )
  })

  it('lets a manager publish', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(
      updateDoc(doc(mgr, `schedules/${DRAFT_WEEK}`), { status: 'published' }),
    )
  })

  it('DENIES publishing to an editor whose schedule.publish is overridden off', async () => {
    const mgr = ctx('uid-emp-mgr-nopub', 'emp-mgr-nopub', 'manager')
    await assertFails(
      updateDoc(doc(mgr, `schedules/${DRAFT_WEEK}`), { status: 'published' }),
    )
  })

  it('still lets that editor change a non-publish field', async () => {
    const mgr = ctx('uid-emp-mgr-nopub', 'emp-mgr-nopub', 'manager')
    await assertSucceeds(
      updateDoc(doc(mgr, `schedules/${DRAFT_WEEK}`), { laborTargetPct: 38 }),
    )
  })

  it('DENIES that editor pulling a published week back to draft', async () => {
    const mgr = ctx('uid-emp-mgr-nopub', 'emp-mgr-nopub', 'manager')
    await assertFails(
      updateDoc(doc(mgr, `schedules/${PUBLISHED_WEEK}`), { status: 'draft' }),
    )
  })

  it('denies deleting a week outright', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(deleteDoc(doc(owner, `schedules/${PUBLISHED_WEEK}`)))
  })
})

// ── shifts ───────────────────────────────────────────────────────────────────

describe('shifts — published, in your department, in a published week', () => {
  it('lets a staff member read a published shift in their own department', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(
      getDoc(doc(staff, `schedules/${PUBLISHED_WEEK}/shifts/shift-foh`)),
    )
  })

  it('DENIES a staff member reading another department shift', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      getDoc(doc(staff, `schedules/${PUBLISHED_WEEK}/shifts/shift-boh`)),
    )
  })

  it('DENIES a staff member reading a shift added since the last publish', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      getDoc(doc(staff, `schedules/${PUBLISHED_WEEK}/shifts/shift-unpublished`)),
    )
  })

  it('DENIES a staff member reading their own shift inside a DRAFT week', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      getDoc(doc(staff, `schedules/${DRAFT_WEEK}/shifts/shift-draftweek`)),
    )
  })

  it('lets a manager read any shift, draft week included', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(
      getDoc(doc(mgr, `schedules/${DRAFT_WEEK}/shifts/shift-draftweek`)),
    )
  })

  it('DENIES a staff member creating a shift', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      setDoc(doc(staff, `schedules/${DRAFT_WEEK}/shifts/shift-new`), {
        employeeId: 'emp-staff-foh',
        date: '2026-08-17',
        startTime: '16:00',
        endTime: '22:00',
        roleId: 'server',
        requiredSkillLevel: 1,
        department: 'FOH',
        status: 'draft',
      }),
    )
  })

  it('DENIES a supervisor creating a shift', async () => {
    const sup = ctx('uid-emp-sup', 'emp-sup', 'supervisor')
    await assertFails(
      updateDoc(doc(sup, `schedules/${DRAFT_WEEK}/shifts/shift-draftweek`), {
        station: 'Patio',
      }),
    )
  })

  it('lets a manager edit a shift', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(
      updateDoc(doc(mgr, `schedules/${DRAFT_WEEK}/shifts/shift-draftweek`), {
        station: 'Patio',
      }),
    )
  })

  it('DENIES flipping a shift live without schedule.publish', async () => {
    const mgr = ctx('uid-emp-mgr-nopub', 'emp-mgr-nopub', 'manager')
    await assertFails(
      updateDoc(doc(mgr, `schedules/${PUBLISHED_WEEK}/shifts/shift-unpublished`), {
        status: 'published',
      }),
    )
  })

  it('lets a full manager flip a shift live', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(
      updateDoc(doc(mgr, `schedules/${PUBLISHED_WEEK}/shifts/shift-unpublished`), {
        status: 'published',
      }),
    )
  })
})

// ── shiftTemplates ───────────────────────────────────────────────────────────

describe('shiftTemplates', () => {
  it('lets any signed-in employee read a template', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(getDoc(doc(staff, 'shiftTemplates/mon-dinner')))
  })

  it('DENIES a staff member writing a template', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      updateDoc(doc(staff, 'shiftTemplates/mon-dinner'), { startTime: '10:00' }),
    )
  })

  it('DENIES a supervisor writing a template', async () => {
    const sup = ctx('uid-emp-sup', 'emp-sup', 'supervisor')
    await assertFails(
      updateDoc(doc(sup, 'shiftTemplates/mon-dinner'), { startTime: '10:00' }),
    )
  })

  it('lets a manager write a template', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(
      updateDoc(doc(mgr, 'shiftTemplates/mon-dinner'), { startTime: '17:00' }),
    )
  })
})

// ── timeOff ──────────────────────────────────────────────────────────────────

describe('timeOff — request and read your own (spec §6)', () => {
  it('lets a staff member create their own request', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(
      setDoc(doc(staff, 'timeOff/req-new'), timeOffPayload('emp-staff-foh')),
    )
  })

  it("DENIES a staff member creating a request in someone ELSE's name", async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      setDoc(doc(staff, 'timeOff/req-forged'), timeOffPayload('emp-staff-foh2')),
    )
  })

  it('lets a staff member read their own request', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(getDoc(doc(staff, 'timeOff/req-foh')))
  })

  it("DENIES a staff member reading a colleague's request", async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(getDoc(doc(staff, 'timeOff/req-boh')))
  })

  it('lets a staff member edit their own request while it is still pending', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertSucceeds(
      updateDoc(doc(staff, 'timeOff/req-foh'), { reason: 'Family wedding' }),
    )
  })

  it('denies deleting a request — withdrawn is a status, not an erasure', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(deleteDoc(doc(owner, 'timeOff/req-foh')))
  })
})

describe('timeOff — approval is permission + department', () => {
  it('DENIES a staff member APPROVING THEIR OWN request', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      updateDoc(doc(staff, 'timeOff/req-foh'), {
        status: 'approved',
        reviewedBy: 'emp-staff-foh',
      }),
    )
  })

  it('DENIES a supervisor approving (no timeoff.approve)', async () => {
    const sup = ctx('uid-emp-sup', 'emp-sup', 'supervisor')
    await assertFails(
      updateDoc(doc(sup, 'timeOff/req-foh'), {
        status: 'approved',
        reviewedBy: 'emp-sup',
      }),
    )
  })

  it('lets an FOH manager approve an FOH request', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertSucceeds(
      updateDoc(doc(mgr, 'timeOff/req-foh'), {
        status: 'approved',
        reviewedBy: 'emp-mgr-foh',
      }),
    )
  })

  it('DENIES an FOH manager approving time off OUTSIDE their department', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(
      updateDoc(doc(mgr, 'timeOff/req-boh'), {
        status: 'approved',
        reviewedBy: 'emp-mgr-foh',
      }),
    )
  })

  it('lets the BOH manager approve that same BOH request', async () => {
    const mgr = ctx('uid-emp-mgr-boh', 'emp-mgr-boh', 'manager')
    await assertSucceeds(
      updateDoc(doc(mgr, 'timeOff/req-boh'), {
        status: 'approved',
        reviewedBy: 'emp-mgr-boh',
      }),
    )
  })

  it('lets the GM bypass department scoping', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertSucceeds(
      updateDoc(doc(gm, 'timeOff/req-boh'), {
        status: 'approved',
        reviewedBy: 'emp-gm',
      }),
    )
  })

  it('lets the owner bypass department scoping', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertSucceeds(
      updateDoc(doc(owner, 'timeOff/req-boh'), {
        status: 'declined',
        reviewedBy: 'emp-owner',
        declineReason: 'Coverage',
      }),
    )
  })

  it('DENIES the requester reopening an already-approved request', async () => {
    await testEnv.withSecurityRulesDisabled(async (admin) => {
      await setDoc(doc(admin.firestore(), 'timeOff/req-foh'), {
        ...timeOffPayload('emp-staff-foh'),
        status: 'approved',
        reviewedBy: 'emp-mgr-foh',
      })
    })
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(
      updateDoc(doc(staff, 'timeOff/req-foh'), {
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
      }),
    )
  })
})
