/**
 * Task definition data access — `tasks/{taskDefId}` (spec §3, §10).
 *
 * Definitions only — reads are `tasks.manage`-gated (firestore.rules), since
 * every materialized `taskInstance` denormalizes title/titleEs/dueRule/
 * requiresPhoto at creation time (see `TaskInstance`'s own doc comment in
 * types/models.ts), so nothing outside the admin Task Manager screen
 * (Settings → Tasks) ever needs to read a definition directly. A definition
 * is a forward-looking target, same as a `ShiftTemplate` — deactivating one
 * (not deleting; `taskInstances` reference `taskDefId`, so a hard delete
 * would orphan history) is the only lifecycle move, matching `shiftRoles`'
 * `active` pattern rather than `shiftTemplates`' plain-delete one.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  type DocumentData,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import type { TaskAssignTo, TaskCadence, TaskDefinition } from '@/types/models'

import { isPermissionDenied, readOrNullIfDenied } from './errors'

export interface NewTaskDefinitionInput {
  title: string
  titleEs: string
  description: string
  descriptionEs: string
  cadence: TaskCadence
  assignTo: TaskAssignTo
  dueRule: string
  requiresPhoto?: boolean
  locationId?: string | null
}

function taskDefDoc(id: string) {
  return doc(db, COLLECTIONS.tasks, id)
}

function toAssignTo(raw: unknown): TaskAssignTo {
  const a = (raw ?? {}) as Partial<TaskAssignTo>
  const type = a.type === 'department' || a.type === 'employee' ? a.type : 'role'
  return { type, ids: Array.isArray(a.ids) ? a.ids.map(String) : [] }
}

function toTaskDefinition(
  snap: DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>,
): TaskDefinition {
  const d = snap.data() ?? {}
  const cadence = d.cadence as TaskCadence
  return {
    id: snap.id,
    title: String(d.title ?? ''),
    titleEs: String(d.titleEs ?? ''),
    description: String(d.description ?? ''),
    descriptionEs: String(d.descriptionEs ?? ''),
    cadence: (['per-shift', 'daily', 'weekly', 'monthly'] as const).includes(cadence) ? cadence : 'daily',
    assignTo: toAssignTo(d.assignTo),
    dueRule: String(d.dueRule ?? ''),
    requiresPhoto: Boolean(d.requiresPhoto),
    active: d.active !== false,
    locationId: (d.locationId as string | null) ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

/** Every definition, active or not — the Task Manager screen filters by "Active only" itself (mockup 28). */
export async function listTaskDefinitions(): Promise<TaskDefinition[]> {
  try {
    const snap = await getDocs(collection(db, COLLECTIONS.tasks))
    return snap.docs.map(toTaskDefinition).sort((a, b) => a.title.localeCompare(b.title))
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}

export async function getTaskDefinition(id: string): Promise<TaskDefinition | null> {
  return readOrNullIfDenied(async () => {
    const snap = await getDoc(taskDefDoc(id))
    return snap.exists() ? toTaskDefinition(snap) : null
  })
}

export async function createTaskDefinition(input: NewTaskDefinitionInput): Promise<TaskDefinition> {
  const ref = doc(collection(db, COLLECTIONS.tasks))
  const payload = {
    title: input.title,
    titleEs: input.titleEs,
    description: input.description,
    descriptionEs: input.descriptionEs,
    cadence: input.cadence,
    assignTo: input.assignTo,
    dueRule: input.dueRule,
    requiresPhoto: input.requiresPhoto ?? false,
    active: true,
    locationId: input.locationId ?? null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  await setDoc(ref, payload)
  return { id: ref.id, ...payload }
}

export async function updateTaskDefinition(
  id: string,
  patch: Partial<Omit<TaskDefinition, 'id' | 'createdAt' | 'updatedAt'>>,
): Promise<void> {
  const next: Record<string, unknown> = { updatedAt: serverTimestamp() }
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v
  await updateDoc(taskDefDoc(id), next)
}

/** The only lifecycle move (see file header) — flips `active`, never deletes. */
export async function setTaskDefinitionActive(id: string, active: boolean): Promise<void> {
  await updateTaskDefinition(id, { active })
}
