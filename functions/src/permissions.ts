/**
 * Server-side permission resolution — spec §4.
 *
 * SOURCE OF TRUTH for the algorithm: `src/lib/permissions/index.ts`. That
 * module decides what the UI SHOWS; this one decides what is ALLOWED, and
 * `firestore.rules` enforces the same shape for direct client writes. All
 * three must agree:
 *
 *     effective(key) = permissionOverrides[key] ?? roleDefaults[role][key] ?? false
 *
 * Two deliberate differences from the client helper:
 *
 *  1. The role-defaults matrix is READ FROM FIRESTORE (`permissions/roleDefaults`),
 *     never from a bundled copy. An owner editing the matrix in Settings must
 *     change what the server allows, not just what the client draws. If the
 *     document is missing, every permission resolves false — fail closed.
 *
 *  2. The caller is resolved from `employees` by `authUids array-contains uid`,
 *     not from the `employeeId` custom claim and never from the request
 *     payload. Claims are server-issued and therefore trustworthy, but the
 *     document is the record of truth and cannot be stale.
 */

import { HttpsError } from 'firebase-functions/v2/https'

import { COLLECTIONS, PRIVATE, db } from './firebase'
import {
  isAccessRole,
  rankOf,
  type AccessRole,
  type EmployeeDoc,
  type PermissionKey,
  type RoleDefaults,
} from './model'

export interface Actor {
  /** employees/{id} */
  id: string
  uid: string
  accessRole: AccessRole
  employee: EmployeeDoc
  permissionOverrides: Partial<Record<PermissionKey, boolean>>
}

export interface SensitiveTarget {
  id: string
  accessRole: AccessRole
}

/**
 * The "below your level" rule (spec §4). Mirrors `canAccessSensitive()` in
 * `src/lib/permissions/index.ts` and `canAccessSensitive()` in firestore.rules.
 * Self → yes. Owner → yes. Strictly lower rank → yes. EQUAL RANK → NO.
 */
export function canAccessSensitive(actor: Actor, target: SensitiveTarget): boolean {
  if (actor.id === target.id) return true
  if (actor.accessRole === 'owner') return true
  return rankOf(actor.accessRole) > rankOf(target.accessRole)
}

/**
 * "Nobody may grant a role at or above their own unless they are an owner"
 * (firestore.rules, employees update). Applied to any operation that issues or
 * refreshes a claim carrying `role`.
 */
export function mayConferRole(actor: Actor, role: AccessRole): boolean {
  if (actor.accessRole === 'owner') return true
  return rankOf(role) < rankOf(actor.accessRole)
}

/** `permissions/roleDefaults`. Missing document ⇒ empty matrix ⇒ fail closed. */
export async function loadRoleDefaults(): Promise<RoleDefaults> {
  const snap = await db.collection(COLLECTIONS.permissions).doc('roleDefaults').get()
  const defaults = snap.get('defaults') as RoleDefaults | undefined
  return defaults ?? {}
}

/** Effective permission for an already-resolved actor. */
export function hasPermission(
  actor: Actor,
  key: PermissionKey,
  roleDefaults: RoleDefaults,
): boolean {
  const override = actor.permissionOverrides[key]
  if (override !== undefined) return override === true
  return roleDefaults[actor.accessRole]?.[key] === true
}

/**
 * Resolve the calling uid to an employee + their overrides.
 *
 * Throws `permission-denied` rather than `not-found` when the uid is bound to
 * no employee: an unbound caller learns only that it may not act, not whether
 * an employee record happens to exist.
 */
export async function resolveActor(uid: string): Promise<Actor> {
  const found = await db
    .collection(COLLECTIONS.employees)
    .where('authUids', 'array-contains', uid)
    .limit(1)
    .get()

  const doc = found.docs[0]
  if (!doc) {
    throw new HttpsError('permission-denied', 'Caller is not bound to an employee record')
  }

  const employee = doc.data() as EmployeeDoc
  if (!isAccessRole(employee.accessRole)) {
    throw new HttpsError('permission-denied', 'Caller has no valid access role')
  }
  if (employee.status === 'archived' || employee.status === 'inactive') {
    throw new HttpsError('permission-denied', 'Caller is not an active employee')
  }

  const adminSnap = await doc.ref.collection('private').doc(PRIVATE.admin).get()
  const overrides =
    (adminSnap.get('permissionOverrides') as Partial<Record<PermissionKey, boolean>> | undefined) ??
    {}

  return {
    id: doc.id,
    uid,
    accessRole: employee.accessRole,
    employee,
    permissionOverrides: overrides,
  }
}

/**
 * Resolve the caller and assert one permission key in a single step. Every
 * privileged callable starts with this — it is the server-side equivalent of
 * the rules' `hasPerm()`.
 */
export async function requirePermission(uid: string, key: PermissionKey): Promise<Actor> {
  const actor = await resolveActor(uid)
  const roleDefaults = await loadRoleDefaults()
  if (!hasPermission(actor, key, roleDefaults)) {
    throw new HttpsError('permission-denied', `Missing permission: ${key}`)
  }
  return actor
}
