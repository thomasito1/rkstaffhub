# PROGRESS — RK StaffHub

**Current phase: Phase 5 — AI scheduling assistant** (spec §19)
Phases 0, 1, 2, 3, and 4 complete and reviewed.
Last updated: Aug 16, 2026 — **Phase 5 complete, stopped for review**: AI
provider key vault (Secret Manager, metadata-only settings doc, client
never sees key material), a generation pipeline that assembles context
through the SAME shared conflicts/fulfillment engines the schedule builder
already uses (no reimplementation), a strict JSON contract, real
conflicts-engine validation of every proposed shift (invalid → open shift
with a translated reason), draft-only output with an `aiDraftMeta` banner
(never auto-publishes), a provider interface with real Anthropic/OpenAI/
Google/custom implementations, regenerate-with-instructions (replaces the
prior AI-authored draft, preserves manual edits), and a cost guard (token
usage on the audit entry, rate-limited callable). See "Phase 5 status"
below for the full write-up, including how the entire pipeline was proven
live end-to-end without a real paid API key.

Phases are sequential. Do not build later-phase features early, even scaffolding.

---

## Phase 2 status (spec §19's checklist)

| Item | Status |
| --- | --- |
| Data model + rules (trades, punches, tipReports) | ✅ Done — `firestore.rules`, `src/types/models.ts`, 119 rules tests |
| Trade eligibility engine | ✅ Done — `src/lib/scheduling/tradeEligibility.ts`, spec §7's four conditions, one shared implementation (see below) |
| Direct trades, open pool, manager approvals | ✅ Done — `src/lib/db/trades.ts` (post/cancel, client writes) + `functions/src/tradeActions.ts` (claim/accept/approve/decline, Cloud Functions) |
| Push send infrastructure (server) | ✅ Done — `functions/src/push.ts`; retrofitted onto `schedulePublish.ts` (see below) |
| ZenZap webhook stub | ✅ Done — `functions/src/zenzap.ts`, log-only, called from the pool-drop trigger |
| Pool-drop eligibility-filtered notifications | ✅ Done — `functions/src/tradeTriggers.ts`'s `onTradeCreated` |
| Push client registration (tokens, service worker, permission UX) | ✅ Done — `src/lib/push/registerForPush.ts`, `src/sw.ts` (see below) |
| Shift Pool UI (mockups 16/17) | ✅ Done — `src/pages/shiftPool/*`, wired at `/shift-pool` |
| Geofenced selfie clock in/out + offline queue | ✅ Done — `src/pages/clock/*`, wired at `/clock` |
| Tip report at clock-out | ✅ Done — mockup 22's numpad/confirm/$0-confirm flow, gated on `Employee.tipsRequired` |
| Shifts & Tips admin section | ✅ Done — `src/pages/settings/ShiftsAndTipsPage.tsx`, wired at `/settings/shifts-and-tips` |
| Thursday 23:59 ET availability deadline, enforced server-side | ✅ Done — `functions/src/availabilityActions.ts`, closes the gap Phase 1 deliberately left open (see below) |

---

## Phase 3 status (spec §19's checklist)

| Item | Status |
| --- | --- |
| (a) shiftTemplates Settings UI + builder fulfillment badges | ✅ Done (Aug 15) — see below |
| (b) Task definitions + Cloud Scheduler materialization, folding in the 48h trade-expiry sweep | ✅ Done (Aug 16) — see below |
| (c) Pay periods + payroll workshop (locked FLSA model, generic/Gusto/ADP CSV exports) | ✅ Done (Aug 16) — see below |

### (a) Shift templates + fulfillment badges — Aug 15, 2026

No mockup exists for either the Settings screen or the fulfillment badge —
checked `.superdesign/export/` and `.superdesign/pending/` first, per
CLAUDE.md's rule to check pending prompts before treating something as
undesigned. Neither has anything: mockup 11 (schedule builder) draws no
requirement badge at all, and no `.superdesign/pending/*.json` prompt
mentions "template", "day-part", "fulfil", or "headcount". Both the
Settings page's layout and the badge's visual are new design work within
the existing tokens/components, not a replication of anything.

**`src/lib/scheduling/fulfillment.ts`** (new, 20 unit tests) — the pure
"required vs. covered" engine, deliberately shaped like `conflicts.ts`:
plain data in, typed findings out, no reads/writes/permission checks. Two
decisions worth recording for whoever wires Phase 5's AI scheduler into
this, since spec §13 means to reuse it rather than reimplement:

- **Each requirement line is checked independently against the full pool
  of matching shifts, not a consumed/allocated split.** Spec §6's own
  example — "4 Servers min-L1 with at least one L3" — models naturally as
  TWO lines (`{count:4, minSkillLevel:1}`, `{count:1, minSkillLevel:3}`)
  both checked against the same server shifts; a shift built at L3
  satisfies both bars at once. A bin-packing/consumption algorithm was
  considered and rejected — nothing in the spec or the data model implies
  a shared, decrementing pool, and the independent-line reading is both
  simpler and trivially composable (no cross-line state) for an AI prompt
  builder to consume per-line.
- **Fulfillment counts SLOTS CREATED, not slots STAFFED.** An open shift
  (`employeeId: null`) counts the same as an assigned one; only a
  `cancelled` shift is excluded (`dropped` still counts — it's a real slot,
  just unclaimed). The badge answers "has the builder built enough shift
  cards for this day-part," a different question from "is everyone
  assigned," which the builder's existing Open Shifts row already answers.

**Builder integration**: `useScheduleData` now loads `shiftTemplates` and
exposes `templateFulfillment` (memoized `computeWeekFulfillment` over the
week's own shifts). `DayPartFulfillmentRow` renders one small pill per
template landing on each date (multiple day-parts can share a date, e.g.
Lunch + Dinner), aligned to the header/role-band grid via the shared
`GRID_COLS`; renders nothing when no templates exist yet.

**Settings → Shift templates** (`ShiftTemplatesPage.tsx`, wired at
`/settings/shift-templates`) — day-grouped list (Monday → Sunday, matching
the builder's own week order), create/edit modal with a dynamic
requirement-row editor (role, count, min skill level), plain-confirm
delete (no cross-reference warning needed — unlike a ShiftRole, nothing
else points at a templateId, per `shiftTemplates.ts`'s own doc comment).
**Gated on `schedule.edit`, not `settings.manage`** — checked
`firestore.rules`' `shiftTemplates` match block first and it ties writes to
`schedule.edit`, deliberately different from `shiftRoles`' `settings.manage`
gate (a day-part requirement is a scheduling concern, not a settings one,
even though the page lives under the Settings nav). Getting this gate wrong
would have either locked out managers who build the schedule but lack
`settings.manage`, or let someone edit templates without the edit
permission the rule actually requires — worth flagging since it's an easy
copy-paste mistake from `RolesHierarchyPage`'s `settings.manage` guard.

**Sibling warning on role deactivation** (Rafa's ask): a shiftTemplate
requirement is a straight `roleId` reference, never resolved through
`canCoverRoleIds` the way an actual shift assignment is — so deactivating a
role a template still requires leaves that day-part permanently
unfulfillable, the same class of problem `findInvalidatedShifts` already
guards against for coverage-removal. Added the sibling check,
`findTemplatesRequiringRole()` (`src/lib/scheduling/roleHierarchy.ts`, 4
unit tests, TDD — written failing first, confirmed red, then implemented),
and wired it into `RolesHierarchyPage`'s deactivate button: deactivating a
role now shows a confirm listing every affected template by name before
committing, exactly mirroring `CoveragePanel`'s existing
confirm-with-warning shape for coverage removal.

Verification: `computeWeekFulfillment`/`computeTemplateFulfillment` — 20
new unit tests (TDD, written failing first); `findTemplatesRequiringRole` —
4 new unit tests (also TDD); 175 unit tests total, both builds, 128 rules
tests (unaffected — no `firestore.rules` change was needed, the existing
`shiftTemplates` write rule already gated on `schedule.edit`), i18n parity
(1213 keys), `test:rules:clean` all pass.

Two follow-ups from Rafa's review of the Aug 14 tip-visibility fix (a
hostile-client rules-test trio, and role-change backfill for
`tipReports.employeeAccessRole`) landed just before this phase started —
see "Known issues / cleanup backlog" below for the full writeup, filed
under the original fix rather than duplicated here.

**Three follow-ups from Rafa's 3(a) review, closed before 3(b) started:**
1. **Fulfillment doc comment** — `src/lib/scheduling/fulfillment.ts` now
   states explicitly that a requirement line matches a shift's own `roleId`
   only; `canCoverRoleIds` coverage is never consulted, so Phase 5's prompt
   builder can't misread a coverage-eligible shift of a different role as
   satisfying a requirement.
2. **shiftTemplates rebuilt as 4 profiles** — the 14 hand-tuned per-day
   requirement sets collapsed into weekday (Mon–Thu)/weekend (Fri–Sun) ×
   lunch/dinner, still 14 `shiftTemplates` docs (unchanged shape), approved
   with two additions (On Call Server to weekend dinner, Host to weekday
   dinner). **The Mon–Thu/Fri–Sun day split, and whether Friday lunch is
   really weekday-shaped, are still provisional pending Rafa's confirmation**
   — flagged in `scripts/seed.ts`'s own comment at `TEMPLATE_REQUIREMENTS`.
3. **A second seeded week, Aug 17–23**, staffed as a deliberate mix so the
   builder shows both badge states (and the partial-tooltip render) somewhere
   in the seed without touching week 1's labor-math shifts: every weekend
   day-part is fully met; Wed dinner's host line and Thu dinner's second
   server line are intentionally left unmet/short, each commented at the
   point of omission in `scripts/seed.ts`.

### (b) Tasks + Cloud Scheduler materialization + 48h trade-expiry sweep — Aug 16, 2026

**The 48h trade-expiry ruling was made once already and lost to a `/clear`.**
Restated by Rafa and recorded here so it can't happen again — see "RESOLVED
— 48h direct-trade expiry sweep" under Phase 2's trade-feature write-up
above (search this file for that heading) for the full ruling. Summary: a
dedicated `'expired'` `Trade.status` literal (never
reuses `'declined'`); only `open` direct offers expire, never
`pending-approval`; expiry instant is `min(expiresAt, the shift's own start
instant)`; the offerer is notified (`trade.expired` push). Implemented in
`functions/src/tradeScheduled.ts`'s hourly `sweepExpiredTrades` (same
"hourly, not exact-instant" reasoning as `checkForgottenClockOuts`), using a
new `functions/src/timeHelpers.ts` for the shift-start restaurant-tz instant
math (a deliberate small duplicate of `availabilityHelpers.ts`'s own
two-pass DST resolution, same non-shareable-across-the-build-boundary
reasoning documented there).

**Data model** (`src/types/models.ts`): `TaskDefinition`
(`tasks/{taskDefId}`) and `TaskInstance` (`taskInstances/{instanceId}`) per
spec §3, plus one resolved scope addition beyond the spec text:
`requiresPhoto`, a per-task boolean (mockups 27/28 show a per-task photo-proof
toggle, not spec text) — gated overall by the already-scaffolded
`AppSettings.featureFlags.taskPhotoProof`; if that flag is off, no task's
photo requirement is enforced or shown regardless of this field. Every
`TaskInstance` denormalizes `title`/`titleEs`/`dueRule`/`requiresPhoto`/
`cadence`/`department` from its definition AT MATERIALIZATION TIME (same
reasoning as `TipReport.employeeAccessRole`), which has a real consequence
for the client: `tasks/{taskDefId}` reads are `tasks.manage`-gated
(nobody outside the admin Task Manager ever reads a definition directly),
and `src/lib/db/tasks.ts`'s deactivate-not-delete lifecycle (mirroring
`shiftRoles`, not `shiftTemplates`) exists because `taskInstances` reference
`taskDefId` — a hard delete would orphan history the way a `shiftTemplates`
delete never could.

**Materialization** (`functions/src/tasksScheduled.ts`, three `onSchedule`
functions per spec's exact cadence: `materializeDailyTasks` 4am daily,
`materializeWeeklyTasks` 4am Monday, `materializeMonthlyTasks` 4am the 1st).
Two deliberately different shapes, both load-bearing:
- `role`/`department` assignTo, daily/weekly/monthly cadence: ONE pool
  instance (`assigneeEmployeeId: null`) — spec's "claimable pool tasks for
  their role" describes a single shared task, not one copy per eligible
  person.
- `per-shift` cadence: ONE instance PER matching published shift that day,
  pre-assigned to that shift's own employeeId (shifts with no assignee are
  skipped). A day with three matching Server shifts materializes three
  instances, one per server, each surfacing at that server's own clock-out —
  never a shared pool, unlike the bullet above.

