/**
 * Task instance data access — `taskInstances/{instanceId}` (spec §3, §10).
 *
 * Every write is Cloud-Function-only (firestore.rules: `allow create,
 * update, delete: if false`) — materialization and completion both live in
 * `functions/src/tasksScheduled.ts`/`taskActions.ts`. This module is READS
 * ONLY; completing one is `src/lib/tasks/taskActions.ts`'s
 * `completeTaskInstance()` Cloud Function wrapper.
 */
import {
  collection,
  getDocs,
  query,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import type { Department, TaskCadence, TaskInstance, TaskInstanceStatus } from '@/types/models'

import { isPermissionDenied } from './errors'

function toTaskInstance(snap: QueryDocumentSnapshot<DocumentData>): TaskInstance {
  const d = snap.data()
  const cadence = d.cadence as TaskCadence
  const status = d.status as TaskInstanceStatus
  return {
    id: snap.id,
    taskDefId: String(d.taskDefId ?? ''),
    title: String(d.title ?? ''),
    titleEs: String(d.titleEs ?? ''),
    dueRule: String(d.dueRule ?? ''),
    requiresPhoto: Boolean(d.requiresPhoto),
    cadence: (['per-shift', 'daily', 'weekly', 'monthly'] as const).includes(cadence) ? cadence : 'daily',
    period: String(d.period ?? ''),
    shiftId: (d.shiftId as string | null) ?? null,
    assigneeEmployeeId: (d.assigneeEmployeeId as string | null) ?? null,
    status: (['open', 'done', 'missed'] as const).includes(status) ? status : 'open',
    completedBy: (d.completedBy as string | null) ?? null,
    completedAt: d.completedAt,
    notes: (d.notes as string | null) ?? null,
    photoPath: (d.photoPath as string | null) ?? null,
    department: d.department as Department,
    locationId: (d.locationId as string | null) ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

/**
 * "My Tasks" (spec §10): every instance ever assigned to `employeeId`
 * (open/done/missed — mockup 27 shows completed cards too), PLUS still-open
 * pool instances (role/department assignTo) in `department`. Two separate
 * queries, never one combined `OR` — a doc can satisfy at most one of them
 * (a claimed pool instance's `assigneeEmployeeId` is no longer `null`), and
 * each is independently list-query-safe: query B pins `department` to the
 * exact literal `firestore.rules`' `mayViewPoolInstance()` checks (the same
 * shape as `listPunchesInRange`'s `department` filter) — do not merge these
 * into one query with an `or()`, which would stop being provable.
 */
export async function listMyTaskInstances(
  employeeId: string,
  department: Department,
): Promise<TaskInstance[]> {
  try {
    const [mine, pool] = await Promise.all([
      getDocs(query(collection(db, COLLECTIONS.taskInstances), where('assigneeEmployeeId', '==', employeeId))),
      getDocs(
        query(
          collection(db, COLLECTIONS.taskInstances),
          where('assigneeEmployeeId', '==', null),
          where('department', '==', department),
          where('status', '==', 'open'),
        ),
      ),
    ])
    const byId = new Map<string, TaskInstance>()
    for (const doc of [...mine.docs, ...pool.docs]) byId.set(doc.id, toTaskInstance(doc))
    return Array.from(byId.values())
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}

/**
 * Every instance whose `period` matches exactly (e.g. today's "YYYY-MM-DD"
 * for the completion dashboard's "today" tiles) — `tasks.manage`-gated,
 * unscoped by department (an Owner/GM/Manager dashboard concern, spec §10's
 * "completion dashboard by day/person/role").
 */
export async function listTaskInstancesForPeriod(period: string): Promise<TaskInstance[]> {
  try {
    const snap = await getDocs(query(collection(db, COLLECTIONS.taskInstances), where('period', '==', period)))
    return snap.docs.map(toTaskInstance)
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}
