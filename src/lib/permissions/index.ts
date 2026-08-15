import {
  ACCESS_ROLE_RANK,
  type AccessRole,
  type Employee,
  type PermissionKey,
  type RoleDefaults,
} from '@/types/models'
import { ROLE_DEFAULTS } from './defaults'

export { ROLE_DEFAULTS, defaultsForRole } from './defaults'

/**
 * Permission + sensitive-access helpers — spec §4.
 *
 * SECURITY NOTE (CLAUDE.md): these helpers are for UI affordances only. They
 * decide what to *show*. Every one of them is mirrored in firestore.rules and
 * in Cloud Functions, which is where enforcement actually happens. Never treat
 * a passing check here as authorization.
 */

/** The minimal actor shape these helpers need. */
export interface Actor {
  id: string
  accessRole: AccessRole
  department: Employee['department']
  permissionOverrides?: Partial<Record<PermissionKey, boolean>>
}

/** The minimal target shape for sensitive-access checks. */
export interface SensitiveTarget {
  id: string
  accessRole: AccessRole
}

/**
 * Effective permission: a per-person override always wins over the role default.
 * Pass the live roleDefaults doc; falls back to seed defaults if unavailable.
 */
export function hasPermission(
  actor: Actor | null | undefined,
  key: PermissionKey,
  roleDefaults: RoleDefaults = ROLE_DEFAULTS,
): boolean {
  if (!actor) return false

  const override = actor.permissionOverrides?.[key]
  if (override !== undefined) return override

  return roleDefaults[actor.accessRole]?.[key] ?? false
}

/** True if the actor holds every listed permission. */
export function hasAllPermissions(
  actor: Actor | null | undefined,
  keys: PermissionKey[],
  roleDefaults?: RoleDefaults,
): boolean {
  return keys.every((k) => hasPermission(actor, k, roleDefaults))
}

/** True if the actor holds at least one of the listed permissions. */
export function hasAnyPermission(
  actor: Actor | null | undefined,
  keys: PermissionKey[],
  roleDefaults?: RoleDefaults,
): boolean {
  return keys.some((k) => hasPermission(actor, k, roleDefaults))
}

/**
 * The "below your level" rule — spec §4.
 *
 * Sensitive data means: pay rates, other people's tips, disciplinary records,
 * punch editing, selfies.
 *
 * Access is granted when ANY of:
 *   1. The target IS the actor. Everyone sees their own sensitive data,
 *      including their own rate (spec §17 confirms: show own rate = yes).
 *   2. The actor is an Owner. Owners see everything.
 *   3. The target's access role is STRICTLY below the actor's.
 *
 * The strictness is the point: a Manager cannot open another Manager's
 * disciplinary file or salary, and a Supervisor cannot touch a Manager's
 * anything. Equal rank fails.
 */
export function canAccessSensitive(
  actor: Actor | null | undefined,
  target: SensitiveTarget | null | undefined,
): boolean {
  if (!actor || !target) return false

  if (actor.id === target.id) return true
  if (actor.accessRole === 'owner') return true

  const actorRank = ACCESS_ROLE_RANK[actor.accessRole]
  const targetRank = ACCESS_ROLE_RANK[target.accessRole]

  return actorRank > targetRank
}

/**
 * Roles whose tip reports `role` may view, per the below-your-level rule
 * (spec §4) — strictly-below only, except Owner's blanket bypass (an Owner
 * may see even another Owner's tips; every other role excludes its own
 * rank, since equal-rank access is denied).
 *
 * This mirrors firestore.rules' `viewableTipRoles()` EXACTLY. The mirror
 * exists because a Firestore `list` query is all-or-nothing: the rule can't
 * be proven safe for an unfiltered query, so the client must constrain the
 * query itself with `where('employeeAccessRole', 'in', viewableTipRoles(...))`
 * — the SAME literal set the rule checks membership against — or Firestore
 * denies the whole request rather than filtering per-document (confirmed
 * Aug 14 2026; see firestore.rules' tipReports comment for the full story).
 */
export function viewableTipRoles(role: AccessRole): AccessRole[] {
  switch (role) {
    case 'owner':
      return ['owner', 'gm', 'manager', 'supervisor', 'staff']
    case 'gm':
      return ['manager', 'supervisor', 'staff']
    case 'manager':
      return ['supervisor', 'staff']
    case 'supervisor':
      return ['staff']
    default:
      return []
  }
}

/**
 * Department scoping for approvals — spec §4.
 * FOH managers approve FOH trades/availability. Owners and GM bypass.
 */
export function canApproveForDepartment(
  actor: Actor | null | undefined,
  department: Employee['department'],
): boolean {
  if (!actor) return false
  if (actor.accessRole === 'owner' || actor.accessRole === 'gm') return true
  return actor.department === department
}

/**
 * Combined gate for a sensitive action against a specific person: the actor
 * must both hold the permission AND clear the below-level rule.
 */
export function canActOn(
  actor: Actor | null | undefined,
  key: PermissionKey,
  target: SensitiveTarget | null | undefined,
  roleDefaults?: RoleDefaults,
): boolean {
  return hasPermission(actor, key, roleDefaults) && canAccessSensitive(actor, target)
}
