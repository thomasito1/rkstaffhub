# PROGRESS — RK StaffHub

**Current phase: Phase 2 — Trades + Time Clock + Tips** (spec §19)
Phase 0 and Phase 1 complete and reviewed.
Last updated: Aug 14, 2026 — trade eligibility engine + claim/accept/approve/decline.

Phases are sequential. Do not build later-phase features early, even scaffolding.

---

## Phase 2 status (spec §19's checklist)

| Item | Status |
| --- | --- |
| Data model + rules (trades, punches, tipReports) | ✅ Done — `firestore.rules`, `src/types/models.ts`, 119 rules tests |
| Trade eligibility engine | ✅ Done — `src/lib/scheduling/tradeEligibility.ts`, spec §7's four conditions, one shared implementation (see below) |
| Direct trades, open pool, manager approvals | ✅ Done — `src/lib/db/trades.ts` (post/cancel, client writes) + `functions/src/tradeActions.ts` (claim/accept/approve/decline, Cloud Functions) |
| Push + ZenZap webhook stub | ⬜ Not started |
| Geofenced selfie clock in/out + offline queue | ⬜ Not started |
| Tip report at clock-out | ⬜ Not started |
| Shifts & Tips admin section | ⬜ Not started |

**Shared eligibility module, and the build-boundary question it resolved.**
`scheduleOverride.ts` (Phase 1) duplicated `effectiveSkillFor` rather than
importing it, with a comment explaining why: `functions/` compiles as its own
CommonJS package with its own `tsconfig.json` `rootDir: "src"` and cannot
resolve `src/lib/*` across that boundary. Rafa's ruling for trade eligibility
(Aug 14, 2026): that duplication convention does not extend to it — one
implementation, shared. **Resolved cheaply**: `functions/src/tradeEligibility.ts`
is a plain symlink to `../../src/lib/scheduling/tradeEligibility.ts`. `tsc`
resolves a symlinked file as living physically under `rootDir`, so it type-checks
and emits (to `functions/lib/tradeEligibility.js`) with **zero** config changes —
no `rootDir`/`outDir`/`main` rewrites, confirmed by a forced type error inside
the shared file surfacing correctly from `functions/`'s own `tsc` run. This same
trick is available the next time Phase 2+ needs to share pure logic across the
package boundary; `scheduleOverride.ts`'s existing duplicate was left as-is
(out of scope for this task, not touched).

`conflicts.ts` (the schedule builder's fuller engine — role/skill, time-off,
double-booking, department, PLUS availability/overtime warns) now delegates to
`tradeEligibility.ts` for every primitive it shares with trade eligibility,
rather than the reverse — `checkTradeEligibility()` deliberately does NOT call
`findConflicts()`, to keep the dependency one-directional and avoid a circular
import between the two modules.

