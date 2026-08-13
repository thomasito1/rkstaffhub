# Rosalia's Kitchen — Staff Hub (Scheduling, Time Clock, Tips, Payroll, HR)
## Build Specification for Claude Code — v1.0 (Aug 2026)

This document is the single source of truth for building the app. Read it fully before writing code. Where the spec says "v1" vs "later," respect the phasing — do not build later-phase features early.

---

## 1. Overview

A complete staff operations hub for Rosalia's Kitchen (single-location restaurant, Miramar FL, ~35 employees, FOH + BOH). It replaces 7shifts entirely. Core modules:

1. **Auth & Profiles** — multi-method login, employee profiles, granular permissions
2. **Availability** — weekly submission, admin approval, glance view
3. **Scheduling** — role-based weekly schedules, headcounts, skill levels, publish flow
4. **Shift Trades & Open Pool** — skill/role-hierarchy-gated trades, manager approval
5. **Time Clock** — geofenced, selfie-verified clock in/out
6. **Tips** — self-reported total tips at clock-out
7. **Tasks** — recurring per-shift/day/week/month task checklists
8. **Payroll** — hours + tips workshop view, punch/tip adjustments, CSV export (integration later)
9. **HR / Documents** — handbook, policies, onboarding docs, disciplinary ladder, e-signatures with emailed PDF
10. **AI Scheduling Assistant** — drafts optimal schedules from availability + skill rankings + labor targets; human always approves
11. **Settings** — roles, skill hierarchy, permissions matrix, AI provider keys, geofence, feature flags

**Design language:** Mimic 7shifts' look and feel (screenshots provided): light UI, left icon rail navigation, card-based dashboard, color-coded role bands on the schedule grid, teal/red/yellow availability glance grid, labor-cost footer on the schedule. Clean, modern, generous whitespace.

**Stack (fixed, do not substitute):**
- React 18 + Vite, Tailwind CSS
- Firebase: Auth, Firestore, Cloud Storage (selfies, signed PDFs), Cloud Functions (Node), FCM (push), Hosting
- PWA (installable, offline shell, push notifications, safe-area aware)
- react-i18next for EN/ES
- Firestore project: **standalone/new project** — this app does NOT touch the existing Leah/ERP Firestore. Future integration will be done separately by Tom.

---

## 2. Authentication

- **Methods:** Google Sign-In + Email/Password (magic link optional). Phone OTP is scaffolded but behind a feature flag (`auth.phoneOtpEnabled`) — build the UI and linking flow, ship it OFF; enabling it in Firebase console + flipping the flag activates it with no code changes.
- **Account linking:** One employee profile can have multiple sign-in methods linked (Google + email + later phone). Use Firebase `linkWithCredential`. Profile page has a "Login methods" card showing linked methods with add/remove.
- **Invite flow:** Admin creates employee record → system generates an invite (email link). Employee accepts, signs in with any method, and is bound to the employee doc via invite token. Mirrors 7shifts' "Invite accepted on {date}" pattern.
- **Employee number:** Every employee keeps their existing 7shifts punch ID as `employeeNumber` (imported). New hires get the next sequential number. This is the durable cross-system identifier.
- **Session/claims:** Set custom claims (`role`, `employeeId`) via Cloud Function on invite acceptance and role change. Firestore security rules key off claims + the permissions system (see §4).

---

## 3. Data Model (Firestore)

Top-level collections (single restaurant, but include `locationId` fields for future-proofing):

