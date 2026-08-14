/**
 * Firestore data model — spec §3.
 *
 * These types are the contract between src/lib/db/* and the UI. Components
 * never query Firestore directly (CLAUDE.md), so every collection shape lives
 * here and every read/write goes through a db module.
 *
 * `locationId` is carried on documents that would need it for a future
 * multi-location build. Spec §20 makes multi-location UI a v1 non-goal — the
 * field is future-proofing only; do NOT build UI against it.
 */

// ── Enums ────────────────────────────────────────────────────────────────────

/**
 * Access role hierarchy, high → low (spec §4).
 *
 * RESOLVED CONFLICT: mockup 33-permissions-matrix shows an "Assistant Mgr"
 * column. That was a design-time invention with no basis in the spec, which
 * enumerates exactly these five roles in both §3 and §4. Assistant Manager is a
 * JOB TITLE, not an access role — Armando Hernandez and Robin Leyva carry
 * accessRole 'manager'. Any narrowing is done with permissionOverrides.
 * Confirmed with Rafa, Aug 2026.
 */
export const ACCESS_ROLES = [
  'owner',
  'gm',
  'manager',
  'supervisor',
  'staff',
] as const
export type AccessRole = (typeof ACCESS_ROLES)[number]

/** Rank for the "below your level" rule (§4). Higher number = more authority. */
export const ACCESS_ROLE_RANK: Record<AccessRole, number> = {
  owner: 5,
  gm: 4,
  manager: 3,
  supervisor: 2,
  staff: 1,
}

export type Department = 'FOH' | 'BOH' | 'Admin'

export type EmployeeStatus = 'active' | 'pending' | 'inactive' | 'archived'

export type EmploymentType =
  | 'hourly-tipped'
  | 'hourly'
  | 'salaried-weekly'
  | 'salaried-monthly'
  | 'non-clocking'

export type SkillLevel = 1 | 2 | 3

export type Language = 'en' | 'es'

// ── employees/{employeeId} ───────────────────────────────────────────────────

export interface EmployeeShiftRole {
  roleId: string
  skillLevel: SkillLevel
  isPrimary: boolean
}

export interface Employee {
  id: string
  /** = the employee's 7shifts punch ID. Durable cross-system key (spec §2). */
  employeeNumber: string
  firstName: string
  lastName: string
  preferredName?: string | null
  photoUrl?: string | null

  email: string
  phone?: string | null
  address?: {
    street: string
    city: string
    state: string
    zip: string
  } | null
  birthday?: string | null
  pronouns?: string | null

  emergencyContact?: { name: string; phone: string } | null

  language: Language
  accessRole: AccessRole
  department: Department
  status: EmployeeStatus
  employmentType: EmploymentType

  /** Set per person. Salaried staff may clock for accountability only (§8). */
  clockRequired: boolean
  /** True for hourly-tipped. Gates the clock-out tip step (§8). */
  tipsRequired: boolean

  hourlyRate: number | null
  salaryAmount: number | null
  salaryPeriod: 'weekly' | 'monthly' | null

  shiftRoles: EmployeeShiftRole[]

  hireDate: string
  terminationDate?: string | null

  /** Linked Firebase auth UIDs — one profile, many sign-in methods (§2). */
  authUids: string[]

  /** Person-level grant/revoke. Overrides win over role defaults (§4). */
  permissionOverrides: Partial<Record<PermissionKey, boolean>>

  /** Admin-only. Never exposed to the employee themselves. */
  schedulingNotes?: string | null

  locationId?: string | null
  createdAt?: unknown
  updatedAt?: unknown
}

// ── shiftRoles/{roleId} ──────────────────────────────────────────────────────