**Typed trade error codes.** Per Rafa's ruling, the four callables return
enumerated codes (`trade/not-open`, `trade/ineligible-skill`,
`trade/shift-changed`, `trade/wrong-approver`, etc. — full list in
`tradeEligibility.ts`'s `TradeErrorCode`) via `HttpsError`'s `details.code`,
since a callable's own `code` field is locked to Firebase's fixed
`FunctionsErrorCode` enum. `firebaseErrorCode()`
(`src/lib/firebaseError.ts`) now prefers `details.code` when present, so
`isFirebaseError(err, 'trade/ineligible-skill')` works exactly like every
other Firebase error-code check in this codebase — one comparison helper,
regardless of which layer produced the specific code.

**Verified against a live emulator suite** (Auth + Firestore + Functions,
matching how `scheduleOverride`/`schedulePublish` were verified — no
committed test file for Cloud Functions in this codebase): 13 scenarios,
all passing — eligible claim; ineligible claim (wrong role); stale-shift
claim (shift reassigned after posting); direct accept by the right and wrong
recipient; approve moving the shift + setting `dirtySincePublish`; department-
scoped approval denial; Owner/GM department bypass; the three-way override
branch (ineligible + no `trades.manualAssign` → ineligibility code; ineligible
+ `trades.manualAssign` + no reason → `trade/override-reason-required`;
ineligible + reason → succeeds and writes a `trade.override` auditLog entry);
pool decline reopening; direct decline staying terminal.

**Open question for Rafa — `traded`/`dropped` `ShiftStatus` values.**
`src/types/models.ts`'s `ShiftStatus` union has carried `'traded'` and
`'dropped'` since Phase 0/1 scaffolding, but neither spec text nor any mockup
defines what sets them or what they mean structurally (mockup copy uses
"dropped" only as an English verb, e.g. "Isaac Boynton dropped a shift" —
not necessarily the enum literal). `approveTrade` deliberately does NOT set
either: it updates `shift.employeeId` + `dirtySincePublish: true`, the same
mechanism `scheduleOverride.ts` already uses and the republish flow already
reads, and leaves `status` (draft/published/etc.) untouched. Confirm whether
`'traded'`/`'dropped'` should ever be written, and by what event, before they
are used anywhere.

**48h direct-trade expiry — informational only, confirmed.** No enforcement
mechanism exists (matches the accepted pattern for the Thursday availability
deadline). `isTradeExpired()` (`src/lib/db/trades.ts`) is display-only, for a
future Shift Pool UI to render an expired offer as expired rather than still
actionable. **TODO before Phase 3 ships**: add a Cloud Scheduler sweep that
transitions expired open direct trades (`declined` or a dedicated `expired`
status — not yet decided) once Phase 3's scheduled-function infrastructure
exists for payroll period rollovers; track alongside that work, not before.

---

## Phase 1 status (spec §19's checklist)

| Item | Status |
| --- | --- |
| Availability submission (recurring/temporary) | ✅ Done |
| Requests + glance view | ✅ Done |
| Deadlines & reminders | ✅ Done |
| shiftRoles + role hierarchy settings | ✅ Done (Aug 14) — Settings → Roles & hierarchy, with cycle detection and a confirm-with-warning before a coverage removal strands a published shift |
| shiftTemplates | ⚠️ **Data layer only** — `src/lib/db/shiftTemplates.ts` exists (seeded, 14 docs); no Settings UI to edit day-part headcount requirements, and the builder has no requirement-fulfillment (met/unmet) badge per shift-role band. Not part of Rafa's Aug 14 checkpoint ask; flagging as the one item on this checklist still unbuilt. |
| Schedule builder (grid, conflicts engine, labor footer) | ✅ Done |
| Publish/republish + notifications | ✅ Done (Aug 14) — republish now detects edits to already-published shifts, not just new draft ones; §17 audit write retries once and leaves a durable `auditPending` marker (surfaced on the builder) if it still fails |
| Staff schedule views | ✅ Done (Aug 14) — `/schedule` splits by role: the builder, or the new My Schedule (week list + shift detail) for everyone else |
| Time-off requests/calendar/blocked days | ✅ Done (Aug 14) — Settings → Time off (admin) + `/time-off` (staff self-service); "blocked days" reads as the existing approved-time-off-blocks-scheduling rule in the conflicts engine, already built |

Also added, not on this checklist but spec §6's own text: Who's Working
(`/schedule/whos-working`) — the day gantt, its own route rather than a tab
on Home (Phase 6).

**How to review Aug 14's work:** re-run `npm run seed` first — this session's
interactive testing mutated seeded data (role coverage, a role created, a
time-off approval, a shift assignment) that a fresh seed clears. Then sign in
as Denise Lasarte (GM) for Settings → Roles & hierarchy and → Time off, and
as any FOH/BOH staff member (e.g. Marisol Peña) for `/schedule` and
`/schedule/whos-working`.

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

## ✅ Accepted spec deviations

Approved by Rafa. These are settled — do not reopen them, and build later phases
against what is written here rather than against the source document they
deviate from.

### A1. Sensitive employee fields live in subdocuments (deviates from spec §3)

**Approved by Rafa, Aug 13 2026.** This is the permanent model.

**The problem.** Spec §17 requires field-level read control — staff read their own
profile "minus schedulingNotes/rates", and §4 says a Manager must not see another
Manager's salary. **Firestore has no field-level read security.** Rules gate whole
documents. With `hourlyRate` and `schedulingNotes` on `employees/{id}` as §3 lists
them, any rule that lets a supervisor read the roster also hands them every salary.

**The layout.** The physical split; the logical model from §3 is intact:

```
employees/{id}                        ← profile; readable by any signed-in employee
employees/{id}/private/compensation   ← hourlyRate, salaryAmount, salaryPeriod
employees/{id}/private/admin          ← schedulingNotes, permissionOverrides
```

Own-rate reads still work (§17 confirms "show own rate: yes"). Equal-rank reads are
denied, proven by rules tests. The rejected alternative was routing every employee
read through a Cloud Function that strips fields per caller — slower, costlier, and
it breaks real-time listeners.

### A2. Mockup 32 is wrong on coverage direction (deviates from that mockup)

**Ruled by Rafa, Aug 13 2026.** Trade/claim eligibility is **exactly two
independent checks** (spec §7):

1. **Directional role coverage** via `canCoverRoleIds`, declared on the
   **covering** role. Bartender lists Server/Host/Runner; Server lists nothing
   upward. Asymmetric by design.
2. **Skill gating**: the claimant's `skillLevel` for the role being worked must be
   `>=` the **shift's** `requiredSkillLevel`.

There is **no separate `minSkillLevelToCover` field** — the shift's required level
is the only skill bar. The field has been removed from `src/types/models.ts`,
`src/lib/db/shiftRoles.ts` and `scripts/seed.ts`, and the seed's role writer
issues an explicit `FieldValue.delete()` pass so a re-seed strips it from any
document that still carries it.

Mockup 32 phrases the same control from the opposite direction ("a Bartender must
be at least L2 to pick up a Server shift", a floor stored on the role being covered
*into*). Coverage is behavior, so per CLAUDE.md's conflict rule the spec wins:
**mockup 32 is a layout reference only on this point.** When Settings → Roles is
built, that column must not be reintroduced.

### A3. Mockups 26 and 35 show the wrong pay period — visual only

**Ruled by Rafa, Aug 13 2026.** The default pay period is **semimonthly, paid on
the 5th and the 20th of each month**. Schedule weeks stay **Mon–Sun**. The toggle
stays configurable per spec §11; `AppSettings.payPeriod` is now
`{ frequency: 'weekly' | 'biweekly' | 'semimonthly'; startDay: string; semimonthlyDays?: [number, number] }`
and the seed writes `{ frequency: 'semimonthly', startDay: 'monday', semimonthlyDays: [5, 20] }`.

Mockups 26 and 35 render a biweekly period (Aug 3–16 2026). Where they differ from
the above they are **visual-only** — replicate their layout, not their period math.

See the semimonthly/overtime trap in "Known issues" below before starting Phase 3.

---

## Resolved during Phase 0 (recorded for the trail)

### 1. Access roles — "Assistant Manager"

Spec §3/§4 enumerate exactly five: owner, gm, manager, supervisor, staff. Mockup
`33-permissions-matrix` shows an "Assistant Mgr" column — my design-time invention,
not from your spec. **Confirmed with Rafa: job title only.** Armando Hernandez and
Robin Leyva carry `accessRole: 'manager'`; any narrowing uses `permissionOverrides`.

### 2. Permission key names — mockup 33 is not authoritative

Mockup 33 renders invented keys (`schedule.ai`, `punch.view`, `payroll.run`,
`people.rate`, `hr.discipline`, `settings.roles`…). Permission keys are behavior,
so per CLAUDE.md's conflict rule the **spec §4 list wins**. Mockup 33 is a layout
reference only. When that screen is built in a later phase, its rows must be
relabeled to the real keys.

### 3. Supervisor gets `employees.view` (inferred, not specified)

Spec §4 lists the supervisor grant set without `employees.view`, but a supervisor
who can read the schedule needs the roster for it to make sense. Granted by
default. Defaults are admin-editable, so this is cheap to reverse.

### 4. Geofence address conflict

Spec §3/§8 say **12130 Miramar Pkwy, Miramar FL**. Mockup `35-general-settings`
shows *1802 SW 22nd St, Miami* — a design-time invention. Spec wins; the seed uses
Miramar. Confirm the real address and the 150 m radius on-site (spec §21 item 1).

---

## Open questions for Rafa (spec §21, plus new)

Four items were answered on **Aug 13 2026** and have been removed from this list:
Kitchen Lead's colour, the four missing surnames, the `minSkillLevelToCover`
direction, and the pay period. See "Accepted spec deviations" above.

From spec §21, to confirm when each phase reaches them:

1. Geofence radius default 150 m — confirm on-site.
2. Selfie retention 13 months — confirm.
3. Staff see their own hourly rate — spec says yes; **implemented as yes**.
4. Exact escalation ladder steps/thresholds — needed for Phase 4.
5. Skill levels fixed at 1–3 — confirm 3 tiers is enough. Now load-bearing: with
   `minSkillLevelToCover` gone, a shift's `requiredSkillLevel` is the *only*
   skill bar in the eligibility check.

New during Phase 0. Ordered by when they block work:

**Before Phase 2 (trades + clock):**

6. **Geofence coordinates are a best-effort geocode** (25.9773, -80.3225) of the
   Miramar address. Confirm on-site alongside §21 item 1.

**Before Phase 3 (payroll):**

7. **Salaried amounts.** Mockup 26 shows per-period figures ($1,730.77 Daphne,
   $2,019.23 Denise); the seed stores derived monthly salaries (3750 / 4375).
   Verify the annualisation — and note the per-period figures were computed
   against a *biweekly* period, so they need restating for semimonthly.
8. **Payroll figures are illustrative.** Mockup 26's rates, hours and
   `$9,864.50` total, and mockup 11's daily labor splits, were constructed to be
   internally consistent — they are not real Rosalia's numbers.

**Before Phase 5 (AI):**

9. `34-ai-providers` shows real Anthropic model ids (`claude-opus-5`, Sonnet 5,
   Haiku 4.5) but placeholder OpenAI/Google names. Confirm which providers you
   actually want configured.

**Anytime — schema additions, cheap now and costly later:**

10. **No `jobTitle` field exists.** "Assistant Manager" is now a title with
    nowhere to live: Armando and Robin carry `accessRole: 'manager'` narrowed by a
    real override (`discipline.issue: false`). If any screen must *display*
    "Assistant Manager", `Employee` needs a `jobTitle` field.
11. **`AuditAction` has no invite/claims member.** The union in
    `src/types/models.ts` is verbatim spec §17 and stops at `permission.change`.
    The three Functions that move claims around (invite acceptance, manual
    re-sync, the role-change trigger) all log as `permission.change`,
    distinguished by `targetType` (`invite` | `employee`) and `reason`
    (`invite.accept` | `claims.resync` | `role.change`). If you want them distinct
    in the Phase 6 audit viewer, `AuditAction` needs `invite.accept` adding.

---

## Known issues / cleanup backlog

- **Deliberate scope cuts, Aug 14 checkpoint** — flagged for Rafa's awareness,
  not treated as bugs:
  - **Time off calendar** (Settings → Time off → Calendar) draws a day-cell
    chip list, not mockup 36's date-spanning bars with lane assignment. The
    lane-assignment algorithm is real layout work this secondary view (the
    Requests tab is where approve/decline happens) doesn't need to justify.
  - **Who's Working** has no labor $/% stat tile. Computing it needs every
    scheduled employee's hourly rate, which `private/compensation` denies to
    anyone but that employee or a manager with `employees.editPay` (spec
    §17) — showing it on a screen "visible to all staff" would mean
    partial-and-wrong numbers for most viewers or a real compensation leak.
  - **My Schedule's shift detail** drops mockup 14b's "Manager on duty" (a
    BOH viewer's rules deny reading an FOH MOD's shift), "Clock in opens"
    (Phase 2 time clock), and "Added by" (shifts carry no `createdBy` field).
  - **Roles & hierarchy** reorders with up/down buttons, not mockup 32's
    drag handle — no drag-and-drop library is in the stack, and
    `reorderShiftRoles()` just needs an ordered id list either way.
- **RESOLVED — the "dirty denials" were never a defect.** Firestore evaluates a
  write rule **twice**: once before it has fetched anything (every `get()` in the
  expression reports "evaluation error"), then again after fetching, cleanly.
  Independently verified with probe rules: a write rule whose `get()` sits behind
  a **false** guard still logs the error, while the identical `get()` on a *read*
  rule, and a write rule with no `get()`, are both silent. So the artifact is
  unavoidable for any write rule that consults a permission document, and no
  amount of guarding suppresses it — the earlier bisection could not have
  succeeded. `scripts/check-rules-clean.mjs` now parses the decision trace and
  fails only when a rule errors and **never reaches a verdict**; genuine dirty
  denials still break the build. Reports **0 dirty denials, 12 first-pass
  artifacts**. The quarantine comment in `firestore.rules` is now historical.

  ⚠️ **Fragility note.** The detector parses the Firestore emulator's decision
  trace text, which is not a stable, versioned API — `firebase-tools` is pinned
  to an exact version (`13.29.1`, no `^`) in `package.json` specifically so this
  doesn't silently drift. **If `firebase-tools` is ever bumped, re-run
  `npm run test:rules:clean` and manually inspect its output before trusting a
  green result** — the emulator's trace format may have changed shape, and a
  parser that silently stops matching would report false confidence, not a
  failure. If CI ever fails mysteriously on this check right after a dependency
  bump, this note is where to look first.

- **RESOLVED — mockup `11-schedule-builder-desktop-en.html` is superseded by the
  seed.** The mockup's drawn shift cards (~84 hrs at $11–13.50/hr) and its own
  labor footer ($2,544.00 / 141.5 hrs, a blended $17.98/hr) cannot both be true —
  the remaining 57 hrs would need $27/hr, above every rate on the roster. The
  seed is the arithmetic source of truth; the mockup is retained only for its
  **visual grammar** — role-band grouping, station chips, the conflict tint, the
  OT corner flag, the labor-footer layout. **Do not "correct" the seed or the
  builder back toward the mockup's card-by-card numbers** — they were never
  internally consistent to begin with. See the seed's `assertLaborReconciles()`
  for the numbers that are actually true, and the git log for the specific
  moves (OT chip → Oli Fonseca 44.0 hrs; availability conflict → Micah's
  Saturday) and why each was necessary.

- **NOTED — mockup 11's own week-total percent (`42.0%`) is an arithmetic
  slip, not a rounding choice.** Found during Rafa's interactive review pass
  (Aug 14, 2026): the mockup's footer reads "$2,544 · 42.0%" against
  `$2,544 / 141.5 hrs`, but $2,544 divided by the mockup's own projected sales
  total ($6,117) is 41.59% — displayed as **42%** once the builder's day pills
  were rounded to whole percents (see the labor-% rounding fix below), never
  42.0%. Two separate things were true here: the app was showing an extra,
  un-mockup'd decimal (`44.4%` instead of `44%`), AND the mockup's own printed
  week-total figure doesn't follow from its own numbers. Fixed the former by
  rounding `LaborFooter`'s day pills (and the over/under color threshold,
  compared at the same rounded precision) to whole percents; left the latter
  as this note — the week-total strip still shows one decimal
  (`formatPercent`'s default), matching the mockup's own precision choice
  there, just with the correct underlying math.

- **RESOLVED — mockup `12-shift-modal-desktop-en.html`'s eligibility example is
  superseded by data**, for the same underlying reason: role coverage is
  asymmetric (spec §7.1) — Bartender's `canCoverRoleIds` includes Server, Server's
  does not include Bartender — and the mockup shows a Server as eligible to
  cover a Bartender shift, which is wrong on behavior, not merely stale on
  numbers. **Keep from the mockup:** the eligible-employees list layout (person,
  effective skill, conflict state, sorted by skill). **Do not** use its specific
  example pairing as a behavioral reference — `shiftRoles.canCoverRoleIds` is
  the only source of truth for who can cover what. See
  DESIGN-HANDOFF.md's "Superseded" section for the full note.

- **RESOLVED — publish/republish now write their §17 audit entry.** Promoted
  from a tracked gap to the first task of this work block per Rafa's ruling
  (Aug 13, 2026): **publish must not be used against real data until the audit
  entry lands**, and it now has. `recordSchedulePublish`
  (`functions/src/schedulePublish.ts`) is pattern-matched to
  `recordScheduleOverride`: it independently derives publish-vs-republish from
  the week's CURRENTLY STORED status inside a transaction — a client claiming
  "publish" on an already-live week is corrected to a republish, not obeyed —
  flips the week and its draft shifts atomically, then writes the audit entry
  as a best-effort follow-up (same two-step shape as the override function, so
  a logging hiccup can't roll back a publish that already succeeded).
  `src/lib/db/schedules.ts`'s `publishSchedule()`/`republishSchedule()` now
  call it instead of writing directly; both dropped their `actor` parameter
  since the Function resolves the actor from the ID token, not a client claim.
  Verified against the live emulator: a republish of the seeded (already
  published) week correctly comes back `republished`; a first publish of a
  brand-new draft week flips its one draft shift and returns the right
  `notifyEmployeeIds`; exactly 2 `auditLog` entries land with accurate
  before/after state; a staff caller is denied outright.

  **Still open, not part of this fix:** republish's "affected employees" is
  still approximated as owners of shifts flipped from draft this call — edits
  to an *already-published* shift (a time change, a reassignment) don't appear
  in that set. Catching those needs a per-shift change log, which remains a
  separate, not-yet-built gap.

### Not enforced in rules — deliberate, moves to the Phase 2 callable

- **The Thursday 23:59 ET availability deadline.** Rules have no tz database, so
  "Thursday 23:59 ET" is 03:59Z or 04:59Z depending on the week. Deriving it from
  the `weekId` string needs `int()` over client-controlled substrings, which
  throws on a malformed id; comparing against a deadline field on the document
  would mean the submitting client picks its own lock. **Approved as designed**
  (Aug 13, 2026): rules enforce the expressible half — own availability only,
  never review your own — and the deadline itself is computed server-side (real
  tzdata, via `src/lib/deadlines.ts`'s approach) inside the Phase 2 callable that
  will own `submitAvailability`'s enforcement.

### RESOLVED — staff shift reads (was: "breaks listShifts() for staff")

The rule was already correct — it scopes shift reads to published + (own shift
OR own department), and managers+ already bypass it via `canEditSchedules`. The
bug was entirely client-side: `listShifts()` fetched the whole subcollection and
filtered department/status with `.filter()` *after* the fetch. Firestore denies
the **whole query** the moment it would return even one document the rule
rejects — so an unscoped staff call on a mixed FOH/BOH or mixed draft/published
week was denied outright, and the catch turned that into a silent `[]`.

**Fixed by pushing `department` and `status` into the actual Firestore query**
as `where()` equality constraints (no composite index needed — Firestore does
not require one for equality-only compound queries). `listShifts()` now takes
both; `listPublishedShiftsForDepartment(weekId, department)` is the enforced
entry point for staff-facing screens, so a future caller cannot regress to the
old bug by omission. **The rule was NOT widened.**

**Confirmed policy** (Aug 13, 2026): staff see only their own department's
published schedule — FOH staff cannot view BOH's week and vice versa. Managers+
see both, unscoped. Proven with a real `getDocs()` query in
`tests/rules/scheduling.rules.test.ts` (not just single-document reads): an
unscoped staff query fails outright, the department+status-scoped query
succeeds and returns exactly the one allowed shift, and the manager's unscoped
query returns all three.

### Phase 3 payroll math — RULED, build on this from the start

Overtime is **always** computed per Mon–Sun workweek (>40 hrs, FLSA 1.5×), never
by summing hours inside a pay period. Each workweek's regular/OT split is then
**allocated to pay periods by where the hours fell**. Pay periods are semimonthly
(5th and 20th), so a period contains partial workweeks at both ends — summing
within a period would silently mis-state overtime.

The payroll workshop must surface **both**: the per-workweek OT truth and the
period allocation. Mockup 26's per-period salary figures ($1,730.77 / $2,019.23)
were computed against a biweekly period and are **visual-only deviations** — they
need restating for semimonthly.


- **⚠️ Semimonthly pay periods vs. per-workweek overtime — a real correctness
  trap, Phase 3.** FLSA computes overtime per **workweek**: hours over 40 in a
  fixed Mon–Sun week. Pay periods are now **semimonthly** (5th and 20th), and a
  semimonthly period does not align to week boundaries — it *always* cuts through
  a workweek at both ends. So:
  - Summing hours inside a pay period and taking everything over some threshold
    as OT is **wrong**, and wrong in the employer's favour, which is the
    expensive direction.
  - The correct order is: bucket punches into Mon–Sun workweeks → compute
    OT per workweek → *then* allocate each workweek's regular and OT hours to
    whichever pay period each day falls in.
  - A single workweek can therefore be split across two pay periods and two
    payslips. The period-boundary day is the one to write tests for.
  - The same trap applies to any weekly cap or weekly-average rate math, and to
    the period lock (`payroll.lockPeriod`): locking a period must not prevent
    the *other* half of a straddling workweek from being computed.
  This is why `AppSettings.payPeriod` and `scheduleWeekStart` are separate
  fields. Do not collapse them.
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

**Node 20 is required.** `.nvmrc` pins it and the root `package.json` declares
`engines.node: "20.x"`; run `nvm use` in the project root before anything else.

This is not cosmetic. `functions/` deploys to the **`nodejs20`** Cloud Functions
runtime and declares `engines.node: "20"` of its own, and the Functions emulator
runs your local Node against that declared runtime. A mismatched local Node
produces confusing, misattributed failures — functions that fail to load, worker
processes killed on first request, or native-module errors from
`firebase-tools` — none of which name the Node version as the cause. If the
emulator misbehaves in a way that makes no sense, check `node --version` first.

```bash
nvm use                        # Node 20, per .nvmrc
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
nvm use                    # Node 20, per .nvmrc — see the note above
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