Idempotent by construction: every instance id is deterministic
(`${taskDefId}_${period}[_${employeeId-or-shiftId}]`), and `createMissing()`
reads existing ids first via `db.getAll()` and only writes what's missing —
a rerun (redeploy, manual replay) can never clobber an already-`done`/
`missed` instance. Each function sweeps the PRIOR period's still-`open`
instances of its own cadence(s) to `missed` first (plain ISO-string period
comparison — `"YYYY-MM-DD"`/weekId/`"YYYY-MM"` all sort lexicographically, no
instant math needed), notifying that department's managers per instance
(`task.missed`, a new `PushCategory`, spec §15's "missed tasks (managers)").

**Completion** (`functions/src/taskActions.ts`'s `completeTaskInstance`):
unreachable from a client write — `firestore.rules`' `taskInstances` match
denies create/update/delete unconditionally, same shape as punches/
tipReports. Claims (if the instance is an unclaimed pool one) AND marks done
atomically inside one transaction; a pool claim re-verifies the caller's
actual scope against the LIVE `TaskDefinition` (department or one of the
caller's own `shiftRoles`), never trusted from the client or from
`TaskInstance.department` alone. A `requiresPhoto` instance is rejected
server-side without a `photoPath`, not just hidden in the UI.

**Rules** (`firestore.rules`): `tasks` is `tasks.manage`-gated for both read
and write. `taskInstances` read is `isSelf(assigneeEmployeeId)` OR
`mayViewPoolInstance()` — `tasks.manage` (any department) or `tasks.complete`
+ **still-unclaimed** + a department match, the exact department-broad-list/
precise-action-eligibility split Shift Pool's "Up for grabs" already
established (list visibility is broad and provable; precise role
eligibility is enforced only at the point of action, in
`completeTaskInstance`, never in the list rule).

**A real bug, found by the rules-test pass and fixed before it shipped:**
`mayViewPoolInstance()`'s first draft checked department only — it never
checked `assigneeEmployeeId == null` — so any `tasks.complete` holder
(effectively every employee) could read ANY instance in their own
department, including one already assigned to a named coworker (their
notes, `completedBy`, `photoPath`), not just an unclaimed pool one. Fixed by
adding `isUnclaimedPoolInstance()`, mirroring `trades`' own `mayReadTrade()`
requiring `status == 'open'` before granting a same-department non-party a
read — the exact established precedent this rule should have followed from
the start. `tests/rules/tasks.rules.test.ts` (23 tests) now proves both the
positive case and this specific regression; 152 rules tests total, 0 dirty
denials (16 first-pass `get()` artifacts, was 14 — the 2 new ones are the
`tasks` definitions match block's own write rule, the same harmless
first-pass-evaluation-error shape `firestore.rules`' header already
documents, now exercised for the first time).

**Client** (`src/lib/db/tasks.ts`, `src/lib/db/taskInstances.ts`,
`src/lib/tasks/taskActions.ts`): `listMyTaskInstances(employeeId,
department)` runs two separate list-query-safe queries (assigned-to-me, any
department; unclaimed pool in my department) rather than one combined `OR`,
for the same list-query-provability reason the rule itself is shaped that
way. `listTaskInstancesForPeriod(period)` serves the admin Completion
dashboard's "today" tiles — deliberately not a broader "all instances ever"
query, since a weekly/monthly instance's `period` is never literally
"today" by construction (a weekly task doesn't have a today boolean, only a
this-week one) — the dashboard's "today" tiles are therefore an honest
subset (effectively daily+per-shift cadence), not an all-cadence view; noted
here so it doesn't read as a gap later.

**UI**: Settings → Tasks (`src/pages/settings/TaskManagerPage.tsx`, wired at
`/settings/tasks`, `tasks.manage`-gated) — Definitions/Completion/Archive
tabs per mockup 28 (no mockup exists for Completion's actual content beyond
its three stat tiles' visual style, same "new design work within tokens" class
of decision as 3(a)'s own Settings page). Staff "My Tasks"
(`src/pages/tasks/MyTasksPage.tsx`, wired at `/tasks`, replacing the Phase-0
placeholder) per mockup 27 — progress strip scoped to `period === today`,
list grouped PURELY by cadence (per-shift+daily → Today, weekly → This
Week, monthly → This Month; deliberately not period-filtered, so a `daily`
instance is always a "Today" thing by construction, matching how
materialization itself buckets periods) — these are two DIFFERENT filters
on purpose, not a bug: the progress strip is a bounded daily summary, the
list below it is the full cadence bucket. Clock-out gains a non-blocking
"You have N open tasks" banner (`PunchSuccessScreen.tsx`, spec's exact
wording) — informational only, never blocks clock-out. The bottom-tab/rail
`tasks` badge (`MobileShell`/`DesktopShell`, now `badges`-prop-driven from
`AppShell.tsx` instead of a hardcoded demo dot) shows a real open-count for
the first time — the Phase-0 placeholder's own comment ("no real data
source until Phase 3") is now resolved; Desktop's still-hardcoded `shiftPool`
dot was deliberately left untouched, a separate known gap.

**Seed**: 9 task definitions matching mockup 28's example rows exactly
(`restock-napkins`, `wipe-pos-screens`, `patio-umbrellas`, `walkin-temp-log`,
`bar-mats-rinsed`, `espresso-deep-clean`, `rotate-wine-inventory`,
`grease-trap-check`, `fire-extinguisher-inspection` — the last seeded
`active: false`, matching the mockup's own dimmed row, so the Archive tab
has something real to show). 12 `taskInstances` seeded as a realistic
SPREAD of history across the week (some completed days ago, one missed,
three genuinely still open "today") rather than artificially cramming
everything into one day — a more honest demo of what a Sunday morning
actually looks like than a same-day-only mix would have been. Uses the
exact same deterministic instance-id formula the real materialization
function computes, so a later real Cloud Scheduler run never collides with
seeded data.

**Verified against a live Auth+Firestore+Functions emulator** (real
`httpsCallable`, not admin-SDK shortcuts): signed in as a GM — Settings →
Tasks renders all three tabs correctly (Definitions' 8 active rows, Archive's
1 inactive row, Completion's 3 today-scoped rows/tiles); signed in as a
plain staff member — denied Settings → Tasks outright (access-denied
screen), `/tasks` renders the real "My Tasks" list with a genuine
department-broad-but-role-blind pool item, and attempting to complete a
Bartender-scoped pool task as a Server correctly fails server-side
(`permission-denied`) with a visible toast; signed in as an actual bartender
— claims and completes that same instance successfully, confirmed via a
direct Firestore read (`status: 'done'`, `assigneeEmployeeId`/`completedBy`
set). `npm run build` (client + functions), 175 unit tests, i18n parity
(1317 keys), 152 rules tests, 0 dirty denials all pass. Cloud Function unit
tests were deliberately not written for `tasksScheduled.ts`/`taskActions.ts`/
`tradeScheduled.ts` — these are Firestore-glue, matching this codebase's own
established split (pure algorithmic modules like `fulfillment.ts`/
`tradeEligibility.ts` get committed unit tests; Cloud Function glue gets
live-emulator verification, same as `tradeActions.ts`/`punchActions.ts`
before it, "no committed test file for Cloud Functions in this codebase").

### (c) Payroll: pay periods + Workshop + final service-map rework — Aug 16, 2026

**FLSA engine** (`src/lib/payroll/overtime.ts`, TDD): the spec's own ruled
correctness trap — overtime is per Mon–Sun WORKWEEK, never by summing hours
inside a semimonthly period — is the one piece of this phase built and tested
first. `splitOvertimeForWorkweek` attributes OT by chronological order within
a week (the specific day that crosses the 40h mark is itself split, every day
after is entirely OT); `allocateHoursToPeriod` groups by workweek THEN filters
to a period's dates, never the reverse. The seed proves this against real
data, not just synthetic tests: Marisol Peña works 45h across Aug 17–23,
straddling the Aug 20/21 semimonthly boundary — verified live in the Workshop
UI at **36.0 regular / 0.0 OT** for the Aug 6–20 period and **4.0 regular /
5.0 OT** for Aug 21–Sep 5, summing back to the workweek's true 40 regular / 5
OT split exactly.

**Integer cents** (`src/lib/money.ts`): `Employee.hourlyRate`/`salaryAmount`
stay dollar `number`s (a Phase 0 decision, not reopened) — `dollarsToCents()`
is the ONE place that float is ever read, converting once at the boundary.
Every computation downstream (`computePayrollRow`, the CSV export) is integer
cents; a float reappears only transiently for display/CSV formatting, never
accumulated or fed back into more math. Verified live: Marisol's $16.00/hr ×
36h regular = $576.00 exactly, both in the Workshop table and the exported
CSV.

**Rendering rules** (`src/lib/payroll/payrollRows.ts`): salaried-with-punches
(`clockRequired: true`) shows hours for ACCOUNTABILITY ONLY —
`accountabilityOnly: true`, `hourlyGrossCents` always 0 — pay is the
period-prorated salary, never hours-derived; non-clocking shows no hours at
all, salary only. Salary proration is a general annualize-then-divide
formula (`prorateSalaryToPeriodCents`) so a monthly salary into a semimonthly
period is exactly halved (24/12 periods-per-year, no drift) and a weekly
salary into a biweekly period is exactly doubled, without hardcoding the
semimonthly case specifically.

**`payroll.view` tightened to Owner/GM only** (`src/lib/permissions/
defaults.ts`) — Rafa's ruling: "full sensitive-read trio on payroll reads."
This REMOVES `payroll.view` from Manager's default grant set, a real
tightening of the existing permission matrix, not just a new gate — Manager
keeps `punches.viewAll`/`tips.viewAll` for Shifts & Tips admin (a different,
less sensitive screen) but loses payroll specifically. `firestore.rules`'
`payPeriods` match is a flat `hasPerm('payroll.view')` gate with no
per-document scoping (unlike punches/tipReports/taskInstances — there's no
department/rank concept here, so no list-query-provability complexity either).
23 new rules tests prove the trio: cooperative (owner, GM), hostile (manager,
supervisor, staff all denied read AND write, including a manager holding an
explicit `permissionOverrides` grant succeeding — proving the rule reads
effective permission, not a hardcoded role check), and unconditional
Cloud-Function-only writes on every role including owner. 173 rules tests
total, 0 dirty denials.

**Lock/unlock** (`functions/src/payrollActions.ts`): `lockPayPeriod`
(`payroll.lockPeriod`) and `unlockPayPeriod` — unlock is gated TWICE,
deliberately stricter than the permission key alone: `payroll.lockPeriod` AND
the actor's actual `accessRole` is literally `owner`/`gm` (spec's own text
names "Owner/GM" for unlock specifically), plus a required non-empty reason.
Unlocking returns `status` to `'review'`, not `'open'` — the period was
already reviewed once, and reopening it fully would lose that milestone. Both
write a `period.lock`/`period.unlock` `auditLog` entry. Verified live: locked
Aug 6–20, confirmed `status: 'locked'` + `lockedBy` in Firestore, then
unlocked with a reason, confirmed both audit entries and the `status: 'review'`
transition.

**Locked periods reject punch/tip edits, server-side** (`functions/src/
punchActions.ts`'s `editPunch`/`editTipReport`, via `functions/src/
payrollHelpers.ts`'s `assertPeriodNotLocked`) — checked against BOTH a punch's
current and proposed-new date, so an edit can't dodge the lock by moving a
punch's timestamp into or out of a locked period. **Verified live, not just
unit-tested** (this is Cloud Function behavior, not a firestore.rules
constraint, so it isn't rules-testable — matches this codebase's own
established split): attempted to add an hour to Marisol's Aug 17 punch while
its period was locked — rejected, punch's stored timestamp unchanged
(confirmed via a direct Firestore read), and the admin UI showed "This pay
period is locked. Ask an Owner/GM to unlock it first." (a real gap the
Playwright pass caught and fixed: `shiftsAndTipsShared.ts`'s
`punchErrorMessage` didn't recognize the new `payroll/period-locked` code and
was falling back to a generic "That didn't go through" message — added it to
`KNOWN_PUNCH_ERROR_KEYS` plus the `clock.errors.period-locked` locale key,
en/es).

**Scope decision, not a gap**: this lock only blocks `editPunch`/
`editTipReport`, per the literal ruling ("punch/tip EDITS"). `manualPunch`
(creating a new, possibly-backdated punch) is NOT blocked by a locked period
— someone could still add pay-affecting hours to an already-locked period via
a fresh manual punch. Flagged here for Rafa's awareness rather than silently
expanding scope beyond what was ruled.

**CSV export** (`functions/src/payrollExport.ts`): generic (spec §11's exact
column list), Gusto-shaped, and ADP-shaped variants — **the Gusto/ADP column
names are best-effort, NOT verified against a real account or provider
import spec**, same "illustrative, not real" caveat this file already carries
for mockup 26's numbers; confirm against Rafa's actual accounts before a real
payroll run. Returns CSV text directly in the callable response (no Storage
round-trip — a restaurant this size's payroll is a few dozen rows) for the
client to turn into a downloaded file. Exporting a LOCKED period transitions
`status` to the terminal `'exported'`; exporting an unlocked one stamps
`exportedAt`/`exportedBy`/`exportFileName` informationally without changing
`status`, and the filename gets a `_DRAFT` suffix — verified live: exported
Aug 6–20 while unlocked, got a confirm dialog ("This period isn't locked
yet... Continue?"), downloaded `payroll_2026-08-06_2026-08-20_generic_DRAFT.csv`,
contents checked byte-for-byte correct (only employees with real pay-affecting
activity included, not padded with empty rows).

**Workshop UI** (`src/pages/settings/PayrollWorkshopPage.tsx`, wired at
`/settings/payroll`, `payroll.view`-gated): period selector, per-period AND
per-workweek views from the same underlying row data (both required by
Rafa's ruling), the accountability-only/non-clocking rendering keyed
directly off `PayrollRow` fields rather than re-derived in the UI, lock/unlock
buttons, three-way CSV export with draft-warning, drill-down link to Shifts &
Tips admin. Omits mockup 26's "labor is $X at Y% of $Z in sales" line — there
is no sales/POS data source in this app (spec §20 non-goal), so that figure
can't be shown without fabricating a number.

**Service map — final ruling, supersedes 3(b)'s provisional weekday/weekend
split.** Four profiles with real hours and a distinct Brunch day-part (Rafa's
proposed line-up — server ×2 @L1, host ×1 @L1, barista ×1 @L1, prep-cook ×1
@L1 — accepted without a veto):
- **Weekday Lunch** — Mon–Fri, 11:00–16:00
- **Brunch** — Sat–Sun, 10:00–16:00 (replaces Sat/Sun lunch ENTIRELY — there
  is no Saturday or Sunday lunch template)
- **Weekday-shape Dinner** — Sun–Thu, 16:00–22:00 (Sunday dinner reads as
  weekday-shaped, not weekend)
- **Weekend Dinner** — Fri–Sat, 16:00–23:00

Saturday = Brunch + Weekend Dinner; Sunday = Brunch + Weekday-shape Dinner;
Friday = Weekday Lunch + Weekend Dinner. Still 14 base `shiftTemplates` docs
(2 per day × 7 days), reshaped from 3(b)'s split rather than added to.

**Dated variants — the first on `shiftTemplates`, kept deliberately small**
(`profileKey`/`dateRange`/`seasonLabel` fields, `src/lib/scheduling/
fulfillment.ts`'s `resolveActiveTemplatesForDate`, TDD): a dated variant wins
over its undated base for any date inside its range ("most-specific-match-
wins"); `profileKey` links a base to its variant across the SAME `dayOfWeek`
(required since a single day carries more than one day-part, so `dayOfWeek`
alone can't disambiguate which one a variant overrides). Seasonal extension,
Sept 1–Dec 31 2026, same headcounts as base: Weekday-shape Dinner → 23:00 (5
variant docs, one per Sun–Thu), Weekend Dinner → 24:00 (2 variant docs, Fri/
Sat) — 7 new documents, 21 `shiftTemplates` total. Settings UI gained a small
"Seasonal variant" toggle in the existing create/edit modal (a `profileKey`
select populated from existing templates, not freeform text, so a variant
can't silently target nothing via a typo).

**Reseeded**: week 1 (Aug 10–16) untouched — labor-math reconciliation still
exact to the dollar, confirmed live. Week 2 (Aug 17–23) rebuilt against the
new service map: every weekend day-part met (Fri Weekday Lunch + Weekend
Dinner, Sat Brunch + Weekend Dinner, Sun Brunch), two deliberate weekday gaps
carried forward from 3(b)'s original demo (Wed dinner's host line 0/1 unmet,
Thu dinner's second server line 1/2 partial) — same weekday-dinner profile,
so the same gaps still apply honestly under the new grouping. `payPeriods`
seeded with the two periods bracketing the Aug 20/21 boundary plus two older
ones (`locked`, `exported`) for the Workshop's review history. **A real,
approved extension of what this seed does**: real `punches` documents were
seeded directly for Marisol's OT-proof week — `scripts/seed.ts` had
deliberately never pre-seeded punches before (Aug 14 2026 note: "generated at
runtime"), but nobody was going to manually clock one employee in and out for
a week just to review this feature, the same reasoning that justified
pre-seeding `taskInstances` directly in 3(b).

**Deferred, not gaps** — logged as settled decisions (Rafa's ruling): (a)
data-informed headcount suggestions belong to Phase 5's AI scheduler, never
built into `shiftTemplates`/fulfillment/payroll now, never auto-applied even
then; (b) full YoY/MoM labor analytics needs real sales history, tied to the
future POS/Leah integration spec §20 already excludes from v1. See "✅
Accepted spec deviations" → A4 below for the full writeup.

**Verified against a live Auth+Firestore+Functions emulator**, real
`httpsCallable`, covering the full loop: signed in as Owner — Workshop
renders 23 employees across both period/workweek views with the exact
hand-computed OT split; locked a period, confirmed server state + audit
entry; attempted (and correctly failed) a locked-period punch edit via the
real Shifts & Tips admin UI, confirmed the punch's stored data never changed;
unlocked with a reason, confirmed the `review` transition + audit entry;
exported a draft CSV, confirmed the confirm-dialog, filename, and byte-exact
contents. `npm run build` (client + functions), 211 unit tests, i18n parity
(1401 keys), 173 rules tests, 0 dirty denials all pass.

---

## Payroll amendments — Aug 16, 2026 (post-Phase-3-acceptance, run in parallel with Phase 4)

Two items Rafa raised after accepting Phase 3, explicitly **not blocking**
Phase 4 — both landed before this checkpoint.

**1. Semimonthly period convention recut.** Superseded A3's original
convention (6th–20th / 21st–5th cuts, same pay dates). New ruling: periods
are **calendar 1st–15th and 16th–end-of-month**, pay dates **20th** (for
1–15) and **5th of the following month** (for 16–EOM). `src/lib/payroll/periods.ts`
(new, TDD — 11 tests, explicit month-end edge cases: 28/29/30/31-day
months, February) is the actual source of truth now — pure and
date-agnostic, symlinked into `functions/src/payroll/periods.ts`.
`AppSettings.payPeriod`'s `semimonthlyDays`/comment is now descriptive
only, not load-bearing (nothing in the period-generation path reads it).
`payDateForPeriod()` is wired into the Workshop header and all three CSV
export variants. **`splitOvertimeForWorkweek`/`allocateHoursToPeriod`
needed zero changes** — confirmed date-agnostic exactly as designed,
proven by re-running the OT-boundary proof under the new convention (below).

**2. Bartender on every service (Rafa's ruling).** `bartender ×1 @L2`
added to `WEEKDAY_LUNCH`, `BRUNCH`, and `WEEKDAY_DINNER`'s requirement
arrays (`scripts/seed.ts`). `WEEKEND_DINNER` unchanged — it already carries
`bartender ×2 @L2`. L2 was proposed (solo-coverage argument) and confirmed
by Rafa via `AskUserQuestion`. Side effect, accepted not fixed: week 2's
(Aug 17–23) already-seeded weekday-lunch/brunch/weekday-dinner shifts have
no bartender line, so the new requirement reads UNMET there for every such
day-part — not "fixed" because doing so would mean touching week 2's frozen
shift data.

**3. OT-boundary proof relocated.** Marisol Peña's real-punches OT proof
(5×9h, 45h/week, prep-cook) moved from Aug 17–23 (which no longer straddles
any period boundary under the new 1–15/16-EOM convention — it now falls
entirely inside one period) to **Mon Sept 14 – Fri Sept 18, 2026**, the
first Mon–Sun workweek after Aug 10–23 (both permanently frozen) that
genuinely straddles a 15th/16th boundary. Verified live in the Workshop, not
just unit-tested: the Sept 1–15 period shows **18.0 regular / 0.0 OT**
(Mon+Tue, 18h, workweek cumulative still under 40) and the Sept 16–30
period shows **22.0 regular / 5.0 OT** (Wed+Thu+4h of Fri regular, 5h of
Fri OT) — sums to the workweek's true 40 regular / 5 OT exactly, split
across the new boundary correctly. Pay dates render correctly alongside:
"Pay date: Sep 20, 2026" for the 1–15 period, "Pay date: Oct 5, 2026" for
the 16–30 period.

**Reseeded pay periods**: `2026-07-01` (exported), `2026-07-16` (locked),
`2026-09-01` (open), `2026-09-16` (open) — no Aug period is seeded (Aug
10–23 no longer straddles anything and carries no pay-affecting punches of
its own).

Verified: `npm run typecheck`, `npm run build` (client + functions), 232
unit tests, i18n parity, live Workshop review (both periods, both the
regular/OT split and the payDate line) — all clean.

---

## Phase 4 status (spec §19's checklist)

| Item | Status |
| --- | --- |
| Data model: `policies`, `signatures`, `disciplinaryActions`, `disciplinaryLadder` | ✅ Done |
| `firestore.rules`: disciplinary sensitive trio, policy version-immutability, signature scoping | ✅ Done |
| `issueDisciplinaryAction` + `recordRefusedToSign` Cloud Functions, audited | ✅ Done |
| Mail transport interface + logged local stub | ✅ Done |
| Signature capture → PDF → email, audit-style guarantee | ✅ Done |
| Escalation ladder — pure computation (TDD) | ✅ Done |
| Policy Library UI (admin) + staff read/sign flow | ✅ Done |
| Disciplinary admin UI + signature canvas + profile ladder widget | ✅ Done |
| Rules tests: disciplinary trio, policy immutability, signature scoping | ✅ Done |
| Seed data: sample policies, one disciplinary action, ladder config | ✅ Done |

**Guardrails, as ruled by Rafa, and how each was implemented:**

1. **"Disciplinary = most sensitive class: full trio, strict below-level (no
   peer-file reads), staff read only their own actions/ladder/documents."**
   `disciplinaryActions`/`signatures` deny client create/update/delete
   outright, on every role including Owner (Cloud-Function-only). Reads:
   `isSelf` OR a `discipline.view` holder whose `employeeAccessRole in
   viewableDisciplineRoles(myRole())` — a **membership** check against a
   denormalized field (same list-query-provability pattern established Aug
   14 for `tipReports`, now reused a third time), never a rank comparison,
   since a rank comparison can't be proven for a `list` request. Tested
   tier-by-tier: a peer Manager/GM/Supervisor cannot read another's
   record — confirmed with `assertFails`, not just reasoned about.
   **One deliberate, spec-verified exception**: `viewableDisciplineRoles('owner')`
   includes `'owner'` itself, matching spec §4's "Owners see all" (no
   below-level carve-out for Owner), and mirroring `canAccessSensitive()`'s
   existing Owner bypass everywhere else in this ruleset (compensation, tip
   reports, permission overrides). This was verified against the spec text
   before writing the test, not assumed.
2. **"Issuing actions is a §17 mutation via callable with the audit
   guarantee; refused-to-sign recorded with witness, audited."**
   `issueDisciplinaryAction`/`recordRefusedToSign` (`functions/src/disciplinaryActions.ts`)
   both write a `discipline.issue` `auditLog` entry as a best-effort
   follow-up (never rolling back an already-committed action if the audit
   write fails — `markAuditPending`, same two-step shape as
   `recordScheduleOverride`). A refusal requires a real witness
   `employeeId`, is terminal (no re-issue), and gets the SAME PDF/email
   treatment as a real signature even though no `Signature` document exists
   for it (`pdfStoragePath`/`emailedTo`/`emailedAt`/`emailPending` fields
   live directly on `DisciplinaryAction` for this reason).
3. **"Signature→PDF→email server-side; email gets the audit-style
   guarantee... Build against a mail-transport interface with a logged
   local stub; production transport joins the deploy checklist alongside
   the VAPID key."** `functions/src/mail/transport.ts` (interface) +
   `loggedStubTransport.ts` (dev/emulator default, logs via
   `logger.info`, always "succeeds") + `index.ts` (`getMailTransport()`
   singleton — the one swap point for a real provider later). `submitSignature`
   generates a PDF (`functions/src/hr/pdf.ts`, `pdfkit`) and emails a copy;
   a failed send never rolls back the signature and never silently
   vanishes — it flags `emailPending`/`emailPendingAt` on the record, the
   same `pushPending`/`auditPending` pattern already established for push
   and audit writes. **Added to the deploy checklist below, alongside the
   VAPID key** — no real transport was built or configured this phase.
4. **"Policies versioned and immutable-once-signed: signatures bind to
   exact version text; edits create new versions and resurface signature
   requirements."** `createPolicyVersion` (`src/lib/db/policies.ts`)
   always creates a NEW document (`version: previous.version + 1`) and
   flips only the old version's `isCurrent` to `false` — enforced
   server-side by a `firestore.rules` field-level lock (the `policies`
   update rule allows only `{isCurrent, updatedAt}` to change, nothing
   else, ever). A signature records the exact `policyVersion` it was signed
   against, so an employee who signed v1 shows as needing to re-sign once
   v2 becomes current — automatic, not a separate reminder mechanism.
   **A real rules bug found and fixed** during the rules-test pass: the
   `policies` update rule originally used `request.resource.data.diff(resource.data)`,
   which throws when `resource` is null (a brand-new document, or certain
   denied-create paths) — replaced with explicit per-field equality checks,
   the same idiom `firestore.rules`' own `employees` block already uses for
   exactly this reason. Verified: 239/239 rules tests pass after the fix,
   no behavior change for any already-passing case.
5. **"Escalation ladder is config: thresholds + EN/ES consequence copy in
   `disciplinaryLadder`, profile widget computes from logged actions."**
   `src/lib/hr/disciplinaryLadder.ts`'s `computeLadderPosition` (pure, TDD,
   10 tests) is a single ORDERED ladder, not independent per-type counters:
   each step's `thresholdCount` is the CUMULATIVE count of all
   `issued`/`signed`/`refused-to-sign` actions (never `draft`) at which that
   step's consequence takes effect; `currentStep` is the highest-order step
   reached, `nextStep` the one after. Both `MyProfilePage.tsx` (self) and
   `EmployeeProfilePage.tsx` (viewing a below-level employee, only —
   omitted entirely for a peer/above, not shown as an error) render the
   SAME widget (`DisciplineLadderWidget`) against the SAME computation.
   Verified live: seeded 1-action employee showed "No formal step reached
   yet, next: written warning"; issuing a second action live flipped it to
   "Currently at: Written warning, next: write-up," matching the seeded
   4-step config exactly.
6. **"PDFs and signature flow render in the employee's language where ES
   exists, EN fallback noted on the document."** `submitSignature`
   resolves the employee's own `language`, falls back to English when no
   Spanish policy body exists, and stamps a visible fallback note on the
   generated PDF/read screen rather than silently substituting.

**Two design decisions worth flagging (CLAUDE.md's conflict rule — spec/
ruling wins over mockup where they differ):**

- **Signing a disciplinary action can only happen from the employee's own
  profile.** `submitSignature` throws `hr/not-own-target` for a
  `disciplinaryAction` target unless the caller IS that action's employee —
  an admin session can never complete it on someone else's behalf. The
  admin screen (mockup 31) therefore shows "Awaiting the employee's own
  signature" (no button) for an `issued` action, and offers only "Record
  refused to sign."
- **Mockup 31's "Save as draft" button was omitted** — `issueDisciplinaryAction`
  has no draft-creation path server-side (issuing is the mutation; there is
  no intermediate unsaved state to persist). Mockup's ladder copy claiming
  actions "reset after 12 months" was also NOT implemented (`computeLadderPosition`
  has no time decay) and the placeholder copy was corrected in both locales
  rather than propagate a false claim about real behavior.

**Deliberately out of scope this phase, not gaps:**

- **A "my signed documents" archive** (a list of past signed PDFs on the
  employee's own profile) — `MyProfilePage.tsx`'s existing "My documents"
  card is still Phase-4 scaffolding, unwired to the new `Signature`/PDF
  data. Flagged in that file's own comment. A reasonable, small follow-up:
  the underlying data (`listMySignatures`, `pdfStoragePath`) already
  exists; only the list UI itself doesn't.
- **An admin-side "N unsigned" compliance chip** on the Policy Library list
  (mockup 29 draws one) — not buildable without an admin-facing
  ALL-employees signature listing, which `src/lib/db/signatures.ts`
  deliberately doesn't expose (`listMySignatures(employeeId)` is
  self-scoped only, matching the same per-employee query shape
  `disciplinaryActions` needs for list-query-provability). Extending it was
  out of scope for this pass.
- **Onboarding packets** (spec §12's sub-feature of bundling policies for a
  new hire's first-day signing) — the signature-tracking infrastructure
  built this phase covers most of what it needs, but no dedicated bundling
  UI was built. Smaller follow-on, not attempted this pass.

**Seed data**: 3 `policies` (Employee Handbook and Food Safety & Sanitation
require signature; Attendance & Punctuality does not — all bilingual,
version 1), 1 `disciplinaryActions` doc (Allison Rodriguez, verbal-warning,
`issued`), 1 `disciplinaryLadder` singleton (4 steps: written-warning@2 →
writeup@3 → final-warning@4 → suspension@5, EN/ES consequence copy). The
ladder's specific thresholds/copy are illustrative, matching the
`disciplinaryLadder.test.ts` fixture shape — **confirm the real numbers
with Rafa before relying on them** (see "Open questions" below, replacing
the old placeholder item 4).

**Verified against a live Auth+Firestore+Functions emulator**, real
`httpsCallable`s, covering the full loop end to end: as Denise (GM) —
issued a new written-warning against Allison Rodriguez, ladder widget
updated live (1→2 actions, "Currently at: Written warning, next:
write-up"); used "Record refused to sign" with a witness on that action —
status flipped to `refused-to-sign`, email fired (visible "Emailed to
allison.rodriguez@example.com"). Signed out, signed in as Allison (staff) —
`/settings/discipline` correctly refused ("You don't have access to this");
her own profile showed "Needs your signature" for the older seeded
verbal-warning; drew and submitted a signature via the canvas — status
flipped to `signed`, confirmed from Denise's admin view afterward. Verified
the "Manage in Disciplinary" cross-link preselects the employee. Verified
as Armando (manager) that his below-level employee picker excludes peer
managers/GM/owners, and that a peer manager's profile shows no
"Disciplinary" tab at all. Separately, Policy Library: created a policy as
Denise, created a new version of it (old version collapsed into an
expandable history row); as a staff employee (Micah Lozon), read the
Employee Handbook, signed it, landed on the success receipt, confirmed the
handbook re-sorted into "Signed."

**Full verification gate, run cold immediately before this checkpoint**:
`npm run typecheck`, `npm run build` (client + functions), `npm run
functions:build`, 232 unit tests (16 files), `npm run test:rules:emulated`
(239 rules tests, 8 files, 0 failures), `npm run i18n:check` (1580 keys,
en/es parity) — all clean. Additionally spot-checked live via Playwright
against seeded emulator data: Settings nav correctly shows/hides "Policy
library"/"Discipline" tabs by permission, both new admin routes and the
staff HR hub render with zero console errors, and the Payroll Workshop's
new payDate line + regular/OT split render correctly across the recut
period boundary (see "Payroll amendments" above).

---

## How to review Phase 4

Same emulator+seed setup as prior phases — `npm run emulators` (terminal
1), `npm run seed` (terminal 2), `npm run dev` (terminal 3).

| Route | What to check | Compare against |
| --- | --- | --- |
| `/settings/policies` | As Denise Lasarte (GM): create a policy, then create a new version of it (confirm the old version collapses into an expandable history row, not overwritten) | mockup 29 |
| `/hr` | As any staff member (e.g. Micah Lozon, Allison Rodriguez): see current policies split into "Needs your signature" vs. the rest; read one, sign via the canvas, confirm the success receipt and the re-sort into "Signed" | mockups 30a/30b/30c |
| `/settings/discipline` | As Denise or Armando: pick a below-level employee, issue a disciplinary action, then either sign it as that employee (log in as them) or record a witnessed refusal | mockup 31 |
| `/profile` (any employee with a disciplinary action on file) | "My standing" card: ladder position, next-step consequence text, and a "Review and sign" prompt for any action still `issued` | spec §12's guardrail #5 |
| Below-level boundary | Confirm a peer manager's profile shows NO "Disciplinary" tab at all (not an error state — the tab itself is omitted) | spec §4 |
| `/settings/payroll` | Step through the Sep 1–15 and Sep 16–30 periods; confirm Marisol Peña's regular/OT split sums correctly across the boundary and the payDate line reads Sep 20 / Oct 5 | "Payroll amendments" above |

**Known limits, not gaps** (see "Phase 4 status" above for the full list):
no "my signed documents" archive UI yet (data already exists); no
admin-side "N unsigned" compliance chip (needs a new, out-of-scope
all-employees signature query); no onboarding-packet bundling UI.

**Open item for you**: the seeded 4-step escalation ladder
(written-warning@2 → writeup@3 → final-warning@4 → suspension@5) is
illustrative, matching the test fixture shape, not a number you gave —
confirm the real thresholds/consequence copy before this ladder governs a
real employee. See spec §21 item 4 was tracking this as unresolved;
consider it now built-but-unconfirmed rather than unbuilt.

---

## Phase 5 status (spec §19's checklist)

| Item | Status |
| --- | --- |
| Provider key vault: Secret Manager + metadata-only settings doc | ✅ Done |
| Generation context assembly via the shared conflicts/fulfillment engines | ✅ Done |
| Strict JSON contract + real conflicts-engine validation per shift | ✅ Done |
| Draft-only output, `aiDraftMeta` + banner, never auto-publish | ✅ Done |
| Provider interface: Anthropic/OpenAI/Google/custom implementations | ✅ Done |
| Regenerate-with-instructions through the same validation | ✅ Done |
| Cost guard: token usage on the audit entry, rate-limited callable | ✅ Done |
| Settings → AI providers UI (mockup 34) | ✅ Done |
| Schedule builder AI-draft banner + generate/regenerate UI (mockup 13) | ✅ Done |
| Rules tests: key-vault gating, dev-secret-store lockdown, rate-limit lockdown | ✅ Done |
| Seed data: a demo AI-draft week + a configured-but-inactive provider | ✅ Done |

**Guardrails, as ruled by Rafa, and how each was implemented:**

1. **"Keys via callable into Secret Manager; metadata-only settings doc; client
   never sees key material. Settings UI per mockup 34."** `configureAiProvider`/
   `setActiveAiProvider` (`functions/src/ai/configureProvider.ts`) are the ONLY
   writers of `settings/aiProviders` — `firestore.rules` denies every client
   write on it outright, and a read is gated on `ai.configureKeys` (Owner-only
   by default, per spec §4's own text excluding GM from this specific key —
   confirmed intentional, not a bug, before building against it). The key
   itself is resolved server-side via a `SecretStore` interface
   (`functions/src/ai/secrets.ts`) and NEVER appears in any callable response —
   only `keyLast4` does. **Dev/emulator caveat, matching the mail-transport
   precedent from Phase 4**: there is no Secret Manager emulator, so
   `getSecretStore()` returns `FirestoreDevSecretStore` today (stores the raw
   key in `_devSecrets/{name}`, a collection `firestore.rules` denies to every
   client unconditionally — the client-never-sees-it property still holds, only
   the "real Secret Manager encryption" claim doesn't). `GcpSecretManagerStore`
   is fully written and ready — swapping the constructor in `getSecretStore()`
   is the ONE change needed at deploy time, added to the deploy checklist below
   alongside the VAPID key and the real mail transport.
2. **"Server-side generation assembling context... importing the shared
   eligibility and fulfillment engines — no reimplementation."** `computeWeekFulfillment`/
   `resolveActiveTemplatesForDate` (`src/lib/scheduling/fulfillment.ts`) and
   `findConflicts`/`isAssignable` (`src/lib/scheduling/conflicts.ts`) are
   imported UNMODIFIED into the generation callable — not duplicated. This
   required a new sharing mechanism, since neither module was symlinked into
   `functions/` before this phase (only `tradeEligibility.ts` was): both files
   are now ALSO symlinked at a MIRRORED path under `functions/src/lib/
   scheduling/` (matching their real relative position under `src/lib/
   scheduling/`), alongside a new `functions/src/types/models.ts` symlink —
   `fulfillment.ts`'s own `@/types/models` import was changed to a relative
   `../../types/models` (a bare `@/` alias survives `tsc`'s type-checking but
   is never rewritten in the emitted CommonJS, so it would 404 at runtime in
   functions' plain `tsc`-then-`node` build, which has no bundler). Verified
   empirically, not just reasoned about: built the compiled output and ran
   `require()` against it directly in Node, confirming both `computeWeekFulfillment`
   and `findConflicts` execute correctly from the compiled `functions/lib/`
   tree with real inputs, before writing a single line of the callable itself.
   This mirrored-symlink trick is now available for any future phase needing
   to share a `src/lib/scheduling/*` or `src/types/models.ts`-dependent pure
   module across the build boundary.
3. **"Strict JSON contract; every shift validated by the real conflicts
   engine; invalid → open shift with reason."** `src/lib/ai/contract.ts`'s
   `parseAiResponse` rejects anything that isn't well-formed JSON matching the
   exact `{shifts: [...], rationale: string}` shape (tolerating a markdown code
   fence, a common instruction-following quirk across all three providers) —
   a provider that can't produce valid JSON gets NO draft at all, not a
   partial one. `src/lib/ai/validateShifts.ts`'s `validateGeneratedShifts` then
   runs every syntactically-valid proposed shift through the REAL
   `findConflicts` — "invalid" means BLOCKED (`!isAssignable`), matching the
   conflicts engine's own severity vocabulary exactly: a `warn`-only issue
   (projected overtime, a partial-availability mismatch) is accepted as-is,
   because a human building the schedule by hand is allowed to do the same
   thing with just a visible flag. Only a genuine block demotes a proposed
   assignment to an open shift with a reason — stored as `Shift.aiValidationNote:
   {messageKey, params}` (the SAME shape as `Conflict`), not a pre-rendered
   string, so CLAUDE.md's i18n rule holds even for machine-generated warnings;
   the builder renders it through `t()` exactly like every other conflict
   warning. A proposed (date, roleId) pair with no matching resolved
   requirement line at all is a hallucination, not a validation failure — it
   is DROPPED entirely, never written as a document, since there's no real
   department/skill data to build one from. **A real bug found by the TDD
   pass, not shipped**: the first draft of `validateGeneratedShifts` never set
   a distinct `id` on the candidate shift it builds for `findConflicts` — with
   every candidate AND every stored "other shift" alike carrying `id:
   undefined`, `findConflicts`' own self-exclusion check (`s.id !== shift.id`)
   spuriously matched every comparison as "the same shift," so double-booking
   detection silently never fired at all. Fixed with a synthetic
   `__candidate_${index}__` id before any test ever ran against real
   double-booked input.
4. **"Draft only with aiDraftMeta and banner; publish stays the existing
   audited callable. Never auto-publish."** `generateAiSchedule` refuses to run
   at all against an already-published/republished week (`failed-precondition`)
   and never calls `recordSchedulePublish` or touches `Schedule.status` beyond
   defaulting a brand-new week to `'draft'`. `AiDraftMeta` (provider, model,
   generatedAt, promptSummary, instructions, tokensUsed, invalidShiftCount) is
   written to the schedule doc and rendered in a banner
   (`AiDraftBanner.tsx`) mirroring the existing `auditPending`/`pushPending`
   banner treatment exactly. The banner has NO publish shortcut of its own —
   Publish stays the unmodified `PublishModal`/`canPublish` flow.
5. **"Provider interface with Anthropic/OpenAI/Google implementations,
   active-provider from settings, typed graceful failures."** `LlmProvider`
   (`functions/src/ai/providers/types.ts`) is implemented by real
   `fetch`-based REST calls to each provider's own API (`AnthropicProvider`,
   `OpenAiProvider`, `GoogleProvider`) plus a fourth `CustomProvider` for
   spec's own "other/custom slot" — no heavy SDK dependencies (Node 20's
   global `fetch` was enough), matching this codebase's minimal-dependencies
   habit. **Judgment call, not a spec requirement**: the custom provider
   assumes an OpenAI-compatible `/chat/completions` shape (the closest thing
   to a de facto standard among self-hosted/proxy LLM servers) — confirm with
   Rafa before a real custom integration depends on this. A typed
   `AiProviderError` (`code: 'auth' | 'rate-limit' | 'network' |
   'invalid-response' | 'unknown'`) is thrown by every implementation and
   mapped to a clear `HttpsError` in the callable, never a raw provider stack
   trace reaching the client.
6. **"Regenerate-with-instructions passes manager free-text through the same
   validation."** One callable serves both a fresh generation and a
   regenerate call — the only difference is whether `instructions` is
   present, so a regenerate can never skip a check a fresh generation would
   have run. A NEW field, `Shift.aiGenerated: boolean`, marks every shift a
   generation call created (assigned or open-with-reason alike); a regenerate
   call deletes every still-`draft` shift carrying it BEFORE generating
   fresh, so an instruction like "give Robin Saturday off" can actually UNDO
   a prior AI assignment rather than only ever layering more on top — while a
   manager's own manual edits (never carrying this flag) are always
   preserved. **A real bug found and fixed while building the UI, not shipped**:
   `src/lib/db/schedules.ts`'s `toShift()` never read `aiValidationNote`/
   `aiGenerated` off the Firestore document at all, so every AI-authored shift
   silently lost that data on the way to the client — the whole feature would
   have been inert regardless of how correct the backend was. A second,
   related fix: `ShiftModal.tsx`'s save path now explicitly clears both fields
   when a manager manually edits an AI-flagged shift, matching the fields' own
   documented contract — without it, a manually-corrected shift stayed
   eligible for silent deletion by a later regenerate call.
7. **"Cost guard: token usage logged to the audit entry; rate-limit the
   generation callable."** Every `ai.generate` `auditLog` entry's `after`
   carries `tokensUsed` (input/output) alongside provider/model and
   assigned/open/rejected counts — verified live with REAL numbers from an
   actual HTTP round-trip (see below), not just a hardcoded shape.
   `functions/src/ai/rateLimit.ts` enforces a restaurant-wide (not
   per-employee — the real cost driver is total spend) rolling-window cap via
   a transactional Firestore counter at `settings/aiRateLimit`, denied to
   every client. **The threshold (5 calls / 10 minutes) is a starting guess,
   not a number Rafa gave us** — spec §13 says "rate-limit" without a number;
   flagged below, tune once real usage data exists.

**Proven live, end to end, WITHOUT a real paid API key.** No Anthropic/
OpenAI/Google credentials exist in this environment, so the full generation
pipeline was proven against a REAL HTTP endpoint instead of a stub swapped
into the provider registry: configured the `custom` provider (Settings → AI
providers, as Rafa/Owner) pointing at a throwaway local Node HTTP server
returning a canned-but-shaped OpenAI-compatible response, then used the
schedule builder's real "Regenerate with instructions" box against it. This
exercised the ENTIRE real code path — no test-only backdoor, no mocked
registry entry: real context assembly, a real prompt reaching the real
`fetch` call, real strict-JSON parsing, real conflict validation (which
correctly caught and flagged a genuine double-booking the canned response
introduced), a real batch delete-then-write of the draft's shifts, and a
real audit entry with real token counts (1234 input / 321 output, exactly
what the test server returned). Confirmed via the running UI: the prior
AI-authored Monday shifts were removed, new Friday shifts appeared (one
correctly assigned, two correctly demoted to open with a translated
"Already scheduled 11:00–15:00 that day" reason), the banner updated to
`custom · canned-test-model` with the canned rationale text, and the
`aiScheduling` feature flag / `ai.generateSchedule` permission gating both
held (button absent on a published week; tab/route absent for non-Owner
roles on the separate AI-providers settings page). Zero console errors
throughout. **Still open**: nobody has verified an ACTUAL Anthropic/OpenAI/
Google response survives the pipeline — the request-shaping and
response-parsing code for each is written against each provider's
documented API shape but has never round-tripped against a real key. Confirm
this the first time a real key is entered, per the deploy checklist below.

**Deliberately out of scope this phase, not gaps:**

- **Data-informed headcount suggestions and full labor analytics** — already
  ruled out for Phase 5 specifically in Phase 3(c)'s "Accepted spec
  deviations" A4 (a Phase 5 AI-scheduler capability was named there
  preemptively; it remains a human-reviewed suggestion surfaced in the
  template editor, never built into `shiftTemplates` itself, and this phase
  didn't change that ruling).
- **A live "test connection" button** on the AI providers screen (mockup 34
  draws one) — there is no cheap way to validate a key without spending a
  real token against the real provider, and `connected` already flips to
  `true` automatically the first time a real generation call succeeds, which
  is a more honest signal than a synthetic ping call would be.
- **Per-employee (rather than restaurant-wide) rate limiting** — the actual
  cost driver is total API spend, not who's calling; a per-employee limit
  would be more complex for no real protection this app's scale needs.

**Seed data**: `settings/aiProviders` seeded configured-but-INACTIVE
(Anthropic, model `claude-opus-5`, `keyLast4: 'DEMO'`) with NO value in
`_devSecrets` — a reviewer who activates it and tries to generate gets a
clean, real "could not read secret" failure rather than a fake success, by
design. A third demo week, **Mon Aug 24 – Sun Aug 30, 2026** (verified to
not overlap any frozen week), carries a populated `aiDraftMeta` and 6
`aiGenerated: true` shifts, one demoted to open with a real `aiValidationNote`
(`conflicts.skillTooLow`), for reviewing the draft banner and open-shift
badge without needing to run a real generation first.

**Full verification gate, run cold immediately before this checkpoint**:
`npm run typecheck`, `npm run build` (client + functions), `npm run
functions:build`, 273 unit tests (21 files, +41 for the new `src/lib/ai/*`
pure modules), `npm run test:rules:emulated` (290 rules tests, 9 files, 0
failures, +51 for Phase 5), `npm run i18n:check` (1635 keys, en/es parity) —
all clean. Plus the full live end-to-end pipeline proof described above,
run personally via Playwright against a fresh seed and a real local HTTP
endpoint standing in for a paid provider.

---

## Deploy checklist addition — Phase 5

Added to the existing "Deploy checklist" section below (VAPID key, real
mail transport): **swap `getSecretStore()`'s default** (`functions/src/ai/
secrets.ts`) from `FirestoreDevSecretStore` to the already-written
`GcpSecretManagerStore` before any real API key is ever entered in
production — until that swap happens, "keys are encrypted at rest via
Secret Manager" is not yet true, even though "keys never reach the
browser" already is. Also: **the first real key entered, for any provider,
should be smoke-tested with an actual "Generate with AI" call** before
relying on it — the request/response shaping for each provider is written
against its documented API, not yet proven against a live response (see
"Still open" above). The rate-limit threshold (5 calls / 10 minutes,
`functions/src/ai/rateLimit.ts`) and the `custom` provider's
OpenAI-compatible-endpoint assumption (`functions/src/ai/providers/custom.ts`)
are both judgment calls, not numbers/decisions Rafa gave — confirm both
before they matter for real usage or a real custom integration.

---

## How to review Phase 5

Same emulator+seed setup as prior phases — `npm run emulators` (terminal
1), `npm run seed` (terminal 2), `npm run dev` (terminal 3).

| Route | What to check | Compare against |
| --- | --- | --- |
| `/settings/ai` | As Rafa or Tom (Owner): see the seeded Anthropic card (configured, inactive); add/replace a key for another provider; switch which one is active. As Denise (GM) or any Manager: tab absent, route denied | mockup 34 |
| `/schedule`, week of **Aug 24–30, 2026** | The seeded AI-draft banner (rationale, provider/model, generated-at, "1 shift needs review"); the open bartender shift's AI-flagged badge with its translated reason on hover | mockup 13 |
| `/schedule`, any week | "Generate with AI" button present for a Manager+ on a draft week with NO existing `aiDraftMeta`; absent on an already-published week (e.g. Aug 10–16) or once a draft already exists (use the banner's regenerate box instead) | spec §13 |
| Regenerate flow | Type instructions in the banner's box on the Aug 24–30 week and submit — with the seeded provider inactive/keyless, expect a clean "could not read secret" style failure toast, not a crash; this IS the correct behavior without a real key configured | guardrail #6 |

**Known limits, not gaps** (see "Phase 5 status" above for the full list):
no live "test connection" button; per-employee rate limiting was
deliberately not built; a real provider response has never round-tripped
through this pipeline (only a canned local HTTP stand-in has, proving the
code path but not any specific provider's actual output shape).

**Open items for you**: (1) the custom-provider OpenAI-compatible-endpoint
assumption needs your confirmation before a real custom integration depends
on it; (2) the 5-per-10-minutes rate limit is a placeholder pending real
cost data; (3) swap the dev secret store for real Secret Manager before
deploy, per the checklist above.

---

## How to review Phase 2

Same emulator+seed setup as Phase 0/1 (see "How to run" below) — `nvm use`,
`npm run emulators` (terminal 1), seed (terminal 2), `npm run dev` (terminal 3).
Sign in as a seeded staff member for the self-service surfaces, and as a
manager (e.g. Denise Lasarte, GM, or Armando Hernandez/Robin Leyva, manager)
for the admin ones.

| Route | What to check | Compare against |
| --- | --- | --- |
| `/shift-pool` | Up for grabs, trade requests, my trades; post an open shift, claim it as another staff member, approve as a manager (try both an eligible and a deliberately-ineligible claimant to see the override panel) | mockups 16, 17a/17b |
| `/clock` | Clock in (camera + geolocation permission prompts), clock out with tips, clock out with $0 tips, and — by overriding your browser's location — the geofence-blocked screen | mockups 19–23 |
| `/settings/shifts-and-tips` | Filter/search the punch table, add a manual punch (both a live "right now" one and a backdated pair against a real scheduled shift), edit a punch's time and a tip amount, export CSV | mockups 24, 25, 25b |
| Push notifications | Grant notification permission on first Shift Pool visit; trigger a pool drop from another account and confirm a notification arrives (dev tools → Application → Service Workers to confirm the SW is `activated`) | spec §7, §15 |
| Availability (`/availability`) | Submit before Thursday 23:59 ET — succeeds; after — blocked with the same message as before, now enforced server-side rather than just in the UI | spec §5 |

**Known limits, not gaps** (documented in full below, not silently dropped):
mockup 25's "Auto-closed"/"Outside fence" punch-flag examples can't occur
under this app's actual behavior (forgotten clock-outs are flagged, never
auto-closed; an out-of-geofence live punch is rejected, never created) —
the real flag reasons are `no-scheduled-shift`, `forgotten-clockout`,
`manualBy`, and a client-derived `missing-tip-report`. The manager
"notify employee" checkbox on mockup 24 has no backing behavior and was
left out. The punch edit modal (mockup 25b) shows an hours-only net
change, not a wage delta — `hourlyRate` lives in a separately-gated
private subdoc this admin screen doesn't fetch.

**Open item for you**: `VITE_FIREBASE_VAPID_KEY` in `.env.example` is
still blank — needs a real Web Push certificate key from the Firebase
console (Project Settings → Cloud Messaging → Web Push certificates)
before push works against a real deployment. Everything up to obtaining a
token is built and verified; only this one credential is missing.

**Full verification gate, run cold immediately before this checkpoint**:
`npm run build` (client + functions), 145 unit tests, i18n parity (1168
keys, en/es), 118 rules tests, `test:rules:clean` (0 dirty denials, 14
pre-existing first-pass artifacts — same count as every prior checkpoint
this phase, none new).

---

## Deploy checklist (real Firebase project, not emulators)

Steps required before push notifications / signed-document emails work
against a real deployment — not needed for emulator-based dev/review, only
for the first real deploy:

1. **`VITE_FIREBASE_VAPID_KEY`** (`.env.example` currently blank). Firebase
   console → Project Settings → Cloud Messaging tab → Web Push certificates
   → generate a key pair (or copy the existing one). Paste the public key
   into `.env.local` for that project. Without this, `getToken()`
   (`src/lib/push/registerForPush.ts`) cannot mint a real FCM token — the
   whole push pipeline (server send, ZenZap stub, offline queue) is built
   and verified against the emulator, but a token can't be issued for a
   real deployment until this one credential is filled in.
2. **Real mail transport** (Phase 4). `functions/src/mail/index.ts`'s
   `getMailTransport()` currently always returns `LoggedStubMailTransport`
   (`functions/src/mail/loggedStubTransport.ts`) — it logs the message via
   `logger.info` and reports success, so signed-document/disciplinary-record
   emails never actually leave the box against a real deployment. Swap this
   one factory for a real `MailTransport` implementation (SendGrid, SES,
   Postmark, whatever Rafa picks) before signatures/disciplinary actions are
   used against real employees who expect a real inbox copy. The
   `emailPending` guarantee still holds either way (a real transport's
   failures surface exactly the same as the stub's), but the stub never
   fails, so this gap won't announce itself — it has to be swapped
   deliberately, not discovered by a missing-email complaint.

Other confirm-on-site items (geofence radius/coordinates, selfie retention)
are tracked in "Open questions for Rafa" below, not duplicated here — this
section is specifically for what BLOCKS push from working post-deploy.

**Time clock — server layer.** `src/lib/geofence.ts` (haversine, pure, symlinked
into `functions/src/geofence.ts` the same way as `tradeEligibility.ts`) is
honest about what it proves: it validates the CLAIMED position, not presence
— the selfie is the actual anti-buddy-punching control (`verifySelfieUpload`,
`functions/src/punchHelpers.ts`, confirms a just-uploaded real JPEG sits at
the expected Storage path, checking size, `image/jpeg` content-type, and a
5-minute upload-freshness window — a client can't point at an old selfie).
`insideFence` is computed server-side and is canonical; a GPS `accuracy`
worse than 200m is rejected outright as implausible before the distance
check even runs. `clockIn`/`clockOut`/`manualPunch`
(`functions/src/punchActions.ts`) return typed `punch/*` error codes via
`HttpsError.details.code`, same convention as trades' `TradeErrorCode`
(`src/lib/punchErrors.ts`, symlinked). `manualPunch` is `punches.edit` +
below-level (`canAccessSensitive`), bypasses geofence/selfie by design,
and writes an auditLog entry (`punch.edit`, now added to both `AuditAction`
mirrors).

**Forgotten-clockout sweep** (`functions/src/punchScheduled.ts`,
`checkForgottenClockOuts`, hourly `onSchedule` — the first real cron in this
app) flags a 14h+ still-open punch and notifies managers in the employee's
department (`punch.forgotten`, the newest `PushCategory`) — it NEVER closes
the punch or invents an out-time; that stays a deliberate human decision via
a manual edit once Shifts & Tips admin exists. Needed a new composite index
(`firestore.indexes.json`: `punches` on `type`+`status`+`flagged`+`timestamp`)
since this is an equality-filters-plus-range query, unlike every other punch
query in this codebase, which stays single-collection-equality-only and
therefore index-free.

**Offline queue** (`src/lib/offlineQueue/punchQueue.ts`, using `idb` — the
first IndexedDB code in this app, and a new dependency). The contract: the
selfie blob, geo, accuracy, device timestamp, and (for a tipped clock-out)
the tip amount are all captured ATOMICALLY at the tap, before this module is
ever involved — queuing only ever replays what was captured then, never
re-captures anything at sync time. `timestamp` (the server field) is always
the server's receipt at whatever moment the Function actually runs — for a
queued item that's the SYNC, not the original tap — while `deviceTimestamp`
still reflects the real tap time; `syncedFromOfflineQueue: true` marks the
gap between them so it reads as an explained fact in Shifts & Tips admin, not
a mystery. A rejection that means the state already resolved another way
(already clocked in from another device, geofence settings changed) is
TERMINAL — dropped from the queue rather than retried forever; a genuine
connectivity failure stays queued.

**Verified**: `npm run build`, 145 unit tests (+7 for `geofence.ts`), i18n
parity (955 keys), `functions/tsc --noEmit` + a clean `functions/tsc` build,
119 rules tests (firestore.rules itself untouched this round — no new
client-writable surface; punches/tipReports were already Cloud-Function-only).

**Time clock — the screens** (`src/pages/clock/*`, mockups 19–23, wired at
`/clock`). One component per mockup, orchestrated by `ClockPage.tsx`'s step
machine: home → geofence pre-check (client-side, display-only, per
`geofence.ts`'s own honesty note — the server call still re-verifies
independently either way) → selfie capture (`getUserMedia`, front camera
only, canvas `toBlob` for compression, no gallery fallback) → for a tipped
clock-out, tip numpad → confirm (or the distinct $0-confirm variant,
mockup 22d, not just 22b with "0" typed in) → the FINAL atomic step, where
the complete bundle (selfie blob, geo captured at the pre-check, device
timestamp taken right here, tip amount if applicable) is gathered together
and either submitted live or hipped to `queuePunch()` if offline — matching
the offline queue's own "atomic at the moment the flow actually completes,
never re-captured later" contract exactly. An `online`-event listener drains
the queue and surfaces synced/dropped/still-queued outcomes.

Verified end-to-end against the live emulator suite via Playwright at the
mobile **390×844 viewport**: clock in → clock out with tips → clock out with
$0 tips (checkbox-gated, per mockup 22d) → geofence-blocked (mocked
out-of-range position, with a working "Try again" once back in range) →
offline queue (forced `navigator.onLine = false`, punch queued to
IndexedDB with a "Pending sync" badge, then synced with a toast once back
online). Camera tested via a monkey-patched `getUserMedia` returning a
`canvas.captureStream()` — this environment has no `--use-fake-device`
Playwright flag available.

Two judgment calls worth flagging: mockup 23's "ask a manager" button and
on-duty-manager list is `manualPunch`'s UI (Shifts & Tips admin territory,
not built here) — kept the mockup's own explanatory copy, dropped the
button; the geofence-blocked distance reads in meters, not the mockup's
miles, matching this app's own native geofence unit throughout.

**Shifts & Tips admin — server layer** (`functions/src/punchActions.ts`).
Reviewing mockup 24 ("Add manual punch") while starting this task surfaced a
real gap in `manualPunch` as task 8 shipped it: it only ever used
`serverTimestamp()` ("now"), but the mockup clearly shows a manager entering
SPECIFIC clock-in/clock-out times for a shift the employee never punched at
all — a genuinely backdated pair, not "punch them in right now." Reworked
`manualPunch` to accept `clockIn`/`clockOut` as ISO timestamps (at least one
required); supplying both creates a complete pair — the 'in' punch immediately
`status: 'closed'` — in one call, matching the mockup's single "Add punch"
action exactly rather than requiring two separate calls. `ManualPunchResponse`
is now `{ punchIds: string[] }` (was `{ punchId }`) since a pair-creation call
returns two ids; nothing in the already-shipped clock UI called the old shape
(checked — only comments referenced it), so this was a clean rename, not a
compatibility shim.

Two new callables, both `punches.edit`/`tips.edit` + below-level
(`canAccessSensitive`), both requiring a non-empty reason, both writing an
auditLog entry (`punch.edit`/`tip.edit` — `tip.edit` newly added to the
Functions-side `AuditAction` mirror) and appending to the doc's own
`editHistory`:
- **`editPunch`** — corrects one punch's `timestamp` only; never touches
  `type`/`employeeId`/`shiftId`, matching spec §9's "edit any punch TIME."
  Mockup 25b edits a pair's clock-in and clock-out together in one modal
  with one shared reason — the server stays single-document-per-call
  (matching `editHistory`'s per-document shape); the admin UI calls it twice
  when both sides of a pair changed.
- **`editTipReport`** — edits an existing report's `amount`, OR (passing
  `employeeId`+`date` instead of a `tipReportId`) creates one where none
  exists at all — the resolution for the "missing tip report" flag mockup 25
  shows, which is real now that `manualPunch`'s tip amount was already
  deliberately left optional (task 8's own scoping note, vindicated here).

**Mockup 25 shows two flag states this app's actual behavior can't
produce as designed, both already-approved deviations from task 8, not new
ones**: "Auto-closed" (task 8's `checkForgottenClockOuts` explicitly never
closes a punch, by Rafa's own ruling) and "Outside fence" on a punch that
exists at all (a live self-punch outside the geofence is REJECTED outright,
never created — `verifyGeofence`'s design). The admin UI (next) should
render `flagReason` values that actually occur (`no-scheduled-shift`,
`forgotten-clockout`, plus `manualBy != null` for a manual punch) rather than
the mockup's specific example flag labels — same "mockup is visual
reference, behavior follows spec/rulings" resolution as every other
superseded-mockup note in this file.

**Verified against a live Auth+Firestore+Functions emulator** (real
`httpsCallable`, not admin-SDK shortcuts): all three `manualPunch` shapes
(clock-in only, clock-out only, complete pair), the already-open rejection,
below-level gating, `editPunch`'s timestamp/editHistory/audit-entry
correctness plus its reason-required guard, and `editTipReport`'s both
paths (edit existing, create fresh with `oldAmount: 0`) — 9/9 scenarios.
Also: `npm run build` (client + functions), 145 unit tests, i18n parity
(1064 keys), 119 rules tests (firestore.rules untouched — no new
client-writable surface).

**Shifts & Tips admin — the screen** (`src/pages/settings/ShiftsAndTipsPage.tsx`,
wired at `/settings/shifts-and-tips`, its own Settings sub-nav tab).
Filters (employee/date range/department/search/flagged-only), summary
stats, a table pairing 'in'/'out' punch docs per employee per day (a still-open
punch shows as such, no fabricated hours), CSV export, pagination. Flag
badges render the flag reasons that actually occur under this app's real
behavior (`no-scheduled-shift`, `forgotten-clockout` on a still-open punch,
`manualBy`, and a client-derived `missing-tip-report` case) rather than
mockup 25's superseded "Auto-closed"/"Outside fence" example labels — see
the server-layer note above for why those two specifically can't happen
here. `ManualPunchModal` (mockup 24) has no "notify employee" checkbox —
`manualPunch`'s real contract has no notify parameter and sends no push, so
a control with no backing behavior was left out rather than built as a
no-op. `PunchEditModal` (mockup 25b) shows an HOURS-ONLY net change, not the
mockup's wage delta — `hourlyRate` lives in the separately-gated
`private/compensation` subdoc (spec's own deviation A1) this admin scope
doesn't fetch, so a real wage number wasn't available; showing a fabricated
one would be worse than omitting it.

**A real bug, found by building this screen against the already-shipped
server layer, now fixed**: `manualPunch` was using `todayIsoInRestaurantTz()`
unconditionally for both its shift lookup and its auto-created tip report's
date, even though it legitimately backdates (mockup 24's whole point — a
shift the employee never punched at all, added after the fact). A backdated
pair against a REAL scheduled shift was therefore always wrongly flagged
`no-scheduled-shift`, and its tip report landed on today instead of the
punch's actual date. Fixed: `findTodaysShift` → `findShiftForDate(employeeId, date)`,
and a new `isoDateOf(instant)` helper derives the lookup/tip-report date from
the punch's own `clockIn`/`clockOut` instead. `clockIn`/`clockOut` themselves
were never affected (always live, same-day, correctly still use
"today"). Verified against a live emulator: the exact backdated scenario now
links the real shift (`flagged: false`) and dates the tip report correctly;
confirmed no regression to live `clockIn`'s own same-day shift lookup.

Also verified live against the Auth+Firestore+Functions emulator: manual
punch creates a real pair via the Cloud Function, "add manual clock-out"
completes an open punch, `editPunch`/`editTipReport` actually change a
punch/report and show in `editHistory`, CSV export downloads real correct
content. Full gate re-run after wiring the route: `npm run build`, 145 unit
tests, i18n parity (1168 keys), 119 rules tests.

**Push infrastructure — the whole vertical slice.** `Employee.pushTokens:
PushToken[]` (`{ token, platform, updatedAt }`) is a new, already-self-editable
field — firestore.rules' `employees/{id}` update rule is a FREEZE-list
(`selfEditIsBenign()`), not an allow-list, so a field it doesn't name needs no
rules change at all; confirmed, not touched this round. `PushCategory` is a
closed union (`trade.pool-drop` / `trade.claimed` / `trade.approved` /
`schedule.published` / `schedule.republished`) carried in every FCM payload's
`data`, so Phase 6's notification-preferences screen can filter on data that
already exists.

**Notification strings live in `src/locales/{en,es}.json`'s new `push`
section** — the SAME two files `npm run i18n:check` already diffs, so this
needed zero changes to the checker (825 keys, parity holds). Functions reaches
them via `functions/src/locales -> ../../src/locales`, a directory symlink —
the same trick as `tradeEligibility.ts`, this time proven to also work for a
whole directory, not just one file. One wrinkle the file-symlink didn't have:
`import en from './locales/en.json'` needs `esModuleInterop`, which this
package's `tsconfig.json` doesn't set; `import * as en from './locales/en.json'`
(a namespace import) sidesteps that with no config change. Interpolation is a
small hand-rolled `{{var}}` replace (`push.ts`) — Functions has no
react-i18next runtime. A person's name isn't translated (plain string param);
a role name is (`ShiftRole.name`/`nameEs`) — passed as `{ en, es }` and
resolved per recipient's own `Employee.language`. Dates/times in notification
bodies are deliberately NOT per-recipient-language — a fixed `en-US`-numerals
format (`formatShiftDateLabel`/`formatShiftTime`, `tradeHelpers.ts`) reads
fine bilingually, and localizing it would cost a second timezone-aware pass
per recipient for marginal benefit. Flagged here in case that reads as an
oversight later — it isn't.

**`sendPush()` never throws** (matches `writeAudit`'s contract): reports which
employeeIds it couldn't reach (no token on file, or every token failed), and
prunes any token FCM reports as `registration-token-not-registered`.
`markPushPending()` mirrors `markAuditPending()` — flags the record the push
was ABOUT (`Schedule.pushPending*` / `Trade.pushPending*`, both new fields) so
a gap is durably surfaced, never silently dropped. `ScheduleBuilderPage` grew
a second banner alongside its existing `auditPending` one — same visual
treatment, distinct copy (a missed push isn't a compliance gap).

**Category → call site, and why some transitions send nothing.** Only
`trade.claimed` (claimTrade) and `trade.approved` (approveTrade) are wired
among the four trade callables — `acceptTrade`/`declineTrade` have no
assigned `PushCategory` and deliberately send nothing; spec doesn't call for
a push at either of those moments. Pool drops fire from a NEW Firestore
trigger, `onTradeCreated` (`tradeTriggers.ts`), not a callable — posting a
trade is a plain client write (`src/lib/db/trades.ts`), so there is no
request-path callable to hang the eligibility fan-out off of. The trigger
reuses the exact same `evaluateEligibility()` every other trade transition
calls (factored into `functions/src/tradeHelpers.ts` alongside the other
Firestore glue, so that plumbing isn't duplicated either, even though it
isn't the eligibility ALGORITHM the "one implementation" ruling was about) —
"eligible" for a pool-drop notification means the full spec §7 check, not
merely the coarser same-department visibility `mayReadTrade` grants for
browsing the pool. The ACTOR of a transition is never pushed about their own
action (`excludingActor()`, `tradeActions.ts`), even when they're technically
part of the computed `notifyEmployeeIds` set returned to the client.

**`approveTrade`'s and `schedulePublish`'s per-recipient sends.** Two of the
five notification bodies need content that differs BY RECIPIENT, which
`sendPush()`'s batch call (one shared `params` object) can't express:
`trade.approved`'s "{{approverName}} approved your trade with {{otherName}}"
needs `otherName` flipped depending which side of the trade is reading it, and
`schedule.published`'s "You work {{shiftCount}} shifts this week" needs each
person's own count. Both send one `sendPush()` call per recipient instead of
one batch call for the whole notify set — `schedule.republished`'s copy has no
such per-recipient content and stays a single batch call.

**ZenZap is called from exactly one place: the pool-drop trigger.** Spec §7's
own text names the webhook stub for that specific moment ("A drops shift →
... webhook stub notifyZenZap(payload)"), not every trade/schedule event.
`ZenZapPayload` (the documented integration contract for Tom) types
`eventType` as the full `PushCategory` union so the same stub can be reused
for other events later without a contract change, but nothing else currently
calls it — deliberate, not a gap. `deepLink` uses the existing `/shift-pool`
placeholder route (`src/App.tsx`), which the next task's Shift Pool UI will
fill in.

**Verified**: `npm run build`, 138 unit tests, i18n parity (825 keys),
`functions/tsc --noEmit` and a clean `functions/tsc` build (confirms the
`locales` directory symlink resolves and its JSON lands in `functions/lib/locales/`).
firestore.rules was NOT touched this round — the rules-emulator suite (119
tests) was re-run after the trades-slice commit and holds unchanged; no new
rules-relevant behavior was introduced (pushTokens is already self-editable,
pushPending fields are server-only writes via the admin SDK, which bypasses
rules by design).

**Client push registration.** `src/lib/push/registerForPush.ts`:
`requestAndRegisterPush(employeeId)` (the Allow-button path — requests
Notification permission, registers the SW, `getToken()`, merges into
`employees/{id}.pushTokens` keyed by token so a rotated token on the same
device replaces its predecessor rather than accumulating), plus
`refreshPushTokenIfGranted()` (silent, never prompts) wired to
`usePushForegroundRefresh()` so a token rotating mid-session doesn't go
quietly stale. `PushPermissionPrompt` (`src/components/push/`) is the
in-context ask — mounted (only) from `ShiftPoolPage`, auto-opening once per
employee per device (a `localStorage` gate) on first Shift Pool visit, never
from `AuthProvider`/login.

**`generateSW` → `injectManifest`.** `vite-plugin-pwa`'s `generateSW` mode
can't have custom service-worker code injected, and Firebase Messaging needs
a background handler (`onBackgroundMessage`) inside the SAME service worker
Workbox controls — two SWs can't both cleanly own the root scope. Switched to
`injectManifest` with a hand-written `src/sw.ts` (Workbox precaching +
`firebase/messaging/sw`'s modern ESM API, not the older `importScripts`
approach) — the standard, documented fix for this exact vite-plugin-pwa +
FCM combination, not a novel pattern. Verified via Playwright against both
`npm run dev` and the production build that the SW reaches `activated`
cleanly and the app shell still loads with no console errors.

**Shift Pool UI** (`src/pages/shiftPool/*`, wired at `/shift-pool` in
`src/App.tsx`, replacing the Phase-2 placeholder): "Up for grabs" (pool board,
`listOpenTradesForDepartment`), a manager approval queue split into two tabs
by trade status ("Shift pool requests" = pool claims awaiting sign-off,
"Trade requests" = accepted direct offers awaiting sign-off — mockup 16 draws
four nav items where spec §7's own text describes three; this is the reading
that matches the mockup's own badge counts), "My trades", and the mockup
17a/17b approval modal driven by a LIVE `checkTradeEligibility()` call (never
the trade's stored, possibly-stale `eligibilitySnapshot`) with the
manager-override path (`trades.manualAssign`-gated, required reason,
`approveTrade({overrideReason})`). `src/lib/db/tradeApprovals.ts` is a new
sibling to `trades.ts` (not an edit to it) exposing the one read the existing
layer didn't have: every trade currently awaiting a manager's decision,
regardless of which of the four employee-id fields the reviewing manager is
(none of them — they're not a party to the trade they're reviewing).
`isTradeExpired()` trades render as a non-actionable "Expired" pill rather
than looking live. Verified end-to-end against seeded emulator data via
Playwright: post → claim → approve (clean); a real under-qualified pending
trade correctly failed the live checklist, the override panel produced a
`trade.override` auditLog entry with reason and before/after state; claim
rejection, direct offer + accept, and Spanish rendering all checked.

**Open item for Rafa — `VITE_FIREBASE_VAPID_KEY`.** `.env.example` has this
blank; it's a real Web Push certificate key from the Firebase console
(Project Settings → Cloud Messaging → Web Push certificates) that can't be
fabricated. Push registration works up through obtaining a token in this
environment, but no token can be minted for a real deployment until this key
is filled in. Added to the open-questions list below.

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

**RESOLVED — 48h direct-trade expiry sweep, ruled by Rafa (Aug 2026), enforced
in Phase 3(b).** This ruling was made once already, lost to a `/clear`, and
had to be restated — recorded here so that never happens again: **decisions
that aren't in PROGRESS.md don't exist.**

- A dedicated **`'expired'`** literal was added to `Trade.status` — `declined`
  is never reused for this. The distinction is audit-meaningful: a manager
  reading trade history needs to tell "the recipient actively said no" apart
  from "nobody acted before the window closed."
- The sweep only expires trades in **`open`** status (an unclaimed direct
  offer). **`pending-approval` never expires** via this mechanism — a claimed/
  accepted trade sitting unapproved is a manager-reminder problem, not an
  expiry problem; tracked as a Phase 6 notification item (`trade.awaiting-approval`),
  not built here.
- **Expiry instant = `min(trade.expiresAt, shift start time)`** — a direct
  offer already past its 48h window OR whose shift has already started
  (whichever comes first) is expired. The shift-start half needed a
  restaurant-tz instant computed from the shift's own `date`/`startTime`, the
  same class of computation as `availabilityHelpers.ts`'s deadline math.
- Expired trades **notify the offerer** (`fromEmployeeId` ?? `postedBy`) via a
  new `trade.expired` push category — see `functions/src/tradeScheduled.ts`.

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

---

## Phase 1 status (spec §19's checklist)

| Item | Status |
| --- | --- |
| Availability submission (recurring/temporary) | ✅ Done |
| Requests + glance view | ✅ Done |
| Deadlines & reminders | ✅ Done |
| shiftRoles + role hierarchy settings | ✅ Done (Aug 14) — Settings → Roles & hierarchy, with cycle detection and a confirm-with-warning before a coverage removal strands a published shift |
| shiftTemplates | ✅ Done (Aug 15, Phase 3(a)) — Settings → Shift templates (day-grouped list, create/edit/delete, no mockup existed for this so the layout is new design work) plus a builder fulfillment row (met/unmet badge per day-part) driven by a pure `computeWeekFulfillment` engine — see Phase 3 status below. |
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

### A4. Two Phase-3(c)-adjacent capabilities are deliberately deferred, not gaps

**Ruled by Rafa, Aug 2026**, alongside the Phase 3(c) payroll guardrails and the
final template/service-map rulings — recorded so neither reads as an oversight
later:

- **(a) Data-informed headcount suggestions are a Phase 5 AI-scheduler
  capability, not part of `shiftTemplates`/the fulfillment engine now.** The
  idea — consuming manual weekly labor-projection numbers plus accumulated
  actuals (real hours/sales history once available) to suggest DELTAS to a
  template's headcount requirements — belongs entirely to spec §13's
  generation flow: a suggestion is surfaced in the template editor for a
  human to accept or reject, exactly like an AI-generated schedule draft
  itself, and is **never auto-applied** to a live template. Nothing in
  Phase 3(b)/(a)/(c)'s `shiftTemplates`/fulfillment/payroll work should grow
  a "suggest a headcount" feature of its own before Phase 5 — that would be
  building later-phase functionality early, which CLAUDE.md's hard rules
  already forbid.
- **(b) Full year-over-year / month-over-month labor analytics is post-v1.**
  It needs real sales history to be meaningful (labor % against actual
  revenue, not just the manually-entered weekly projection this app already
  has per spec §16's dashboard card), which requires the POS/Leah
  integration spec §20 explicitly rules out of v1 ("no POS/sales
  integration... no Leah/ERP/ZenZap integration beyond the webhook stub").
  Tracked here as a named future capability, not silently dropped — revisit
  once that integration exists, not before.

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
4. **Exact escalation ladder steps/thresholds — now BUILT but UNCONFIRMED,
   not unbuilt.** Phase 4 seeded an illustrative 4-step ladder
   (written-warning@2 → writeup@3 → final-warning@4 → suspension@5, EN/ES
   copy) matching the test fixture shape, since the mechanism
   (`computeLadderPosition`) needed real numbers to seed against and none
   were given. Confirm the real thresholds/consequence copy in
   `disciplinaryLadder` before this governs a real employee — see Phase 4
   status above.
5. Skill levels fixed at 1–3 — confirm 3 tiers is enough. Now load-bearing: with
   `minSkillLevelToCover` gone, a shift's `requiredSkillLevel` is the *only*
   skill bar in the eligibility check.

New during Phase 0. Ordered by when they block work:

**Before Phase 2 (trades + clock):**

6. **Geofence coordinates are a best-effort geocode** (25.9773, -80.3225) of the
   Miramar address. Confirm on-site alongside §21 item 1.
6b. **`VITE_FIREBASE_VAPID_KEY` is blank in `.env.example`.** A real Web Push
    certificate key from the Firebase console (Project Settings → Cloud
    Messaging → Web Push certificates) — can't be fabricated, and push
    notifications cannot be minted for a real deployment without it. Everything
    up to obtaining a token is built and verified (`src/lib/push/registerForPush.ts`).

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

- **RESOLVED — mockup `25-punches-and-tips-desktop-en.html`'s "Auto-closed"
  and "Outside fence" example flags are superseded by this app's own ruled
  behavior**, confirmed by Rafa (Aug 14, 2026) rather than left as an
  unreconciled visual reference. Neither can occur here on purpose:
  `checkForgottenClockOuts` (`functions/src/punchScheduled.ts`) flags a 14h+
  open punch and notifies managers but NEVER closes it or invents an
  out-time (Rafa's ruling during the clock-flow build — an open punch is
  resolved by a deliberate human edit, not a guess), and a live self-punch
  outside the geofence is REJECTED by `clockIn`/`clockOut` outright and
  never becomes a Firestore document at all (`verifyGeofence`,
  `functions/src/punchHelpers.ts`). **Keep from the mockup:** the table
  layout (date/employee/in/out/hours/tips/flags), the summary stat tiles,
  the flagged-only filter, "Add manual punch"/"Export CSV". **Do not** use
  its two example flag labels as a behavioral reference — the real
  `flagReason` vocabulary is `no-scheduled-shift` and `forgotten-clockout`
  (still open), plus `manualBy`, and the client-derived `missing-tip-report`,
  `backdated` and `offline-synced`/`edited` flags below.

  **Flag-coverage audit, same date.** Checked the admin table's actual flag
  set against the full anomaly surface the `Punch`/`TipReport` model can
  represent: `no-scheduled-shift`, `forgotten-clockout`, and `manualBy`
  (with reason) were already both rendered AND part of the flagged-only
  filter; `missingTipReport` likewise (`shiftsAndTipsShared.ts`'s
  `buildPunchRows`). Three were in the model but NOT surfaced anywhere in
  the UI, a real gap now fixed in `ShiftsAndTipsPage.tsx`:
  `syncedFromOfflineQueue` (task 8's own note had promised this — "surfaced
  as a flag in Shifts & Tips admin" — and it simply wasn't built); any
  edited punch or tip report (`editHistory.length > 0` / `editedBy` set) —
  spec §9's own text calls for "an 'edited' badge," and none existed at the
  table level (only inside the edit modal once already opened); and a new
  derived `backdated` flag for a manual punch whose own recorded time falls
  on a different restaurant-local day than when it was actually created —
  distinct from a same-day manual correction, and not derivable from any
  single stored field, so it's computed client-side by comparing
  `timestamp` against `createdAt`. All three now render as their own badge
  AND count toward the existing single flagged-only toggle, matching the
  other four rather than introducing a separate per-category filter UI —
  if per-flag-type filtering (not just "any flag") turns out to be wanted,
  that's a follow-up, not assumed here.

- **RESOLVED — nobody but a literal Owner could see tip amounts (or any
  non-Owner/GM's punches) in Shifts & Tips admin.** Found by Rafa's
  requested Playwright review pass (Aug 14, 2026): GM Denise Lasarte saw
  Total tips as $0.00, every tipped punch as "—", and a false
  "Missing tip report" flag on every row — the same code path affects
  Manager/Supervisor with `tips.viewAll`/`punches.viewAll`.

  **Root cause, and it is not what it first looked like.** `listPunchesInRange`/
  `listTipReportsInRange` run unfiltered `getDocs()` queries (no `employeeId`
  where-clause — that's the whole point of an admin view). The rules for
  both used a cross-document `get()` (`departmentOfTarget()`/`targetRoleOf()`,
  keyed on `resource.data.employeeId`) to check department/rank. First
  hypothesis was "list-query rules can't use `get()`, full stop" — so
  `department` (`Punch`) and `employeeAccessRole` (`TipReport`) were
  denormalized onto the document at creation time
  (`functions/src/punchActions.ts`) so the rule could read the field
  directly, no `get()`. **That alone didn't fix it** — the same 4 tests
  still failed, one now with a *clean* deny (no `get()` in sight) instead of
  an evaluation error, which meant the "no `get()`" theory was wrong.

  The actual mechanism, confirmed against Firestore's own docs ("security
  rules are not filters"): a `list` request is **all-or-nothing**. Firestore
  evaluates the rule against the query's *potential* result set — using only
  the query's own `where()`-pinned values and the caller's claims, never
  real per-document data — and denies the **entire** request if it can't
  prove every possible match would be allowed. It does not fetch, evaluate
  per-document, and filter down; a single document conceptually not fully
  visible causes the whole query to be visible, so it wouldn't. Any rule
  branch that reads a `resource.data` field the query doesn't constrain
  poisons the whole expression — with or without a `get()` involved. The
  `isSelf(subjectEmployeeId())` branch (present in both rules for the
  legitimate single-document self-read case) was the second half of the
  problem: it reads `resource.data.employeeId`, which neither query
  constrains, so it stayed unprovable regardless of what the admin-viewAll
  branch did.

  **The real fix has two halves, and the rule change alone was never going
  to be enough:**
  1. `firestore.rules`: `punchDepartment() == myDepartment()` needed no
     change to its *shape* — Owner/GM already passed because `ownerOrGm()`
     is a caller-only constant that short-circuits the whole OR regardless
     of `resource.data`. `mayViewTipReport()` DID change: a rank
     *comparison* (`rank(myRole()) > rank(tipReportEmployeeRole())`) can
     never be proven for a list no matter how it's phrased, because its
     truth still varies per document and nothing pins it — so it's now a
     **membership** check (`viewableTipRoles(myRole())`, strictly-below +
     Owner's blanket bypass) instead.
  2. The client (`src/lib/db/punches.ts`, `src/lib/db/tipReports.ts`) now
     adds a `where()` that pins the *exact* field the rule checks, for any
     caller who isn't Owner/GM: `where('department', '==', actor.department)`
     for punches, `where('employeeAccessRole', 'in',
     viewableTipRoles(actor.accessRole))` for tip reports — the identical
     literal set the rule checks membership against
     (`src/lib/permissions/index.ts`'s `viewableTipRoles`, mirrored 1:1 in
     the rule). With the query and the rule pinned to the same values,
     Firestore can prove every possible match satisfies the rule, and the
     list succeeds. Two new composite indexes support these
     (`firestore.indexes.json`: `punches(department,timestamp)`,
     `tipReports(employeeAccessRole,date)`).

  A caller who genuinely lacks `punches.viewAll`/`tips.viewAll` and somehow
  still issues this exact query gets a **denied** request, not an empty
  result — confirmed correct: `list` can't return "empty, but only because I
  filtered out what you can't see," it can only prove-all-or-deny-all. The
  app already treats a permission-denied list as an empty array
  (`isPermissionDenied` catch), and the page itself is gated on holding one
  of those two permissions in the first place, so this is a non-issue in
  practice, not a UX gap to close.

  **Known narrow gap, not fixed:** a caller whose own role is `viewableTipRoles`'d
  *out* of their own admin query (e.g. a tipped Supervisor viewing the same
  screen they're scoped into) won't see their own tip report in this
  particular table — `viewableTipRoles(role)` is strictly-below, so it never
  includes the caller's own role, and Firestore's `in` filter excludes it at
  the query level before the rule's `isSelf()` branch ever gets a chance.
  Not addressed because `tipsRequired` in practice means FOH staff, and
  Supervisor/Manager/GM accounts are not expected to be tipped employees at
  Rosalia's Kitchen — flagging for Rafa in case that assumption is wrong.

  Rules tests updated to match: the four failing `LIST queries` tests in
  `tests/rules/punchesTipsTrades.rules.test.ts` were rewritten to mirror the
  real client query shape (department/role `where()` included) rather than
  a bare `collection()` read, and the two "no permission" cases now assert
  `assertFails` instead of an incorrect "assertSucceeds with empty results"
  expectation. All 125 rules tests + 151 unit tests + both builds +
  `i18n:check` + `test:rules:clean` pass clean.

  **Two follow-up confirmations from Rafa's review (Aug 15, 2026), both
  addressed:**

  1. **"The security property must hold with zero client cooperation."**
     Added 3 tests proving the `where()` clauses are a usability
     requirement (what makes the query *provable*, so it succeeds), not the
     enforcement — a hostile or merely buggy client that skips or pads them
     is denied outright, never handed a leak: a manager WITH
     `punches.viewAll` who omits the `department` `where()` entirely; a
     manager WITH `tips.viewAll` who omits the `employeeAccessRole`
     `where()` entirely; and a manager who pads the `employeeAccessRole
     'in'` array to include their own rank, trying to smuggle a peer's tip
     report through (the padded document still fails
     `mayViewTipReport()`, so Firestore can't prove the widened query and
     denies all of it). All three assert `assertFails`. 128 rules tests
     now pass.

  2. **Role staleness on `tipReports.employeeAccessRole`.** Decided
     **backfill on role change**, not keep-with-documentation — a cheap
     path existed: `onEmployeeRoleChange` (`functions/src/claims.ts`)
     already fires exactly on the promotion/demotion edge to sync custom
     claims, so the same trigger now also rewrites every existing tip
     report's `employeeAccessRole` to the employee's new role
     (`backfillTipReportAccessRole()`, `functions/src/punchActions.ts`,
     batched at Firestore's 500-write limit). Reasoning: the below-level
     rule is about an employee's **current** sensitivity, not the rank they
     happened to hold when a specific report was filed — without backfill,
     a promoted employee's pre-promotion reports would stay visible to
     every newly-equal-rank peer manager **forever**, which is exactly the
     leak the rule exists to prevent. The reverse (a demoted manager's old
     reports staying hidden from a now-authorized peer) fails closed rather
     than leaking, but would silently undercount tip totals for that peer's
     admin view — also worth fixing, and backfill fixes both directions at
     once since it's a single field write, not a peer-only correction.
     Verified live against the functions emulator (not merely reasoned
     about): seeded a staff employee with two historical tip reports plus
     an unrelated decoy on a different employee, promoted the employee to
     manager, confirmed both of their own reports flipped to
     `employeeAccessRole: 'manager'` while the decoy stayed `'staff'`
     untouched, and the trigger's own `role.change` audit entry recorded
     `tipReportsBackfilled: 2`.

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

### RESOLVED — the Thursday 23:59 ET availability deadline (was: "Not enforced in rules")

Rules have no tz database, so "Thursday 23:59 ET" is 03:59Z or 04:59Z depending
on the week — expressible neither by deriving it from the `weekId` string
(`int()` over a client-controlled substring throws on a malformed id) nor by
comparing against a deadline field on the document (the submitting client
would pick its own lock). **Approved as designed (Aug 13, 2026), landed
(Aug 14, 2026)**: `submitAvailability` (`functions/src/availabilityActions.ts`)
is now the ONLY way a submission (or a resubmit while still pending) reaches
Firestore — `firestore.rules`' `availability/{docId}` write grant for a fresh
self-submission is gone entirely (`selfSubmission()`/`idMatchesPayload()`/
`isUnreviewed()` all removed; only `selfWithdrawal()` — deleting a still-open
temporary override, no deadline question — and `mayReview()` remain direct
client writes). The deadline math itself (`isAvailabilityLocked`/
`availabilityDeadlineFor`, real tzdata via `Intl`) is a deliberate small
duplicate in `functions/src/availabilityHelpers.ts`, not a `src/lib/deadlines.ts`
symlink — that file imports `src/lib/format.ts` for `RESTAURANT_TZ`/`weekIdFor`,
which itself imports `src/i18n` (react-i18next bootstrap) at module top level,
which has no business running at a Cloud Function's cold start. Verified
byte-for-byte identical output against `deadlines.test.ts`'s own known values
across both 2026 DST transitions before trusting it.

On-behalf submission (spec §5: "managers with `availability.approve` can
still edit/enter on their behalf" past the deadline) is derived from
IDENTITY — `employeeId !== actor.id` plus holding `availability.approve` —
never from a client-asserted flag; the old client-side `submitAvailability()`
had an `allowAfterDeadline` boolean opt that meant nothing once the deadline
check is server-side (a client can't assert its way past a check it no
longer performs), so it's gone from the client wrapper's signature along
with the equally-meaningless `now` override. `src/lib/db/availability.ts`'s
`submitAvailability()` keeps its name/return type — `MyAvailabilityPage.tsx`,
its one caller, needed zero changes — but is now a thin `httpsCallable`
wrapper translating the Function's `availability/locked` rejection back into
the same `AvailabilityLockedError` the page already catches.

`tests/rules/scheduling.rules.test.ts`'s availability describe block flipped
from proving direct self-submission succeeds to proving it's denied (118
rules tests now, was 119 — one test specifically exercising the now-deleted
`idMatchesPayload()` id/payload-mismatch check was removed rather than left
with a stale comment about a mechanism that no longer exists; its
assertion was already redundant with the flipped tests). Verified against a
live Auth+Firestore+Functions emulator: self-submit before/after the
deadline, recurring's never-locked behavior, manager on-behalf bypassing a
past deadline, a non-manager's on-behalf attempt denied, AND a direct
client `setDoc` attempt denied by rules (confirming the lockdown itself
took effect, not just that the Function works) — 6/6. Also: `npm run build`
(client + functions), 145 unit tests, i18n parity (1168 keys), 118 rules
tests, 0 dirty denials (same 14 pre-existing first-pass artifacts as before —
none new).

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