export interface ShiftRole {
  id: string
  name: string
  nameEs: string
  department: Department
  /** Hex. Admin-editable (§6) — render via inline style, not a Tailwind class. */
  color: string
  sortOrder: number
  active: boolean
  /**
   * Role hierarchy (§7.1). Bartender.canCoverRoleIds includes Server/Host/Runner;
   * a Server does NOT list Bartender. Asymmetric by design.
   */
  canCoverRoleIds: string[]
  /**
   * NOTE: there is deliberately no `minSkillLevelToCover` here. Spec §7 gates
   * eligibility with exactly two independent checks: directional coverage via
   * `canCoverRoleIds` (declared on the COVERING role), and the claimant's
   * `skillLevel` for the role being worked being >= the SHIFT's
   * `requiredSkillLevel`. The shift carries the only skill bar. Mockup 32
   * phrases coverage from the opposite direction and is wrong on behavior —
   * see PROGRESS.md "Accepted spec deviations".
   */
}

// ── permissions/roleDefaults ─────────────────────────────────────────────────

/**
 * Permission keys — spec §4 v1 set, as a typed enum so adding more is trivial.
 *
 * RESOLVED CONFLICT: mockup 33 renders invented key names (schedule.ai,
 * punch.view, payroll.run, people.rate, hr.discipline, settings.roles…).
 * Permission keys are BEHAVIOR, so per CLAUDE.md's conflict rule the spec wins.
 * Mockup 33 is a layout reference only — its key labels are not authoritative.
 */
export const PERMISSION_KEYS = [
  'schedule.view',
  'schedule.create',
  'schedule.edit',
  'schedule.publish',
  'availability.viewAll',
  'availability.approve',
  'trades.request',
  'trades.approve',
  'trades.manualAssign',
  'timeclock.punchSelf',
  'punches.viewAll',
  'punches.edit',
  'tips.reportSelf',
  'tips.viewAll',
  'tips.edit',
  'timeoff.request',
  'timeoff.approve',
  'tasks.complete',
  'tasks.manage',
  'payroll.view',
  'payroll.export',
  'payroll.lockPeriod',
  'employees.view',
  'employees.edit',
  'employees.editPay',
  'employees.rankSkills',
  'discipline.view',
  'discipline.issue',
  'policies.manage',
  'settings.manage',
  'permissions.manage',
  'ai.configureKeys',
  'ai.generateSchedule',
] as const

export type PermissionKey = (typeof PERMISSION_KEYS)[number]

export type RoleDefaults = Record<AccessRole, Partial<Record<PermissionKey, boolean>>>

export interface RoleDefaultsDoc {
  defaults: RoleDefaults
  updatedAt?: unknown
  updatedBy?: string
}

// ── settings/app ─────────────────────────────────────────────────────────────

export interface FeatureFlags {
  phoneOtp: boolean
  payrollIntegration: boolean
  aiScheduling: boolean
  taskPhotoProof: boolean
}

export interface AppSettings {
  geofence: { lat: number; lng: number; radiusMeters: number }
  scheduleWeekStart: 'monday'
  availabilityDeadline: { day: string; time: string }
  publishDeadline: { day: string; time: string }
  laborTargetPct: number | null
  /**
   * Configurable per spec §11. Default is semimonthly on the 5th and 20th.
   * `startDay` still anchors the schedule week (always Mon–Sun) and the
   * weekly/biweekly modes; `semimonthlyDays` applies only when frequency is
   * 'semimonthly'.
   *
   * WARNING (Phase 3): FLSA overtime is per WORKWEEK (>40 hrs Mon–Sun). A
   * semimonthly period contains partial workweeks at both ends, so OT must be
   * computed per workweek and then allocated to periods — never by summing
   * hours inside a period.
   */
  payPeriod: {
    frequency: 'weekly' | 'biweekly' | 'semimonthly'
    startDay: string
    semimonthlyDays?: [number, number]
  }
  featureFlags: FeatureFlags
  restaurant: {
    name: string
    address: string
    timezone: string
  }
}

// ── auditLog/{entryId} ───────────────────────────────────────────────────────

