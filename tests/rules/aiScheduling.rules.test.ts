import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { readFileSync } from 'node:fs'
import { doc, setDoc, updateDoc, deleteDoc, getDoc } from 'firebase/firestore'
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest'

import { ROLE_DEFAULTS } from '../../src/lib/permissions/defaults'

/**
 * AI Scheduling Assistant — spec §13, Phase 5.
 *
 * Three surfaces, all Cloud-Function-only end to end:
 *
 *   - `settings/aiProviders` — provider metadata (never the key itself).
 *     `allow read: if hasPerm('ai.configureKeys')`, `allow write: if false`.
 *     `ai.configureKeys` defaults to OWNER ONLY (src/lib/permissions/defaults.ts:
 *     `const GM = ALL.filter((k) => k !== 'ai.configureKeys')` — GM is
 *     deliberately excluded, per spec §4's "GM = all except settings.manage-
 *     critical items like ai.configureKeys"). This is independent of
 *     `ai.generateSchedule`, which Manager+ DOES hold by default — proven
 *     explicitly below so the two gates are never accidentally conflated.
 *
 *   - `_devSecrets/{name}` — a brand-new top-level collection with NO explicit
 *     match block, denied only by the catch-all at the bottom of
 *     firestore.rules. The dev/emulator stand-in for Secret Manager
 *     (functions/src/ai/secrets.ts's `FirestoreDevSecretStore`) that holds
 *     raw API key material. Must be unreachable by EVERY client, including
 *     Owner — nothing about the intended design ever grants a client access
 *     to this collection.
 *
 *   - `settings/aiRateLimit` — a sibling document under `settings/` (id
 *     `AI_RATE_LIMIT_ID = 'aiRateLimit'`, functions/src/firebase.ts), also
 *     with no explicit match block, also denied only by the catch-all. A
 *     purely server-side cost-guard counter (functions/src/ai/rateLimit.ts)
 *     — never meant to be visible to any client, including Owner.
 *
 * List-query behavior does not apply here: both `settings/aiProviders` and
 * `settings/aiRateLimit` are looked up by exact document id, never listed —
 * so plain get()-style assertSucceeds/assertFails is the right shape,
 * matching payPeriods.rules.test.ts's own style for its similar
 * single-purpose settings-like document.
 *
 * Requires the Firestore emulator. Run via: npm run test:rules:emulated
 */

const PROJECT_ID = 'demo-rk-staffhub'
let testEnv: RulesTestEnvironment

function ctx(uid: string, employeeId: string, role: string) {
  return testEnv.authenticatedContext(uid, { employeeId, role }).firestore()
}

function aiProvidersPayload(over: Record<string, unknown> = {}) {
  return {
    active: 'anthropic',
    providers: {
      anthropic: {
        provider: 'anthropic',
        model: 'claude-opus-4',
        keyLast4: 'ab12',
        secretRef: 'ai-provider-anthropic',
        connected: true,
        configuredBy: 'emp-owner',
      },
    },
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

    // Role defaults: only 'owner' holds ai.configureKeys — GM is deliberately
    // excluded (src/lib/permissions/defaults.ts), same bar spec §4 sets for
    // settings.manage-critical items. Manager (and GM, and owner) DOES hold
    // ai.generateSchedule by default — seeded here specifically to prove that
    // permission is independent of ai.configureKeys.
    const people: Array<[string, string, string]> = [
      ['emp-owner', 'owner', 'Admin'],
      ['emp-gm', 'gm', 'Admin'],
      ['emp-mgr-foh', 'manager', 'FOH'],
      ['emp-sup-foh', 'supervisor', 'FOH'],
      ['emp-staff-foh', 'staff', 'FOH'],
      // A manager with a PER-PERSON override granting ai.configureKeys,
      // proving the rule reads effective permission (override ?? roleDefault),
      // not a hardcoded role check — same shape as
      // payPeriods.rules.test.ts's 'emp-mgr-override'.
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
        permissionOverrides: id === 'emp-mgr-override' ? { 'ai.configureKeys': true } : {},
      })
    }

    await setDoc(doc(db, 'settings/aiProviders'), aiProvidersPayload())
    await setDoc(doc(db, '_devSecrets/ai-provider-anthropic'), {
      value: 'sk-ant-totally-real-secret-value',
      updatedAt: new Date(),
    })
    await setDoc(doc(db, 'settings/aiRateLimit'), {
      recentGenerationsAtMs: [Date.now()],
      updatedAt: new Date(),
    })
  })
})