```
employees/{employeeId}
  employeeNumber (string, = 7shifts punch ID)
  firstName, lastName, preferredName, photoUrl
  email, phone, address{street,city,state,zip}, birthday, pronouns
  emergencyContact{name, phone}
  language ("en" | "es")
  accessRole ("owner" | "gm" | "manager" | "supervisor" | "staff")
  department ("FOH" | "BOH" | "Admin")
  status ("active" | "pending" | "inactive" | "archived")   // import archived 7shifts staff as "archived"
  employmentType ("hourly-tipped" | "hourly" | "salaried-weekly" | "salaried-monthly" | "non-clocking")
  clockRequired (bool)          // set person-by-person; salaried can be true (accountability only)
  tipsRequired (bool)           // true for hourly-tipped
  hourlyRate (number|null), salaryAmount (number|null), salaryPeriod ("weekly"|"monthly"|null)
  shiftRoles: [{ roleId, skillLevel (1|2|3), isPrimary }]
  hireDate, terminationDate|null
  authUids: [string]            // linked Firebase auth UIDs
  permissionOverrides: { [permissionKey]: true|false }   // person-level grants/revokes (§4)
  schedulingNotes (string, admin-only)

shiftRoles/{roleId}             // catalog: MOD, Shift Supervisor, Server, On Call Server, Bartender,
                                // Host, Barista, Runner, Expo, Hot Line Cook, Cold Line Cook,
                                // Prep Cook, Dishwasher ... admin-editable
  name, nameEs, department, color, sortOrder, active
  canCoverRoleIds: [roleId]     // role hierarchy: e.g. Bartender.canCover = [Server, Host, Runner]
                                // a Server does NOT list Bartender. Admin edits this in Settings → Roles.

availability/{weekId}_{employeeId}     // weekId = ISO Monday date "2026-08-10"
  employeeId, weekId, type ("recurring" | "temporary")
  days: { mon..sun: { status: "available"|"unavailable"|"partial", from?, to? } }
  status ("pending" | "approved" | "declined"), reviewedBy, reviewedAt, submittedAt

schedules/{weekId}
  weekId, status ("draft" | "published" | "republished")
  publishedAt, publishedBy, laborTargetPct (number|null)
  aiDraftMeta { provider, model, generatedAt, promptSummary } | null

schedules/{weekId}/shifts/{shiftId}
  employeeId | null (null = open shift)
  date, startTime, endTime, roleId, requiredSkillLevel (1|2|3)
  department, station (string|null, e.g. "Bar","Floor","Expo")
  notes, isOnCall (bool)
  status ("draft" | "published" | "traded" | "dropped" | "cancelled")

shiftTemplates/{templateId}     // headcount requirements per day-part used by AI + manual builder
  name (e.g. "Fri Dinner"), dayOfWeek, startTime, endTime
  requirements: [{ roleId, count, minSkillLevel }]

trades/{tradeId}
  type ("direct" | "pool")
  shiftId, weekId, fromEmployeeId, toEmployeeId|null
  status ("open" | "claimed" | "pending-approval" | "approved" | "declined" | "cancelled")
  claimedBy|null, approvedBy|null, timestamps
  eligibilitySnapshot { roleId, requiredSkillLevel }   // computed at creation

timeOff/{requestId}
  employeeId, startDate, endDate, category ("unpaid"|"paid"), reason
  status ("pending"|"approved"|"declined"), reviewedBy, conflicts:[shiftId]

punches/{punchId}
  employeeId, shiftId|null, type ("in"|"out")
  timestamp (server), deviceTimestamp
  geo { lat, lng, accuracy, insideFence (bool) }
  selfieStoragePath (string)
  editedBy|null, editHistory: [{ by, at, oldTimestamp, newTimestamp, reason }]

tipReports/{reportId}
  employeeId, date, shiftId|null, amount (number)   // total tips, self-reported at clock-out
  reportedAt, editedBy|null, editHistory: [...]

tasks/{taskDefId}
  title, titleEs, description, descriptionEs
  cadence ("per-shift" | "daily" | "weekly" | "monthly")
  assignTo { type: "role"|"department"|"employee", ids:[...] }
  dueRule (e.g. "end-of-shift", "by 5pm", "last day of month"), active

taskInstances/{instanceId}
  taskDefId, date/period, assigneeEmployeeId|null (null = anyone in scope claims it)
  status ("open"|"done"|"missed"), completedBy, completedAt, notes, photoPath|null

policies/{policyId}
  title, titleEs, bodyMarkdown, bodyMarkdownEs, version, category
  ("handbook" | "policy" | "onboarding" | "other"), requiresSignature (bool), activeFrom

signatures/{signatureId}
  employeeId, policyId|disciplinaryActionId, signatureImagePath, signedAt
  pdfStoragePath, emailedTo, emailedAt

disciplinaryActions/{actionId}
  employeeId, type ("verbal-warning"|"written-warning"|"writeup"|"final-warning"|"suspension"|"termination-note")
  date, issuedBy, policyRefs:[policyId], narrative
  signatureId|null, status ("draft"|"issued"|"signed"|"refused-to-sign")

disciplinaryLadder/{ladderId}   // configurable escalation roadmap
  steps: [{ order, type, thresholdCount, consequenceText, consequenceTextEs }]
  // e.g. 2 verbal → next is written; 1 written after that → writeup; etc.

payPeriods/{periodId}
  startDate, endDate, status ("open"|"review"|"locked"|"exported")
  exportedAt, exportedBy, exportFileName

settings/app (single doc)
  geofence { lat, lng, radiusMeters }        // default center: 12130 Miramar Pkwy, Miramar FL
  scheduleWeekStart: "monday"
  availabilityDeadline { day: "thursday", time: "23:59" }
  publishDeadline { day: "friday", time: "23:59" }
  laborTargetPct, featureFlags { phoneOtp: false, payrollIntegration: false, ... }

settings/aiProviders (single doc; values stored via Cloud Function → Secret Manager, doc holds metadata only)
  providers: [{ id: "anthropic"|"openai"|"google"|..., label, model, active, keyLastFour, updatedAt }]

permissions/roleDefaults (single doc)       // §4 matrix defaults per accessRole
auditLog/{entryId}                          // who did what, when — every sensitive mutation
```

