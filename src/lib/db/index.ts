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