// ── settings/aiProviders — read, ai.configureKeys holder (owner) ────────────

describe('settings/aiProviders — read, ai.configureKeys holder (owner)', () => {
  it('lets an owner read the document', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertSucceeds(getDoc(doc(owner, 'settings/aiProviders')))
  })
})

// ── settings/aiProviders — read, DENIED for every non-holder ────────────────

describe('settings/aiProviders — read, DENIED for every role without ai.configureKeys', () => {
  it('DENIES a GM reading the document — GM holds almost every other permission by default, but NOT this one', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertFails(getDoc(doc(gm, 'settings/aiProviders')))
  })

  it('DENIES a manager reading the document', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(getDoc(doc(mgr, 'settings/aiProviders')))
  })

  it('DENIES a manager who holds ai.generateSchedule (their real default) but not ai.configureKeys — the two permissions are independent gates', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    // Sanity: this manager really does have ai.generateSchedule by default.
    expect(ROLE_DEFAULTS.manager['ai.generateSchedule']).toBe(true)
    expect(ROLE_DEFAULTS.manager['ai.configureKeys']).not.toBe(true)
    await assertFails(getDoc(doc(mgr, 'settings/aiProviders')))
  })

  it('DENIES a supervisor reading the document', async () => {
    const sup = ctx('uid-emp-sup-foh', 'emp-sup-foh', 'supervisor')
    await assertFails(getDoc(doc(sup, 'settings/aiProviders')))
  })

  it('DENIES a plain staff member reading the document', async () => {
    const staff = ctx('uid-emp-staff-foh', 'emp-staff-foh', 'staff')
    await assertFails(getDoc(doc(staff, 'settings/aiProviders')))
  })
})

// ── settings/aiProviders — read, per-person override ────────────────────────

describe('settings/aiProviders — read, effective permission (per-person override), not a hardcoded role check', () => {
  it('lets a manager with an explicit ai.configureKeys override read the document', async () => {
    const mgr = ctx('uid-emp-mgr-override', 'emp-mgr-override', 'manager')
    await assertSucceeds(getDoc(doc(mgr, 'settings/aiProviders')))
  })
})

// ── settings/aiProviders — write lockdown, Cloud-Function-only on every role, including owner ──

describe('settings/aiProviders — every write is Cloud-Function-only, on every role including owner', () => {
  it('denies an owner creating the document directly (configureAiProvider is Admin-SDK-only)', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(setDoc(doc(owner, 'settings/aiProvidersNew'), aiProvidersPayload()))
  })

  it('denies an owner updating the existing document directly (e.g. raw-client setActiveAiProvider attempt)', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(updateDoc(doc(owner, 'settings/aiProviders'), { active: 'openai' }))
  })

  it('denies an owner deleting the existing document directly', async () => {
    const owner = ctx('uid-emp-owner', 'emp-owner', 'owner')
    await assertFails(deleteDoc(doc(owner, 'settings/aiProviders')))
  })

  it('denies a GM creating the document directly', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertFails(setDoc(doc(gm, 'settings/aiProvidersNew'), aiProvidersPayload()))
  })

  it('denies a GM updating the existing document directly', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertFails(updateDoc(doc(gm, 'settings/aiProviders'), { active: 'openai' }))
  })

  it('denies a GM deleting the existing document directly', async () => {
    const gm = ctx('uid-emp-gm', 'emp-gm', 'gm')
    await assertFails(deleteDoc(doc(gm, 'settings/aiProviders')))
  })

  it('denies a manager creating the document directly', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(setDoc(doc(mgr, 'settings/aiProvidersNew'), aiProvidersPayload()))
  })

  it('denies a manager updating the existing document directly', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(updateDoc(doc(mgr, 'settings/aiProviders'), { active: 'openai' }))
  })

  it('denies a manager deleting the existing document directly', async () => {
    const mgr = ctx('uid-emp-mgr-foh', 'emp-mgr-foh', 'manager')
    await assertFails(deleteDoc(doc(mgr, 'settings/aiProviders')))
  })
})

