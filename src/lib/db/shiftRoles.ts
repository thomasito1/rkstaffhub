/**
 * Shift role catalog data access — `shiftRoles/{roleId}` (spec §3, §7.1).
 *
 * The catalog is admin-editable (Settings → Roles, mockup 32): names, colors,
 * sort order, active flag, and the `canCoverRoleIds` hierarchy that spec §7
 * condition 1 evaluates. Rules: any signed-in user reads (role chips and
 * eligibility need it); `settings.manage` writes.
 *
 * Document ids are readable slugs ("hot-line-cook"), not auto-ids, so a role
 * referenced from a shift or an employee's shiftRoles[] is legible in the
 * console and stable across environments. Use roleIdFromName() to derive one.
 *
 * NOTE: this module is catalog CRUD only. Trade eligibility (spec §7) is a
 * Phase 2 concern and is deliberately not implemented here.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
  type DocumentSnapshot,
  type FirestoreError,
} from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import type { Department, ShiftRole } from '@/types/models'

function shiftRoleDoc(id: string) {
  return doc(db, COLLECTIONS.shiftRoles, id)
}

function toShiftRole(snap: DocumentSnapshot<DocumentData>): ShiftRole {
  const d = snap.data() ?? {}
  const role: ShiftRole = {
    id: snap.id,
    name: String(d.name ?? snap.id),
    nameEs: String(d.nameEs ?? d.name ?? snap.id),
    department: (d.department as Department) ?? 'FOH',
    color: String(d.color ?? '#6B7280'),
    sortOrder: Number(d.sortOrder ?? 0),
    active: d.active !== false,
    canCoverRoleIds: (d.canCoverRoleIds as string[]) ?? [],
  }
  return role
}

function bySortOrder(a: ShiftRole, b: ShiftRole): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)
}

/**
 * The whole catalog, in scheduling-priority order (mockup 32: "roles at the top
 * are filled first"). Sorted client-side — 14 documents, no index needed.
 */
export async function listShiftRoles(opts?: {
  activeOnly?: boolean
  department?: Department
}): Promise<ShiftRole[]> {
  const snap = await getDocs(collection(db, COLLECTIONS.shiftRoles))
  return snap.docs
    .map(toShiftRole)
    .filter((r) => (opts?.activeOnly ? r.active : true))
    .filter((r) => (opts?.department ? r.department === opts.department : true))
    .sort(bySortOrder)
}

export async function getShiftRole(id: string): Promise<ShiftRole | null> {
  const snap = await getDoc(shiftRoleDoc(id))
  return snap.exists() ? toShiftRole(snap) : null
}

/** Live catalog — the schedule grid re-tints its role bands when a color changes. */
export function subscribeShiftRoles(
  onChange: (roles: ShiftRole[]) => void,
  onError?: (err: FirestoreError) => void,
): () => void {
  return onSnapshot(
    collection(db, COLLECTIONS.shiftRoles),
    (snap) => onChange(snap.docs.map(toShiftRole).sort(bySortOrder)),
    onError,
  )
}

/** Convenience map for rendering — role id → role, no repeated array scans. */
export async function getShiftRoleMap(): Promise<Map<string, ShiftRole>> {
  const roles = await listShiftRoles()
  return new Map(roles.map((r) => [r.id, r]))
}

/** Create or replace a role. `id` doubles as the document id. */
export async function upsertShiftRole(role: ShiftRole): Promise<void> {
  const { id, ...rest } = role
  // Full overwrite (no merge), so any stale field on the existing document —
  // including the retired `minSkillLevelToCover` — is dropped.
  await setDoc(shiftRoleDoc(id), {
    ...rest,
    updatedAt: serverTimestamp(),
  })
}

export async function updateShiftRole(
  id: string,
  patch: Partial<Omit<ShiftRole, 'id'>>,
): Promise<void> {
  await updateDoc(shiftRoleDoc(id), { ...patch, updatedAt: serverTimestamp() })
}

/**
 * Retire a role without deleting it. Historical shifts still reference the id,
 * so removing the document would leave them unrenderable.
 */
export async function setShiftRoleActive(id: string, active: boolean): Promise<void> {
  await updateShiftRole(id, { active })
}

/**
 * Rewrite the coverage list for one role. Asymmetric by design (spec §7.1):
 * setting Bartender → [server, host, runner] does NOT let a Server cover the bar.
 */
export async function setCanCoverRoleIds(id: string, canCoverRoleIds: string[]): Promise<void> {
  await updateShiftRole(id, { canCoverRoleIds })
}

/** Persist a drag-reorder from Settings → Roles. */
export async function reorderShiftRoles(orderedIds: string[]): Promise<void> {
  await Promise.all(
    orderedIds.map((id, index) => updateShiftRole(id, { sortOrder: index + 1 })),
  )
}