export type AuditAction =
  | 'punch.edit'
  | 'tip.edit'
  | 'permission.change'
  | 'schedule.publish'
  | 'schedule.override'
  | 'trade.override'
  | 'period.lock'
  | 'period.unlock'
  | 'ai.keyChange'
  | 'discipline.issue'
  | 'employee.import'

// 'schedule.override' vs 'trade.override': both are a manager overriding a
// blocked assignment with a logged reason, but at different moments. §6's
// skill-floor override happens while BUILDING the schedule (an admin assigns
// someone below the shift's requiredSkillLevel). §7's trade override happens
// later, when a shift already belongs to someone and a trade/claim would move
// it to a person who fails eligibility. Same shape, different `targetType` and
// different permission gate (`schedule.edit` vs `trades.manualAssign`), so
// they get separate audit actions rather than one ambiguous entry type.

export interface AuditEntry {
  id: string
  action: AuditAction
  actorEmployeeId: string
  actorUid: string
  targetType: string
  targetId: string
  reason?: string | null
  before?: unknown
  after?: unknown
  at: unknown
}

// ── invites/{inviteId} ───────────────────────────────────────────────────────

export interface Invite {
  id: string
  employeeId: string
  email: string
  token: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  createdAt: unknown
  createdBy: string
  acceptedAt?: unknown | null
  expiresAt: unknown
}

// ── availability/{weekId}_{employeeId} ───────────────────────────────────────

/**
 * Day keys for the availability grid. Mon–Sun, matching the spec §3 `days` map
 * and the Mon-start week (§5). Used as an ordered tuple so the glance grid and
 * the effective-availability merge iterate in display order.
 */
export const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number]

export type AvailabilityDayStatus = 'available' | 'unavailable' | 'partial'

/**
 * One day of an availability submission. `from`/`to` are "HH:mm" in restaurant
 * local time and are only meaningful when status is 'partial' (spec §5).
 */
export interface AvailabilityDay {
  status: AvailabilityDayStatus
  from?: string | null
  to?: string | null
}

/**
 * 'recurring' rolls forward week over week; 'temporary' is a week-specific
 * override that WINS for that week only (spec §5, same model as 7shifts).
 * Resolution lives in db/availability.ts → resolveEffectiveAvailability().
 */
export type AvailabilityType = 'recurring' | 'temporary'

export type AvailabilityStatus = 'pending' | 'approved' | 'declined'

export interface Availability {
  /** Document id — `{weekId}_{employeeId}` (spec §3). */
  id: string
  employeeId: string
  /**
   * ISO Monday of the week this covers, e.g. "2026-08-10" — or the sentinel
   * `RECURRING_WEEK_ID` for the rolling baseline, which by definition belongs
   * to no single week. See the header of db/availability.ts.
   */
  weekId: string
  type: AvailabilityType
  days: Record<WeekdayKey, AvailabilityDay>
  status: AvailabilityStatus
  reviewedBy?: string | null
  reviewedAt?: unknown
  submittedAt?: unknown
  /**
   * Spec §5: "declines require a reason shown to the employee". The §3 field
   * list does not name the field, so it is stored here and is REQUIRED by
   * declineAvailability() — a decline with no reason is rejected client-side.
   */
  declineReason?: string | null
  locationId?: string | null
  createdAt?: unknown
  updatedAt?: unknown
}

// ── schedules/{weekId} ───────────────────────────────────────────────────────

export type ScheduleStatus = 'draft' | 'published' | 'republished'

/** Provenance for an AI-generated draft (spec §13). Metadata only — no keys. */
export interface AiDraftMeta {
  provider: string
  model: string
  generatedAt: unknown
  promptSummary: string
}

