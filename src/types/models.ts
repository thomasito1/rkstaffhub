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
  /** Minimum skill level required to cover into this role. */
  minSkillLevelToCover?: SkillLevel
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
  payPeriod: { frequency: 'weekly' | 'biweekly'; startDay: string }
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
  | 'trade.override'
  | 'period.lock'
  | 'period.unlock'
  | 'ai.keyChange'
  | 'discipline.issue'
  | 'employee.import'

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
