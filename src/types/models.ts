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
  /** FCM registration tokens — see PushToken. Self-editable (rules' selfEditIsBenign). */
  pushTokens?: PushToken[]
  createdAt?: unknown
  updatedAt?: unknown
}

export type PushPlatform = 'web' | 'ios' | 'android'

/**
 * One FCM registration. `updatedAt` is refreshed on every app-foreground
 * re-registration so a stale token from a device the employee stopped using
 * ages out even before FCM itself reports it dead.
 */
export interface PushToken {
  token: string
  platform: PushPlatform
  updatedAt: unknown
}

/**
 * Every push/ZenZap event category — carried in the FCM payload's `data`
 * field (not just the title/body) so Phase 6's notification-preferences
 * screen can filter by category using data that already exists, rather than
 * needing a second pass to add it later.
 */
export type PushCategory =
  | 'trade.pool-drop'
  | 'trade.claimed'
  | 'trade.approved'
  | 'trade.expired'
  | 'schedule.published'
  | 'schedule.republished'
  | 'punch.forgotten'
  | 'task.missed'

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
  /**
   * Set when `sendPush` (functions/src/push.ts) could not reach one or more
   * of the intended recipients after a publish/republish — same "never
   * silently dropped" guarantee as auditPending, surfaced by the same
   * banner. The publish itself already committed; this only means some
   * employees may not have been notified and it needs a human's attention.
   */
  pushPending?: boolean
  pushPendingCategory?: PushCategory
  pushPendingEmployeeIds?: string[]
  pushPendingAt?: unknown
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

// ── trades/{tradeId} ─────────────────────────────────────────────────────────

export type TradeType = 'direct' | 'pool'

/**
 * Two statuses cover "awaiting manager approval" — `claimed` for a pool drop
 * (someone claimed it) and `pending-approval` for a direct offer (the
 * recipient accepted it) — kept distinct because the two flows differ in what
 * happens next (the CLAIMANT is fixed for a direct accept; a declined pool
 * claim reopens for anyone else to claim, a declined direct offer does not).
 */
export type TradeStatus =
  | 'open'
  | 'claimed'
  | 'pending-approval'
  | 'approved'
  | 'declined'
  | 'cancelled'
  | 'expired'

/** Recomputed independently at claim/accept/approval time — never trusted from a stale snapshot (same reason ShiftModal recomputes eligibility live, spec §7). This is display/audit context only. */
export interface TradeEligibilitySnapshot {
  roleId: string
  requiredSkillLevel: SkillLevel
}

export interface Trade {
  id: string
  type: TradeType
  shiftId: string
  weekId: string
  /**
   * Whose shift this was. `null` when a manager posts an already-OPEN shift
   * to the pool (mockup 16's "Open shift · posted by Daphne Jalil" row) —
   * there is no employee to attribute it to. `postedBy` always has someone.
   */
  fromEmployeeId: string | null
  /** Who posted this trade — same as fromEmployeeId for a self-service drop/offer, the manager's id for a posted-open-shift pool drop. */
  postedBy: string
  /** Direct offers only. Set at creation, fixed for that offer's lifetime. */
  toEmployeeId: string | null
  /** Pool claims only. Who currently holds the claim awaiting approval. */
  claimedBy: string | null
  status: TradeStatus
  approvedBy?: string | null
  declineReason?: string | null
  /**
   * Denormalized from the shift so firestore.rules can scope trade
   * approvals to the approver's own department (spec §4: "FOH managers
   * approve FOH trades; BOH effectively has no trades") without a
   * cross-document read in the rule itself.
   */
  department: Department
  eligibilitySnapshot: TradeEligibilitySnapshot
  message?: string | null
  /**
   * Direct offers only. Set to createdAt + 48h at creation (mockup 18c —
   * no written spec text covers this, inferred from the mockup's own
   * "expires in 48 hours" copy; there is no pending-prompt brief for 18a/b/c
   * to cross-check it against). Enforced server-side since Phase 3(b): the
   * scheduled sweep (`functions/src/tradeScheduled.ts`) flips a still-`open`
   * offer to `status: 'expired'` at `min(expiresAt, the shift's own start
   * instant)` — see PROGRESS.md's "48h direct-trade expiry" ruling. Only
   * `open` expires; `pending-approval` never does (a manager-reminder
   * concern, not an expiry one).
   */
  expiresAt?: unknown
  locationId?: string | null
  /** See the matching note on `Schedule.pushPending`. */
  pushPending?: boolean
  pushPendingCategory?: PushCategory
  pushPendingEmployeeIds?: string[]
  pushPendingAt?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}

