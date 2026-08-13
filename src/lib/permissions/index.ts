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
