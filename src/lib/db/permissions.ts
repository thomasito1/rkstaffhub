/**
 * Permission matrix data access — `permissions/roleDefaults` (spec §4).
 *
 * Effective permission = employee override ?? role default. This module owns
 * the *role default* half; the *override* half lives on
 * employees/{id}/private/admin and is reached through db/employees.
 *
 * SECURITY: nothing here authorizes anything. These are the values the UI uses
 * to decide what to show. firestore.rules re-derives the same answer server-side
 * from the same document (see roleDefaults()/hasPerm() there), and that is the
 * enforcement point (CLAUDE.md).
 */

import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  type FirestoreError,
} from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import { ROLE_DEFAULTS } from '@/lib/permissions/defaults'
import type {
  AccessRole,
  PermissionKey,
  RoleDefaults,
  RoleDefaultsDoc,
} from '@/types/models'

import { getEmployeeAdmin, setEmployeeOverrides } from './employees'

const ROLE_DEFAULTS_ID = 'roleDefaults'

function roleDefaultsDoc() {
  return doc(db, COLLECTIONS.permissions, ROLE_DEFAULTS_ID)
}

/**
 * The live matrix.
 *
 * Falls back to the seed constant when the document is missing so a fresh or
 * half-migrated environment renders a sane Settings → Permissions screen
 * instead of a blank grid. The fallback is a UI convenience only — the rules
 * have no such fallback, so an unseeded project genuinely denies everything.
 */
export async function getRoleDefaults(): Promise<RoleDefaults> {
  const snap = await getDoc(roleDefaultsDoc())
  if (!snap.exists()) return ROLE_DEFAULTS
  const data = snap.data() as Partial<RoleDefaultsDoc>
  return data.defaults ?? ROLE_DEFAULTS
}

/** Live matrix — a permission revoked in Settings should take effect immediately. */
export function subscribeRoleDefaults(
  onChange: (defaults: RoleDefaults) => void,
  onError?: (err: FirestoreError) => void,
): () => void {
  return onSnapshot(
    roleDefaultsDoc(),
    (snap) => {
      if (!snap.exists()) return onChange(ROLE_DEFAULTS)
      const data = snap.data() as Partial<RoleDefaultsDoc>
      onChange(data.defaults ?? ROLE_DEFAULTS)
    },
    onError,
  )
}

/**
 * Replace the whole matrix. Whole-document writes rather than dotted-path
 * updates: a permission key can contain a '.', which Firestore would read as a
 * nested path and silently write the wrong shape.
 */
export async function saveRoleDefaults(
  defaults: RoleDefaults,
  updatedBy: string,
): Promise<void> {
  const payload: RoleDefaultsDoc = {
    defaults,
    updatedBy,
    updatedAt: serverTimestamp(),
  }
  await setDoc(roleDefaultsDoc(), payload)
}

/** Toggle one cell of the Settings → Permissions grid. */
export async function setRolePermission(
  role: AccessRole,
  key: PermissionKey,
  value: boolean,
  updatedBy: string,
): Promise<void> {
  const current = await getRoleDefaults()
  await saveRoleDefaults(
    { ...current, [role]: { ...current[role], [key]: value } },
    updatedBy,
  )
}

/**
 * Per-person grants/revokes. Returns `{}` when the caller cannot read the
 * target's private/admin document — see the note in db/employees.
 */
export async function getEmployeeOverrides(
  employeeId: string,
): Promise<Partial<Record<PermissionKey, boolean>>> {
  const admin = await getEmployeeAdmin(employeeId)
  return admin?.permissionOverrides ?? {}
}

/**
 * Grant, revoke, or clear a single key for one person.
 * `null` removes the override so the role default applies again ("Inherit").
 */
export async function setEmployeeOverride(
  employeeId: string,
  key: PermissionKey,
  value: boolean | null,
): Promise<void> {
  const current = await getEmployeeOverrides(employeeId)
  const next: Partial<Record<PermissionKey, boolean>> = { ...current }
  if (value === null) delete next[key]
  else next[key] = value
  await setEmployeeOverrides(employeeId, next)
}
