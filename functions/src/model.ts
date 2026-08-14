/**
 * Server-side mirror of the parts of `src/types/models.ts` this package needs.
 *
 * SOURCE OF TRUTH: `/src/types/models.ts`. This file is a deliberate copy, not
 * an import, because `functions/` compiles as its own CommonJS package with its
 * own `rootDir` and cannot resolve the app's `@/` path alias. Keep it in sync:
 * if `ACCESS_ROLES`, `ACCESS_ROLE_RANK` or `PERMISSION_KEYS` change there, they
 * must change here. Nothing else from the model is duplicated.
 */

export const ACCESS_ROLES = ['owner', 'gm', 'manager', 'supervisor', 'staff'] as const
export type AccessRole = (typeof ACCESS_ROLES)[number]

/** Rank for the "below your level" rule (spec §4). Higher = more authority. */
export const ACCESS_ROLE_RANK: Record<AccessRole, number> = {
  owner: 5,
  gm: 4,
  manager: 3,
  supervisor: 2,
  staff: 1,
}

export function isAccessRole(value: unknown): value is AccessRole {
  return typeof value === 'string' && (ACCESS_ROLES as readonly string[]).includes(value)
}

/** Unknown / malformed roles rank 0 — below everyone, and above nobody. */
export function rankOf(role: unknown): number {
  return isAccessRole(role) ? ACCESS_ROLE_RANK[role] : 0
}

export type PermissionKey = string

export type RoleDefaults = Record<string, Partial<Record<PermissionKey, boolean>>>

export type EmployeeStatus = 'active' | 'pending' | 'inactive' | 'archived'

export type Department = 'FOH' | 'BOH' | 'Admin'

/** Only the fields the server reads. The employee document has many more. */
export interface EmployeeDoc {
  firstName?: string
  lastName?: string
  preferredName?: string | null
  email?: string
  accessRole?: AccessRole
  status?: EmployeeStatus
  department?: Department
  authUids?: string[]
  shiftRoles?: { roleId: string; skillLevel: number; isPrimary?: boolean }[]
}

/** Only the fields the publish callable needs. */
export interface ScheduleDoc {
  status?: string
}

/** Only the fields the override callable needs. */
export interface ShiftRoleDoc {
  canCoverRoleIds?: string[]
}

/** Only the fields the override/trade callables need. */
export interface ShiftDoc {
  employeeId?: string | null
  date?: string
  startTime?: string
  endTime?: string
  roleId?: string
  requiredSkillLevel?: number
  department?: Department
  status?: string
}

export type TradeType = 'direct' | 'pool'
export type TradeStatus = 'open' | 'claimed' | 'pending-approval' | 'approved' | 'declined' | 'cancelled'

/** Only the fields the trade action callables need. */
export interface TradeDoc {
  type?: TradeType
  shiftId?: string
  weekId?: string
  fromEmployeeId?: string | null
  postedBy?: string
  toEmployeeId?: string | null
  claimedBy?: string | null
  status?: TradeStatus
  approvedBy?: string | null
  department?: Department
}

/** Only the fields the trade action callables need. */
export interface TimeOffDoc {
  startDate?: string
  endDate?: string
  status?: string
}

export interface InviteDoc {
  employeeId?: string
  email?: string
  token?: string
  status?: 'pending' | 'accepted' | 'revoked' | 'expired'
  createdBy?: string
  expiresAt?: unknown
  acceptedAt?: unknown
}

/**
 * The custom claims this product issues. `employeeId` is what
 * `AuthProvider.tsx` resolves the signed-in employee from; `role` is what
 * `firestore.rules` keys every permission check off.
 */
export interface StaffHubClaims {
  employeeId: string
  role: AccessRole
}

/** Full display name, matching how the app renders a person. */
export function displayName(employee: EmployeeDoc): string {
  const first = (employee.preferredName || employee.firstName || '').trim()
  const last = (employee.lastName ?? '').trim()
  return [first, last].filter(Boolean).join(' ')
}
