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
| 3 | Core UI kit + `/dev/components` gallery | 🔄 In progress |
| 4 | Desktop + mobile shells | 🔄 In progress |
| 5 | Firebase wiring, emulators, seed script | 🔄 In progress |
| 6 | Auth: Google + email, linking, invite flow | ⬜ Not started |
| 7 | Employees: CRUD, list + profile screens, CSV import | 🔄 Data layer in progress |
| 8 | Access control: permissions, guards, rules + tests | ✅ Core + rules done; route guards pending |
| 9 | Phase 0 checkpoint | ⬜ Blocked on 3–7 |

### Verified so far

- `npm run build` — passing
- `npm run test` — 21 permission unit tests passing
- `npm run test:rules:emulated` — 21 Firestore rules tests passing against the emulator
- `npm run i18n:check` — locale parity enforced (fails on missing keys or untranslated copy-paste)

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

New during Phase 0:

7. **Sign off on the subdocument split** (item 1 above).
10. **Real surnames for Rafa, Tom, Anthony and Oli.** The mockups only ever show
    them by first name, so they are seeded with `lastName: ''`. This is the thing
    most likely to look broken in the roster UI.
11. **Kitchen Lead has no colour.** It appears only in mockup 32's table and is
    absent from design-system.md §2, so it currently reuses Hot Line Cook's
    `#B45309` — two roles rendering identically on the schedule grid. Needs a real
    colour before Phase 1 draws the builder.
12. **`minSkillLevelToCover` is stored in the direction `models.ts` documents**
    (the floor sits on the role being covered *into*). Mockup 32 phrases the same
    control from the opposite direction. Same practical outcome, opposite storage.
    **Confirm before Phase 2 builds trade eligibility on it** — spec §7 condition 2
    is the heart of the product.
13. **No `jobTitle` field exists.** "Assistant Manager" is now a title with nowhere
    to live: Armando and Robin carry `accessRole: 'manager'` narrowed by a real
    override (`discipline.issue: false`). If any screen must *display* "Assistant
    Manager", `Employee` needs a `jobTitle` field.
14. **Salaried amounts need checking.** Mockup 26 shows per-period figures
    ($1,730.77 Daphne, $2,019.23 Denise); the seed stores derived monthly salaries
    (3750 / 4375). Verify the annualisation before Phase 3.
15. **Geofence coordinates are a best-effort geocode** (25.9773, -80.3225) of the
    Miramar address. Confirm on-site alongside §21 item 1.
8. Payroll figures in mockup `26` (rates, hours, `$9,864.50` total) and the daily
   labor splits in mockup `11` are illustrative, not real Rosalia's numbers. They
   were constructed to be internally consistent. Real values needed before Phase 3.
9. `34-ai-providers` shows real Anthropic model ids (`claude-opus-5`, Sonnet 5,
   Haiku 4.5) but placeholder OpenAI/Google names. Confirm which providers you
   actually want configured before Phase 5.

---

## Known issues / cleanup backlog

- **Rules evaluation errors on deny paths.** Several deny-path rules tests log
  `evaluation error at L106/L143` rather than cleanly returning false. The denials
  are correct and all allow-paths evaluate cleanly, but an evaluation error can
  mask an intended allow. Tighten the field-existence guards in
  `firestore.rules` before Phase 1 adds more collections.
- **No ESLint config yet.** `npm run lint` is declared but will fail until one is
  added.
- **No Cloud Functions yet.** Custom claims (`role`, `employeeId`) are assumed by
  both `firestore.rules` and `storage.rules` but nothing sets them — the invite
  acceptance Function is part of milestone 6.
- **Spanish screens unproven.** All 49 mockups are English. Layouts are built for
  ~30% expansion but that has never been visually verified.

---

## How to run

```bash
npm install
npm run dev                    # http://localhost:5173
npm run emulators              # Firestore/Auth/Storage/Functions + UI on :4000
npm run seed                   # populate emulator with the persona cast
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
