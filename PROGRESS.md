# PROGRESS — RK StaffHub

**Current phase: Phase 0 — Foundation** (spec §19)
Last updated: Aug 13, 2026

Phases are sequential. Do not build later-phase features early, even scaffolding.

---

## Phase 0 status

| # | Milestone | Status |
| --- | --- | --- |
| 1 | Vite + React + TS + Tailwind + router + i18n + PWA scaffold | ✅ Done |
| 2 | Design tokens → `tailwind.config.js` | ✅ Done |
| 3 | Core UI kit + `/dev/components` gallery | ✅ Done |
| 4 | Desktop + mobile shells | ✅ Done |
| 5 | Firebase wiring, emulators, seed script | ✅ Done |
| 6 | Auth: Google + email, linking, invite flow | ✅ Done |
| 6b | Cloud Functions: claims + invite acceptance (`functions/`) | ✅ Done |
| 7 | Employees: CRUD, list + profile screens, CSV import | ✅ Done |
| 8 | Access control: permissions, guards, rules + tests | ✅ Done |
| 9 | Phase 0 checkpoint | ✅ **Awaiting Rafa's review** |

**Phase 0 is complete and stopped for review. Do not start Phase 1 without a go.**

### Verified

| Check | Result |
| --- | --- |
| `npm run build` | ✅ typecheck (strict + `noUncheckedIndexedAccess`) + production build |
| `npm run test` | ✅ 43 tests — 21 permissions, 22 CSV import |
| `npm run test:rules:emulated` | ✅ 21 rules tests against the live Firestore emulator |
| `npm run i18n:check` | ✅ 479 keys, en/es parity |
| `npm run seed` | ✅ idempotent — double-run verified: 25 employees, 50 private docs, 14 roles, 23 auth accounts + claims, 1 pending invite |
| `functions/` build + emulator | ✅ 4 functions load; 44-assertion end-to-end check against the live suite passed (invite preview, token-enumeration parity, accept, idempotent retry, permission gates, role-change trigger) |
| `npm run dev` | ✅ serves 200, compiles clean |

Seed + rules tests were also run together against one emulator instance to
confirm the rules hold against realistic seeded data, not just fixtures.

### Commits

9 commits on `main`, one per completed task, no broken builds:
foundation → security → UI kit → shells → auth context → data layer → docs →
auth screens → routing → people.

---

## ⚠️ Decisions needing Rafa's sign-off

### 1. Sensitive employee fields moved to subdocuments (deviation from spec §3)

**The problem.** Spec §17 requires field-level read control — staff read their own
profile "minus schedulingNotes/rates", and §4 says a Manager must not see another
Manager's salary. **Firestore has no field-level read security.** Rules gate whole
documents. With `hourlyRate` and `schedulingNotes` on `employees/{id}` as §3 lists
them, any rule that lets a supervisor read the roster also hands them every salary.

**What I did.** Split the physical layout, leaving the logical model from §3 intact:

```
employees/{id}                        ← profile; readable by any signed-in employee
employees/{id}/private/compensation   ← hourlyRate, salaryAmount, salaryPeriod
employees/{id}/private/admin          ← schedulingNotes, permissionOverrides
```

Own-rate reads still work (§17 confirms "show own rate: yes"). Equal-rank reads are
denied, proven by rules tests.

**Alternative if you'd rather not deviate:** route every employee read through a
Cloud Function that strips fields per caller. Slower, costlier, and it breaks
real-time listeners. I recommend keeping the split.

### 2. Access roles — "Assistant Manager" (RESOLVED, recorded here for the trail)

Spec §3/§4 enumerate exactly five: owner, gm, manager, supervisor, staff. Mockup
`33-permissions-matrix` shows an "Assistant Mgr" column — my design-time invention,
not from your spec. **Confirmed with Rafa: job title only.** Armando Hernandez and
Robin Leyva carry `accessRole: 'manager'`; any narrowing uses `permissionOverrides`.

### 3. Permission key names — mockup 33 is not authoritative (RESOLVED)