// ── punches/{punchId} ────────────────────────────────────────────────────────

export type PunchType = 'in' | 'out'

export interface PunchGeo {
  lat: number
  lng: number
  accuracy: number
  insideFence: boolean
}

export interface PunchEditHistoryEntry {
  by: string
  at: unknown
  oldTimestamp: unknown
  newTimestamp: unknown
  reason: string
}

export interface Punch {
  id: string
  employeeId: string
  shiftId: string | null
  type: PunchType
  /** Server timestamp — never the device clock (spec §8). This is what pay and reporting read. */
  timestamp: unknown
  /** What the device's own clock said at submit time — kept for audit only, never trusted for pay. */
  deviceTimestamp: unknown
  /** Null for a manual punch (spec §8/§9 — a manager punch bypasses geofence + selfie by design). */
  geo: PunchGeo | null
  /** Null for a manual punch. */
  selfieStoragePath: string | null
  /** Set when a manager creates this punch on the employee's behalf (spec §8's manual-punch path), distinct from `editedBy` on a later edit. */
  manualBy?: string | null
  manualReason?: string | null
  /** True once auto-flagged for a 14h+ still-open punch (spec §8) or manually flagged for review — surfaced in the admin Shifts & Tips list, never hidden. */
  flagged?: boolean
  flagReason?: string | null
  /**
   * Only meaningful on a `type: 'in'` punch — whether the matching clock-out
   * has happened yet. `clockOut` flips this to 'closed' in the same
   * transaction that creates the 'out' punch; the forgotten-clockout sweep
   * (spec §8, 14h) queries on `status === 'open'` to find what to flag. An
   * auto-flag NEVER closes this itself — see that function's own comment for
   * why fabricating an out-time would be worse than an honest open flag.
   */
  status?: 'open' | 'closed'
  /**
   * True when this punch reached the server via the offline queue (spec §15)
   * rather than a live tap — surfaced as its own flag in Shifts & Tips (§9),
   * distinct from `flagged`, since a synced punch isn't a problem to
   * investigate, just a fact worth showing. `deviceTimestamp` still reflects
   * the ORIGINAL tap time (captured atomically then, per the offline queue's
   * own contract); `timestamp` is still the server's receipt of the SYNC,
   * not backdated to the tap — the gap between the two is exactly what this
   * flag explains to whoever reviews it.
   */
  syncedFromOfflineQueue?: boolean
  editedBy?: string | null
  editHistory: PunchEditHistoryEntry[]
  /**
   * Denormalized from the employee at creation time (same reasoning as
   * `Trade.department`) so firestore.rules' admin list-query read can check
   * it directly, with no cross-document `get()` — a rule that needs a
   * `get()` keyed on a field the query itself doesn't constrain (here,
   * `employeeId`) is what made Shifts & Tips admin return empty for every
   * non-owner/GM role (Aug 14 2026 fix): Firestore rejects a whole `list`
   * query outright when it can't prove the rule holds without per-document
   * reads, regardless of result count.
   */
  department?: Department
  locationId?: string | null
  createdAt?: unknown
  updatedAt?: unknown
}

// ── tipReports/{reportId} ────────────────────────────────────────────────────

export interface TipReportEditHistoryEntry {
  by: string
  at: unknown
  oldAmount: number
  newAmount: number
  reason: string
}

export interface TipReport {
  id: string
  employeeId: string
  /** "YYYY-MM-DD" in restaurant local time. */
  date: string
  shiftId: string | null
  /** Total tips, self-reported at clock-out. $0 is a valid, explicitly-confirmed value (spec §8) — never treated as "not yet reported". */
  amount: number
  reportedAt: unknown
  editedBy?: string | null
  editHistory: TipReportEditHistoryEntry[]
  /**
   * Denormalized from the employee at creation time — firestore.rules'
   * below-level read check (`canAccessSensitive`, spec §4) needs the
   * TARGET's rank, and a `get()` keyed on `employeeId` (a field the query
   * itself doesn't constrain) is exactly what made a list query across
   * many employees' tip reports fail outright for every non-owner role
   * (Aug 14 2026 fix — see the matching note on `Punch.department`).
   */
  employeeAccessRole?: AccessRole
  locationId?: string | null
  createdAt?: unknown
  updatedAt?: unknown
}