**Selfie storage:** `punch-selfies/{employeeId}/{yyyy-mm}/{punchId}.jpg`, compressed client-side (~max 800px, jpeg q0.7). Retention: keep 13 months, Cloud Function scheduled cleanup.

---

## 4. Access Roles & Permissions

**Access roles (hierarchy, high→low):** Owner (Superadmin) → GM → Manager → Supervisor → Staff.

**Core rule — "below your level" visibility:** For sensitive data (pay rates, tips of others, disciplinary records, punch editing), a user can only see/act on employees whose accessRole is *strictly below* their own. A Manager cannot see another Manager's salary or disciplinary file; a Supervisor cannot see a Manager's anything sensitive. Owners see all. Implement as a helper `canAccessSensitive(actor, target)` used in both UI and security rules/Functions.

**Permissions matrix:** A `Settings → Permissions` screen renders a grid of permission keys × roles with toggles, editing `permissions/roleDefaults`. Then per-employee overrides (`employee.permissionOverrides`) can grant or revoke individual keys for one person — overrides win over role defaults. Effective permission = `override ?? roleDefault`.

Permission keys (v1 set — build as a typed enum so adding more is trivial):

```
schedule.view          schedule.create        schedule.edit          schedule.publish
availability.viewAll   availability.approve
trades.request         trades.approve         trades.manualAssign
timeclock.punchSelf    punches.viewAll        punches.edit
tips.reportSelf        tips.viewAll           tips.edit
timeoff.request        timeoff.approve
tasks.complete         tasks.manage
payroll.view           payroll.export         payroll.lockPeriod
employees.view         employees.edit         employees.editPay     employees.rankSkills
discipline.view        discipline.issue       policies.manage
settings.manage        permissions.manage     ai.configureKeys      ai.generateSchedule
```

Sensible defaults: Owner = all. GM = all except `settings.manage`-critical items like `ai.configureKeys` (toggleable). Manager = scheduling/availability/trades/punches/tips/timeoff/tasks/discipline for below-level staff, no payroll export, no permissions.manage. Supervisor = schedule.view, availability.viewAll, trades.request, tips.viewAll, tasks.complete/manage-lite. Staff = self-service keys only.

**Department scoping for approvals:** FOH managers approve FOH trades/availability; BOH effectively has no trades. Store `department` on manager and check it in trade approval (Owners/GM bypass).

**Enforcement:** Never trust the client. Every sensitive write goes through a Cloud Function or a Firestore rule that re-derives effective permission. UI hides what you can't do; rules enforce it.

---

## 5. Availability

