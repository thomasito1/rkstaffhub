/**
 * `completeTaskInstance` — spec §10: staff "check off with optional
 * note/photo." Unreachable from a client write (firestore.rules' `taskInstances`
 * match denies create/update/delete outright) because a POOL claim
 * (`assigneeEmployeeId: null` → self) needs its scope re-verified against the
 * live `TaskDefinition` server-side — the exact same "never trust a client's
 * claimed eligibility" reasoning `tradeActions.ts`'s claim/accept/approve
 * already established, just for task-pool scope instead of trade eligibility.
 *
 * A photo is required at the SERVER, not just hidden in the UI, when the
 * instance's own (denormalized, materialization-time) `requiresPhoto` is
 * true — matching CLAUDE.md's "security is server-side" rule.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

import { COLLECTIONS, db } from './firebase'
import { requirePermission } from './permissions'
import type { TaskDefinitionDoc, TaskInstanceDoc } from './model'

export interface CompleteTaskInstanceRequest {
  instanceId: string
  notes?: string | null
  photoPath?: string | null
}

export interface CompleteTaskInstanceResponse {
  instanceId: string
  status: 'done'
  assigneeEmployeeId: string
}

export const completeTaskInstance = onCall<CompleteTaskInstanceRequest>(
  async (request): Promise<CompleteTaskInstanceResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { instanceId, notes, photoPath } = request.data
    if (!instanceId) throw new HttpsError('invalid-argument', 'instanceId is required.')

    const actor = await requirePermission(uid, 'tasks.complete')
    const ref = db.collection(COLLECTIONS.taskInstances).doc(instanceId)

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists) throw new HttpsError('not-found', 'That task no longer exists.')
      const instance = snap.data() as TaskInstanceDoc

      if (instance.status !== 'open') {
        throw new HttpsError('failed-precondition', 'This task is no longer open.')
      }

      const isMine = instance.assigneeEmployeeId === actor.id
      const isUnclaimedPool = instance.assigneeEmployeeId == null

      if (!isMine && !isUnclaimedPool) {
        throw new HttpsError('permission-denied', 'This task is assigned to someone else.')
      }

      if (isUnclaimedPool) {
        const defSnap = await tx.get(db.collection(COLLECTIONS.tasks).doc(instance.taskDefId ?? ''))
        const def = defSnap.exists ? (defSnap.data() as TaskDefinitionDoc) : undefined
        const assignTo = def?.assignTo
        const inScope =
          assignTo?.type === 'department'
            ? assignTo.ids.includes(actor.employee.department ?? '')
            : assignTo?.type === 'role'
              ? (actor.employee.shiftRoles ?? []).some((r) => assignTo.ids.includes(r.roleId))
              : false
        if (!inScope) {
          throw new HttpsError('permission-denied', 'You are not eligible to claim this task.')
        }
      }

      if (instance.requiresPhoto && !photoPath) {
        throw new HttpsError('failed-precondition', 'This task requires a photo to complete.')
      }

      tx.update(ref, {
        assigneeEmployeeId: actor.id,
        status: 'done',
        completedBy: actor.id,
        completedAt: FieldValue.serverTimestamp(),
        notes: notes ?? null,
        photoPath: photoPath ?? null,
        updatedAt: FieldValue.serverTimestamp(),
      })
    })

    return { instanceId, status: 'done', assigneeEmployeeId: actor.id }
  },
)