// ── tasks/{taskDefId} ────────────────────────────────────────────────────────

export type TaskCadence = 'per-shift' | 'daily' | 'weekly' | 'monthly'

/**
 * 'employee' pins a definition to specific people — every materialized
 * instance is pre-assigned, nothing to claim. 'role'/'department' describe a
 * POOL: instances materialize with `assigneeEmployeeId: null` and anyone in
 * scope claims one via `completeTaskInstance` (spec §10: "claimable pool
 * tasks for their role"). `ids` holds roleIds for 'role', a single
 * `Department` for 'department', employeeIds for 'employee'.
 */
export interface TaskAssignTo {
  type: 'role' | 'department' | 'employee'
  ids: string[]
}

export interface TaskDefinition {
  id: string
  title: string
  titleEs: string
  description: string
  descriptionEs: string
  cadence: TaskCadence
  assignTo: TaskAssignTo
  /**
   * Free-text display only, spec §3's own examples ("end-of-shift", "by 5pm",
   * "last day of month"). NOT parsed to derive the missed-at boundary — that
   * comes purely from `cadence` (see `functions/src/tasksScheduled.ts`'s
   * per-cadence period-end logic) so a manager can phrase this however reads
   * clearest without it needing to be machine-parseable.
   */
  dueRule: string
  /**
   * Mockup 27/28 addition (not spec §3 text) — resolved design-time addition,
   * not a deviation: whether completing an instance of this task requires a
   * photo. Gated overall by `AppSettings.featureFlags.taskPhotoProof` — if
   * that flag is off, no task's photo requirement is enforced or shown,
   * regardless of this field.
   */
  requiresPhoto: boolean
  active: boolean
  locationId?: string | null
  createdAt?: unknown
  updatedAt?: unknown
}

// ── taskInstances/{instanceId} ──────────────────────────────────────────────

export type TaskInstanceStatus = 'open' | 'done' | 'missed'

export interface TaskInstance {
  id: string
  taskDefId: string
  /**
   * Denormalized from the definition AT MATERIALIZATION TIME, never re-read
   * live — editing or retiring a definition later must not rewrite an
   * already-materialized instance's own history, the same reasoning as
   * `TipReport.employeeAccessRole`'s denormalization note above.
   */
  title: string
  titleEs: string
  dueRule: string
  requiresPhoto: boolean
  cadence: TaskCadence
  /**
   * The period this instance covers: "YYYY-MM-DD" for per-shift/daily, the
   * Mon-start `weekId` (matching `Schedule.weekId`) for weekly, "YYYY-MM" for
   * monthly. Display/grouping only — the materialization function derives
   * its own idempotent instance id from this, nothing else parses it back.
   */
  period: string
  /** Per-shift only — the specific shift this instance was materialized against. */
  shiftId?: string | null
  /** null = unclaimed pool instance (role/department assignTo). Set at materialization for 'employee' assignTo, or by `completeTaskInstance` when a pool task is claimed. */
  assigneeEmployeeId: string | null
  status: TaskInstanceStatus
  completedBy?: string | null
  completedAt?: unknown
  notes?: string | null
  photoPath?: string | null
  /**
   * Denormalized from the definition's `assignTo` at materialization time —
   * the ONE field `firestore.rules` needs to scope a staff member's "my
   * pool tasks" list query to their own department, the exact same
   * provable-list-query shape as `Punch.department` (Aug 14 2026 fix).
   * Precise role/department eligibility to actually CLAIM/complete an
   * instance is re-verified server-side in `completeTaskInstance` against the
   * live `TaskDefinition`, never trusted from this — mirroring the Shift
   * Pool precedent (department-broad list visibility, precise eligibility
   * enforced only at the point of action, not at the point of listing).
   */
  department: Department
  locationId?: string | null
  createdAt?: unknown
  updatedAt?: unknown
}