Mockup 33 renders invented keys (`schedule.ai`, `punch.view`, `payroll.run`,
`people.rate`, `hr.discipline`, `settings.roles`…). Permission keys are behavior,
so per CLAUDE.md's conflict rule the **spec §4 list wins**. Mockup 33 is a layout
reference only. When that screen is built in a later phase, its rows must be
relabeled to the real keys.

### 4. Supervisor gets `employees.view` (inferred, not specified)

Spec §4 lists the supervisor grant set without `employees.view`, but a supervisor
who can read the schedule needs the roster for it to make sense. Granted by
default. Defaults are admin-editable, so this is cheap to reverse.

### 5. Geofence address conflict

Spec §3/§8 say **12130 Miramar Pkwy, Miramar FL**. Mockup `35-general-settings`
shows *1802 SW 22nd St, Miami* — a design-time invention. Spec wins; the seed uses
Miramar. Confirm the real address and the 150 m radius on-site (spec §21 item 1).

---

## Open questions for Rafa (spec §21, plus new)

From spec §21, to confirm when each phase reaches them:

1. Geofence radius default 150 m — confirm on-site.
2. Selfie retention 13 months — confirm.
3. Staff see their own hourly rate — spec says yes; **implemented as yes**.
4. Exact escalation ladder steps/thresholds — needed for Phase 4.
5. Pay period weekly Mon–Sun — **conflict**: mockups `26`/`35` show *biweekly*
   (Aug 3–16). Spec §11 defaults weekly. Needed before Phase 3.
6. Skill levels fixed at 1–3 — confirm 3 tiers is enough.

New during Phase 0. Ordered by when they block work:

**Before Phase 1 (scheduling):**

7. **Kitchen Lead has no colour.** It appears only in mockup 32's table and is
   absent from design-system.md §2, so it currently reuses Hot Line Cook's
   `#B45309` — two roles rendering identically on the schedule grid.
8. **Real surnames for Rafa, Tom, Anthony and Oli.** The mockups only ever show
   them by first name, so they are seeded with `lastName: ''`. This is the thing
   most likely to look broken in the roster UI.

**Before Phase 2 (trades + clock):**

9. **`minSkillLevelToCover` direction.** It is stored the way `models.ts`
   documents it — the floor sits on the role being covered *into*. Mockup 32
   phrases the same control from the opposite direction. Same practical outcome,
   opposite storage. **Spec §7 condition 2 is the heart of the product**, so
   confirm before eligibility is built on it.
10. **Geofence coordinates are a best-effort geocode** (25.9773, -80.3225) of the
    Miramar address. Confirm on-site alongside §21 item 1.

**Before Phase 3 (payroll):**

11. **Salaried amounts.** Mockup 26 shows per-period figures ($1,730.77 Daphne,
    $2,019.23 Denise); the seed stores derived monthly salaries (3750 / 4375).
    Verify the annualisation.
12. **Payroll figures are illustrative.** Mockup 26's rates, hours and
    `$9,864.50` total, and mockup 11's daily labor splits, were constructed to be
    internally consistent — they are not real Rosalia's numbers.

**Before Phase 5 (AI):**

13. `34-ai-providers` shows real Anthropic model ids (`claude-opus-5`, Sonnet 5,
    Haiku 4.5) but placeholder OpenAI/Google names. Confirm which providers you
    actually want configured.

**Anytime — schema additions, cheap now and costly later:**

14. **Sign off on the subdocument split** (decision 1 above). This is the one
    with real architectural weight.
15. **No `jobTitle` field exists.** "Assistant Manager" is now a title with
    nowhere to live: Armando and Robin carry `accessRole: 'manager'` narrowed by a
    real override (`discipline.issue: false`). If any screen must *display*
    "Assistant Manager", `Employee` needs a `jobTitle` field.