- Week = **Mon–Sun**. Staff submit **recurring** availability (rolls forward weekly) and **temporary** week-specific overrides (temporary wins for that week) — same model as 7shifts.
- Per day: Available / Not available / Partial (time range).
- **Deadline:** submissions for the following week lock at **Thursday 23:59** (restaurant local time, America/New_York). After the deadline staff see it locked; managers with `availability.approve` can still edit/enter on their behalf.
- Admin views: **Requests list** (pending/approved, filterable — mirror screenshot) and **Glance View** (employee × 7-day grid, teal Available / red Not available / yellow Partial-with-times, Print/Download). Build the glance grid exactly in that style.
- Approval flow: submitted → pending → approved/declined by manager+; declines require a reason shown to the employee.
- Notifications: reminder push Wednesday evening to anyone who hasn't submitted; confirmation on approval/decline.

---

## 6. Scheduling

- **Week view builder** (admin): grid grouped by shift-role color bands (Server = yellow, Bartender = purple, Manager = pink, Shift Lead = green, Host = orange, etc. — admin-configurable colors per role, mirroring the screenshot). Rows = employees grouped under role bands + an **Open Shifts** row per role. Columns = Mon–Sun with date + weather-optional (skip weather in v1).
- Create shift: click a cell → modal with role, station, start/end, required skill level, notes, On-Call toggle. Drag-to-copy and copy-week-from-previous are required conveniences.
- **Headcount + skill requirements** come from `shiftTemplates` (e.g. Friday Dinner needs 4 Servers min-L1 with at least one L3, 2 Bartenders min-L2, 1 Expo...). The builder shows requirement fulfillment per day-part (met / unmet badge).
- **Conflicts engine** (warnings, non-blocking except where noted): scheduling against Not-available (warn), against approved time off (block), double-booking (block), overtime >40h projected (warn), skill level below shift's `requiredSkillLevel` (block unless manager overrides with a logged reason).
- **Labor footer:** per-day and per-week totals — hours, cost (hourly rate × hours; salaried excluded from hourly cost math), and labor % vs. projected sales if a projection number is entered for the week (simple manual input in v1; no POS integration). Mirror the footer in the screenshot (% pill + hrs + $).
- **Publish flow:** Draft → Publish (notifies all scheduled employees, push + in-app). Edits after publish = "republish" with change highlights and targeted notifications only to affected employees. Target cadence: published by **Friday 23:59** for the following Mon–Sun. Show a countdown/deadline banner on the draft.
- **Staff view:** "My Shifts" list + week calendar; day view gantt ("Who's Working") visible to all staff for their department (mirror screenshot).
- **On Call Server:** a real shift-role; renders as a distinct gray band at the bottom of the FOH schedule (as in screenshot). On-call staff get a confirmation push 3 hours before the shift asking them to stand by (manager taps "activate" to convert it to a working shift).

---

## 7. Shift Trades & Open Pool

Eligibility is the heart of this. A trade/claim is **eligible** iff ALL of:

1. **Role coverage:** claimant has the shift's role, OR has a role whose `canCoverRoleIds` includes it (Bartender→Server ok; Server→Bartender never).
2. **Skill level:** claimant's `skillLevel` for that role (or covering role) ≥ shift's `requiredSkillLevel`. A Level-1/2 server can never take a Level-3-required shift; a Level-1 bartender can't take a Level-2-required bar shift.
3. No double-booking / approved-time-off conflict for the claimant.
4. Claimant is active and in the right department.

Managers with `trades.manualAssign` can override eligibility (logged with reason in auditLog).