// ── _devSecrets/{name} — unreachable by any client, under any circumstances ──

describe('_devSecrets/{name} — the dev Secret-Manager stand-in, denied to EVERY role including owner (most security-critical assertion in this file)', () => {
  const roles: Array<[string, string, string]> = [
    ['uid-emp-owner', 'emp-owner', 'owner'],
    ['uid-emp-gm', 'emp-gm', 'gm'],
    ['uid-emp-mgr-foh', 'emp-mgr-foh', 'manager'],
    ['uid-emp-sup-foh', 'emp-sup-foh', 'supervisor'],
    ['uid-emp-staff-foh', 'emp-staff-foh', 'staff'],
  ]

  for (const [uid, employeeId, role] of roles) {
    it(`DENIES ${role} reading the seeded dev secret via getDoc`, async () => {
      const client = ctx(uid, employeeId, role)
      await assertFails(getDoc(doc(client, '_devSecrets/ai-provider-anthropic')))
    })

    it(`DENIES ${role} creating a new dev secret document`, async () => {
      const client = ctx(uid, employeeId, role)
      await assertFails(
        setDoc(doc(client, '_devSecrets/ai-provider-openai'), {
          value: 'sk-attacker-supplied',
          updatedAt: new Date(),
        }),
      )
    })

    it(`DENIES ${role} updating the seeded dev secret document`, async () => {
      const client = ctx(uid, employeeId, role)
      await assertFails(
        updateDoc(doc(client, '_devSecrets/ai-provider-anthropic'), { value: 'sk-overwritten' }),
      )
    })

    it(`DENIES ${role} deleting the seeded dev secret document`, async () => {
      const client = ctx(uid, employeeId, role)
      await assertFails(deleteDoc(doc(client, '_devSecrets/ai-provider-anthropic')))
    })
  }
})

// ── settings/aiRateLimit — server-only cost-guard counter, no client ever ───

describe('settings/aiRateLimit — the generation cost-guard counter, denied to EVERY role including owner', () => {
  const roles: Array<[string, string, string]> = [
    ['uid-emp-owner', 'emp-owner', 'owner'],
    ['uid-emp-gm', 'emp-gm', 'gm'],
    ['uid-emp-mgr-foh', 'emp-mgr-foh', 'manager'],
    ['uid-emp-sup-foh', 'emp-sup-foh', 'supervisor'],
    ['uid-emp-staff-foh', 'emp-staff-foh', 'staff'],
  ]

  for (const [uid, employeeId, role] of roles) {
    it(`DENIES ${role} reading the rate-limit document via getDoc`, async () => {
      const client = ctx(uid, employeeId, role)
      await assertFails(getDoc(doc(client, 'settings/aiRateLimit')))
    })

    it(`DENIES ${role} writing (update) the rate-limit document directly`, async () => {
      const client = ctx(uid, employeeId, role)
      await assertFails(
        updateDoc(doc(client, 'settings/aiRateLimit'), { recentGenerationsAtMs: [] }),
      )
    })

    it(`DENIES ${role} creating a rate-limit-shaped document at a fresh id directly`, async () => {
      const client = ctx(uid, employeeId, role)
      await assertFails(
        setDoc(doc(client, 'settings/aiRateLimitFresh'), {
          recentGenerationsAtMs: [Date.now()],
          updatedAt: new Date(),
        }),
      )
    })
  }
})
