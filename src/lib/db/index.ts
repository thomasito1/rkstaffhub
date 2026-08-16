/**
 * Firestore data-access layer.
 *
 * CLAUDE.md: every Firestore read and write in this app goes through one of
 * these modules. Components import from `@/lib/db` and never touch
 * `firebase/firestore` directly — that is what keeps the profile//private
 * split (see db/employees), the permission model and the audit rules in one
 * reviewable place instead of scattered across screens.
 *
 * Later phases add their own module here (punches, trades, tips, tasks,
 * payroll, HR) alongside their firestore.rules block.
 */

export * from './errors'
export * from './employees'
export * from './settings'
export * from './shiftRoles'
export * from './permissions'
export * from './audit'

// Phase 1 — scheduling (spec §5, §6).
export * from './availability'
export * from './schedules'
export * from './shiftTemplates'
export * from './timeOff'

// Phase 2 — trades (spec §7, §17). Claim/accept/approve/decline are Cloud
// Functions, not this module — see src/lib/scheduling/trades.ts.
export * from './trades'
export * from './tradeApprovals'

// Phase 2 — time clock (spec §8). Reads only — clockIn/clockOut/manualPunch/
// editPunch/editTipReport are Cloud Functions, not this module — see
// src/lib/timeClock/punchActions.ts.
export * from './punches'
export * from './tipReports'

// Phase 3(b) — tasks (spec §10). taskInstances is reads only —
// completeTaskInstance is a Cloud Function, see src/lib/tasks/taskActions.ts.
export * from './tasks'
export * from './taskInstances'

// Phase 3(c) — payroll (spec §11). Reads only — lock/unlock/export are
// Cloud Functions, see src/lib/payroll/payrollActions.ts.
export * from './payPeriods'

// Phase 4 — HR: policy library + signatures (spec §12). `policies` writes
// (createPolicyFamily/createPolicyVersion) go straight through this module,
// gated by firestore.rules' `policies.manage` permission — no Cloud Function
// needed for policy CRUD. `signatures` is reads only — submitSignature is a
// Cloud Function, see src/lib/hr/hrActions.ts.
export * from './policies'
export * from './signatures'
export * from './disciplinaryActions'
export * from './disciplinaryLadder'
export * from './disciplinaryActionsAdmin'

// Phase 5 — AI scheduling (spec §13). Metadata only, reads only —
// configureAiProvider/setActiveAiProvider/generateAiSchedule are Cloud
// Functions, see src/lib/ai/aiActions.ts.
export * from './aiSettings'