16. **`AuditAction` has no invite/claims member.** The union in
    `src/types/models.ts` is verbatim spec §17 and stops at `permission.change`.
    The three Functions that move claims around (invite acceptance, manual
    re-sync, the role-change trigger) all log as `permission.change`,
    distinguished by `targetType` (`invite` | `employee`) and `reason`
    (`invite.accept` | `claims.resync` | `role.change`). If you want them distinct
    in the Phase 6 audit viewer, `AuditAction` needs `invite.accept` adding.

---

## Known issues / cleanup backlog

- **Rules evaluation errors on deny paths.** Several deny-path rules tests log
  `evaluation error at L106/L143` rather than cleanly returning false. The denials
  are correct and all allow-paths evaluate cleanly, but an evaluation error can
  mask an intended allow. Tighten the field-existence guards in
  `firestore.rules` before Phase 1 adds more collections.
- **No ESLint config yet.** `npm run lint` is declared but will fail until one is
  added.
- **`firebase-functions` is pinned to v6, not v7.** `firebase-tools@13` calls the
  removed `functions.config()` inside its emulator runtime shim; against
  `firebase-functions@7` the worker dies with "Your function was killed because it
  raised an unhandled error" on the first request. v6 exposes the identical v2 API
  (`onCall`, `onDocumentUpdated`, `setGlobalOptions`). Unpin only together with a
  `firebase-tools` major upgrade, and re-run the emulator check afterwards.
- **Legal links are placeholders.** The login screens point at `#privacy` and
  `#terms`. Real routes or external URLs needed before anyone signs in for real.
- **Spanish screens unproven.** All 49 mockups are English. Layouts are built for
  ~30% expansion but that has never been visually verified.

---

## How to run

```bash
npm install
npm run dev                    # http://localhost:5173
npm run functions:install      # once — functions/ is its own npm package
npm run functions:build        # compile functions/src → functions/lib
npm run emulators              # builds functions, then Firestore/Auth/Storage/Functions + UI on :4000
npm run seed                   # persona cast + auth accounts + claims + one live invite
npm run build                  # typecheck + production build
npm run test                   # unit tests
npm run test:rules:emulated    # security rules against the emulator
npm run i18n:check             # locale parity
```

**Java note:** the emulators need a JVM. Installed via `brew install openjdk`
(keg-only). The `emulators*` npm scripts inject it onto PATH, so no shell profile
change is needed.

**Review surface:** `/dev/components` renders every UI-kit primitive for visual
comparison against `.superdesign/export/01-design-system-desktop-en.html`.

---

## How to review Phase 0

```bash
npm install
npm run functions:install  # once — functions/ has its own node_modules
npm run emulators          # terminal 1 — builds functions, then leaves the suite running

# terminal 2 — once. Both hosts are required; the seed refuses to run without them.
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
npm run seed

npm run dev                # terminal 3
```

The seed prints a **credentials table**: every active employee, one shared dev
password (`rkdev2026`), grouped by access role. Sign in as an owner, the GM, a
manager, a supervisor and a staff member to see §4 in effect. It also prints a
live invite link for **Nadia Salgado**, the one seeded employee with no account —
open it signed out to walk `getInvite` → sign-up → `acceptInvite` → claims →
`status: active`. Re-running the seed resets that invite so the flow can be
walked again.

Then walk these, mockup side by side:

| Route | Compare against |
| --- | --- |
| `/dev/components` | `01-design-system-desktop-en.html` |
| `/login` | `01-login-desktop-en.html` and `01-login-mobile-en.html` |
| `/invite?token=…` | `02-invite-acceptance-desktop-en.html` |
| `/people` | no mockup — follows mockup 09's admin-table pattern |
| `/people/:id` | `04-profile-admin-desktop-en.html` |
| `/profile` | `03-profile-staff-mobile-en.html` |
| `/people/import` | no mockup — spec §18 |
| any app route | shells: `05-dashboard-overview` / `07-staff-home` |

Resize across 768px to switch shells. Use device emulation on an iPhone-class
viewport to check the safe-area insets.

Signing in works: `functions/` issues the `employeeId` / `role` custom claims
that `AuthProvider` resolves the employee from, and the seed pre-issues them for
everyone already onboarded. Use the credentials table the seed prints.