**Direct trade:** A offers a shift to B → B accepts → goes to `pending-approval` → FOH manager (or GM/Owner) approves/declines. **Open pool:** A drops shift → every eligible employee gets a push notification (PWA push via FCM; also write a webhook stub `notifyZenZap(payload)` Cloud Function that Tom can later wire to Leah/ZenZap — build the stub, log payloads, don't integrate now) → first-come claim → manager approval. Admin dashboard surfaces pending trades as approve/decline cards (mirror the "Items requiring attention" card from the screenshot).

UI: Shift Pool section with tabs — **Requests (badge)** / **Up for grabs** (table: who's offering, role chip, time, department, Take shift button) / **My trades** — mirroring the screenshot.

---

## 8. Time Clock

- **Who clocks:** driven by `employee.clockRequired`, set per person. Hourly (tipped + untipped) → punches drive pay. Salaried with clockRequired=true → punches recorded for accountability only, flagged `payImpact:false` in payroll views. Non-clocking owners/managers → no clock UI.
- **Flow:** Employee opens Clock tab → sees today's shift (if any) → "Clock In" →
  1. **Geofence check:** browser geolocation; must be within `settings.geofence` radius (default 150m around 12130 Miramar Pkwy — admin-adjustable in Settings, with a map preview). If outside: blocked with a friendly message; a manager can perform a manual punch on their behalf (logged).
  2. **Selfie:** front camera capture (getUserMedia), required, no gallery upload. Compressed and uploaded to Storage; punch is created only after upload succeeds (queue + retry if flaky network).
  3. Server timestamp recorded via Cloud Function (never trust device clock; store device time separately for audit).
- **Clock out:** same geofence + selfie, plus — if `tipsRequired` — a **tip report step**: "Enter your total tips for this shift" (numeric, confirm screen). Clock-out completes only after the tip amount is submitted (allow $0 with confirmation).
- Grace/edge cases: punch without scheduled shift allowed but flagged; forgotten clock-out auto-flags after 14h open punch and notifies managers.
- Kiosk-style large buttons, works one-handed, full ES translation.

---

## 9. Shifts & Tips (Admin)

Admin section listing every punch pair + tip report per employee per day:

- Filter by employee, date range, department, flagged-only.
- Edit any punch time or tip amount (requires `punches.edit` / `tips.edit` and below-level access). Every edit stores editHistory {who, when, old, new, reason(required)} and shows an "edited" badge with hover detail.
- Flags surfaced: outside-geofence manual punches, missing selfie, auto-closed punches, missing tip report, punch with no shift.
- Daily totals per employee: hours, tips; weekly rollup.

---

## 10. Tasks

- Task definitions with cadence **per-shift / daily / weekly / monthly**, assigned to a role, department, or specific person; bilingual title/description.
- A Cloud Scheduler function materializes `taskInstances` (daily at 4am for that day's daily + per-shift tasks based on the published schedule; weekly on Monday; monthly on the 1st).
- Staff see "My Tasks" (and claimable pool tasks for their role) on their home screen; check off with optional note/photo. Per-shift tasks surface during clock-out ("You have 2 open tasks") but don't block clock-out — just flag as missed if incomplete by end of day.
- Admin view: completion dashboard by day/person/role, missed-task report. (Keep v1 simple; this is not the ERP task system — no Firestore structure from Leah is shared.)

---

## 11. Payroll (v1 = Workshop + CSV Export)

- **Pay periods:** configurable (default weekly, Mon–Sun to match schedule; support biweekly toggle in settings).
- **Workshop screen:** table per period — employee, employment type, regular hours, OT hours (>40/wk, FL/FLSA 1.5×), hourly rate, gross hourly pay, reported tips (paid via paycheck — include as its own column), salaried amounts (weekly/monthly shown pro-rated per period, punches shown but non-pay-affecting). Inline drill-down to the punch/tip detail (links to §9).
- **Review & lock:** period status open → review → locked (no more punch/tip edits without unlock by Owner/GM, logged).
- **Export:** CSV with columns: employeeNumber, name, type, regularHours, otHours, rate, hourlyGross, tips, salaryAmount, period. Also a Gusto-friendly variant and an ADP-friendly variant of the CSV (column mappings differ — build both as export options).
- **Integration later:** design a `payrollProvider` interface (export is one implementation) so Gusto/ADP API can slot in behind `featureFlags.payrollIntegration`.

---

## 12. HR: Policies, Onboarding & Disciplinary

- **Policy library:** upload/author policies and handbook sections (markdown, EN + ES bodies), versioned. Mark `requiresSignature`.
- **Onboarding packets:** a bundle of policies assigned to a new hire; their profile shows outstanding signatures.
- **Signature flow:** employee reads document in-app → draws signature on canvas → Cloud Function generates a PDF (document text + signature image + name + employeeNumber + timestamp + doc version) → stores PDF in Storage under their profile → **emails a copy to the employee** → record in `signatures`. Same flow for new-policy rollouts ("3 employees haven't signed the new dress code" dashboard chip).
- **Disciplinary actions:** issue verbal warning / written warning / write-up / final / suspension / termination note; attach policy references and narrative; employee signs (or "refused to sign" recorded by manager with witness field). Signed PDF emailed + archived.
- **Escalation ladder (configurable):** `disciplinaryLadder` defines the roadmap, e.g. *2 verbal warnings → next incident = written warning; written + 1 more = write-up; then final warning; then suspension/termination review*. Each employee's profile shows a **progress ladder widget**: which step they're on, what the next occurrence triggers, with dates of each logged action. Staff see their own ladder and their own signed documents (transparency by design); they never see anyone else's.
- **Visibility:** `discipline.view/issue` + below-level rule (§4). Managers can't see other managers' files.

---

## 13. AI Scheduling Assistant

- **Provider settings (Owner/GM with `ai.configureKeys`):** Settings → AI page: add API keys for Anthropic, OpenAI, Google (and an "other/custom" slot). Keys are POSTed to a Cloud Function that stores them in **Google Secret Manager** (never in Firestore, never returned to client; UI shows provider, model picker, last-4, active toggle). One provider marked active.
- **Generation flow:** On a draft week, "Generate with AI" (permission `ai.generateSchedule`) → Cloud Function assembles context: approved availability, time off, shiftTemplates requirements (headcount + min skill per role per day-part), employee shiftRoles + skill levels, hourly rates, labor target %, recent-weeks fairness data (hours distribution), and constraints (no double-booking, respect availability, OT-averse). Calls the active provider's API requesting **strict JSON** (list of shifts: employeeId, date, start, end, roleId). Validate every shift against the conflicts engine; invalid ones become open shifts with a warning list.
- **Output = DRAFT only.** The generated schedule lands in the builder as a draft with an "AI draft" banner + rationale summary. **A human must review and hit Publish. Never auto-publish.** Store `aiDraftMeta` for audit.
- Include a "regenerate with instructions" box ("give Robin Saturday off, heavier bar coverage Friday").

---

## 14. Internationalization (EN/ES) — Non-negotiable from day one

- react-i18next, every string through `t()` from the first component. Two locale files maintained in parallel; CI check fails on missing keys.
- Language: per-user setting (`employee.language`), toggle in profile and on the login screen; persists.
- Dates/times/currency via `Intl` with locale; Spanish uses es-US conventions.
- All notification texts, emails, PDFs (policy PDFs generate in the employee's language when the ES body exists), task titles, role names (`nameEs`), and validation messages are bilingual.

---

## 15. PWA & Mobile Requirements

- Installable PWA: manifest (icons, standalone display), service worker (app-shell caching; punch queue works through brief offline gaps — punches queue and sync, clearly marked "pending sync").
- **Safe areas:** use `viewport-fit=cover` + CSS `env(safe-area-inset-*)` padding on headers, bottom nav, and fixed action buttons so notches, Dynamic Island, status bars, and the iOS home indicator never overlap content. Test at iPhone SE, iPhone 15 Pro, Pixel, and small Android ratios.
- **Push:** FCM web push for: schedule published/republished (affected only), trade offers/claims/approvals, open-pool drops (eligible only), availability reminders (Wed PM), on-call confirmations, time-off decisions, missed tasks (managers). Notification preferences per user (per-category toggles).
- Bottom tab nav on mobile (Home, Schedule, Clock, Tasks, More); left icon rail on desktop (7shifts style).

---

## 16. Dashboard (Admin Home)

Mirror the 7shifts dashboard structure:
- Greeting + tabs (Overview / Who's Working).
- "Items requiring attention" card: pending trades (approve/decline inline), pending time off, pending availability, unsigned policies, flagged punches.
- Labor snapshot card: this week's scheduled hours & cost vs. target % (chart with actual vs. projected once punches accrue).
- Who's Working: day gantt of today's shifts by department.
- Quick actions: view punches today, open schedule, open payroll period.
Staff home: next shift card, clock button, open tasks, my pending trades, announcements (simple admin-posted notices, v1-lite).

---

## 17. Security Rules & Auditing (summary of intent)

- All reads/writes gated by auth; sensitive fields (rates, salaries, discipline, others' tips, others' punches, selfies) readable only when `canAccessSensitive` passes, enforced in rules/Functions — mirror the permission keys server-side.
- Staff can read: own profile (minus schedulingNotes/rates unless we choose to show rate — show own rate: yes), published schedule for their department, own punches/tips/tasks/documents/discipline, open-pool trades they're eligible for.
- `auditLog` entry for: punch/tip edits, permission changes, schedule publish, trade overrides, period lock/unlock, AI key changes, discipline issuance.
- Storage rules: selfies readable only by managers+ (below-level rule) and the owner of the punch; signed PDFs by the employee + authorized admins.

---

## 18. Import (one-time migration from 7shifts)

- CSV import wizard (Owner only): employees (name, email, phone, punch ID → employeeNumber, role, wage, status incl. archived), availability (optional), historical time-off (optional). Dry-run preview → commit. Archived employees import as `status: "archived"` for record-keeping and are excluded from scheduling/eligibility everywhere.
- Cutover plan: go live at the start of a month; run availability + schedule in this app for week 1 of that month onward.

---

## 19. Build Phases (execute in order; each phase ends with a working deploy)

**Phase 0 — Foundation:** Vite+React+Tailwind+PWA scaffold, Firebase project wiring, i18n skeleton (EN/ES), auth (Google+email, account linking, invite flow), employee CRUD + import wizard, access roles, permissions matrix (defaults + per-person overrides), security rules v1, left-rail/bottom-tab shell, profile pages.

**Phase 1 — Availability + Scheduling:** availability submission (recurring/temporary), requests + glance view, deadlines & reminders, shiftRoles + role hierarchy settings, shiftTemplates, schedule builder (grid, conflicts engine, labor footer), publish/republish + notifications, staff schedule views, time-off requests/calendar/blocked days.

**Phase 2 — Trades + Time Clock + Tips:** trade eligibility engine, direct trades, open pool + push + ZenZap webhook stub, manager approvals; geofenced selfie clock in/out with server timestamps and offline queue; tip report at clock-out; Shifts & Tips admin section with edit history.

**Phase 3 — Tasks + Payroll workshop:** task definitions + instance materialization + staff/admin views; pay periods, OT calc, workshop table, lock flow, CSV exports (generic/Gusto/ADP formats).

**Phase 4 — HR hub:** policy library (bilingual, versioned), onboarding packets, signature canvas → PDF generation → email + archive, disciplinary actions + configurable escalation ladder + profile ladder widget.

**Phase 5 — AI scheduling:** provider key management via Secret Manager, generation Function with strict-JSON contract + validation against conflicts engine, AI-draft UX, regenerate-with-instructions.

**Phase 6 — Polish:** dashboard cards, announcements-lite, notification preferences, audit log viewer, print/download views (schedule, glance), accessibility pass, safe-area/device QA, Spanish copy review.

---

## 20. Explicit Non-Goals for v1

- No POS/sales integration (labor % uses a manually entered weekly projection).
- No tip pooling/payout math (team pools democratically outside the app; app only records reported totals).
- No break tracking. No multi-location UI (fields future-proofed only).
- No Gusto/ADP API (CSV only; interface prepared). No SMS OTP live (scaffolded behind flag).
- No Leah/ERP/ZenZap integration beyond the webhook stub. Never touch the existing ERP Firestore.

## 21. Open Items to Confirm During Build (ask Rafa when reached)

1. Geofence radius default 150m — confirm or adjust once tested on-site.
2. Selfie retention 13 months — confirm.
3. Whether staff see their own hourly rate in-app (spec says yes — confirm).
4. Exact escalation ladder steps/thresholds (configurable anyway; need initial values).
5. Pay period: weekly Mon–Sun assumed — confirm before Phase 3.
6. Skill levels fixed at 1–3 — confirm 3 tiers is enough.