export interface Schedule {
  /** Document id — the weekId itself (spec §3). */
  id: string
  weekId: string
  status: ScheduleStatus
  publishedAt?: unknown
  publishedBy?: string | null
  /** Falls back to settings/app.laborTargetPct when null (§6 labor footer). */
  laborTargetPct: number | null
  aiDraftMeta: AiDraftMeta | null
  locationId?: string | null
  /**
   * Set by the server when its §17 auditLog write failed after this record's
   * own mutation already committed (both attempts — see functions/src/audit.ts
   * `writeAudit`/`markAuditPending`). The mutation itself is NOT rolled back;
   * this only means the audit trail for it needs a human to reconcile. An
   * audit entry may be late, it must never be silently missing.
   */
  auditPending?: boolean
  auditPendingAction?: AuditAction
  auditPendingAt?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

// ── schedules/{weekId}/shifts/{shiftId} ──────────────────────────────────────

export type ShiftStatus = 'draft' | 'published' | 'traded' | 'dropped' | 'cancelled'

export interface Shift {
  id: string
  /**
   * Parent key, denormalised onto the logical record. The document lives at
   * schedules/{weekId}/shifts/{shiftId}, so this is never stored redundantly —
   * db/schedules.ts fills it from the path on read and on write.
   */
  weekId: string
  /** null = OPEN SHIFT — the unassigned row per role in the builder (§6). */
  employeeId: string | null
  /** "YYYY-MM-DD" in restaurant local time. */
  date: string
  /** "HH:mm" 24h, restaurant local time. */
  startTime: string
  endTime: string
  roleId: string
  /** The only skill bar in the system — see the ShiftRole note above (§7). */
  requiredSkillLevel: SkillLevel
  department: Department
  /** e.g. "Bar", "Floor", "Expo". */
  station: string | null
  notes?: string | null
  /** On-Call Server renders as its own band at the bottom of FOH (§6). */
  isOnCall: boolean
  status: ShiftStatus
  locationId?: string | null
  /**
   * Set true by any edit to a shift that is already live (published or
   * republished) — a time change, a reassignment, an override. Republish
   * reads this alongside `status === 'draft'` to find every shift that
   * changed since the last publish, not just newly-added ones (spec §6).
   * Cleared back to false by `recordSchedulePublish` once it has counted
   * and notified for it.
   */
  dirtySincePublish?: boolean
  /** See the matching note on `Schedule.auditPending`. */
  auditPending?: boolean
  auditPendingAction?: AuditAction
  auditPendingAt?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

// ── shiftTemplates/{templateId} ──────────────────────────────────────────────

/** "4 Servers, min level 1" — one line of a day-part's headcount need (§6). */
export interface ShiftTemplateRequirement {
  roleId: string
  count: number
  minSkillLevel: SkillLevel
}

export interface ShiftTemplate {
  id: string
  /** e.g. "Fri Dinner". */
  name: string
  /**
   * Spec §3 says `dayOfWeek` without fixing an encoding. Stored as the same
   * 'mon'..'sun' key the availability grid uses, deliberately: a numeric day
   * would reintroduce the 0-vs-1 Sunday ambiguity across a Mon-start week.
   */
  dayOfWeek: WeekdayKey
  /** "HH:mm" 24h, restaurant local time. */
  startTime: string
  endTime: string
  requirements: ShiftTemplateRequirement[]
  locationId?: string | null
  createdAt?: unknown
  updatedAt?: unknown
}

// ── timeOff/{requestId} ──────────────────────────────────────────────────────

export type TimeOffCategory = 'unpaid' | 'paid'

export type TimeOffStatus = 'pending' | 'approved' | 'declined'

export interface TimeOffRequest {
  id: string
  employeeId: string
  /** Inclusive "YYYY-MM-DD" bounds. */
  startDate: string
  endDate: string
  category: TimeOffCategory
  reason: string
  status: TimeOffStatus
  reviewedBy?: string | null
  reviewedAt?: unknown
  /**
   * Shift ids that overlap the requested range, computed at request time by
   * findConflictingShifts(). Approved time off BLOCKS scheduling (§6 conflicts
   * engine), so an approver sees exactly what they are about to break.
   */
  conflicts: string[]
  declineReason?: string | null
  locationId?: string | null
  createdAt?: unknown
  updatedAt?: unknown
}
