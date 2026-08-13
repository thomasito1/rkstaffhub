/**
 * Custom claims — spec §2 ("Set custom claims (`role`, `employeeId`) via Cloud
 * Function on invite acceptance and role change").
 *
 * Claims are the only thing that makes an authenticated user into a *person* in
 * this product: `AuthProvider.tsx` resolves the employee record from
 * `employeeId`, and every rule in firestore.rules keys off `role`. Only a
 * privileged server may set them, which is why this lives here and not in
 * `src/lib/auth/authActions.ts`.
 */

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { onDocumentUpdated } from 'firebase-functions/v2/firestore'
import { logger } from 'firebase-functions'

import { writeAudit } from './audit'
import { COLLECTIONS, adminAuth, db } from './firebase'
import { isAccessRole, type AccessRole, type EmployeeDoc } from './model'
import { canAccessSensitive, mayConferRole, requirePermission } from './permissions'

/** Result of pushing claims out to an employee's linked sign-in identities. */
export interface ClaimSyncResult {
  updated: string[]
  failed: string[]
}

/**
 * Write `{ employeeId, role }` onto every uid linked to the employee.
 *
 * Existing custom claims are merged rather than replaced so a future claim
 * added by another Function is not silently dropped here.
 *
 * A uid that no longer exists in Auth (deleted account, wiped emulator) is
 * recorded and skipped — one dangling uid must not stop a demotion reaching
 * the other five devices the person signs in from.
 */
export async function syncClaimsForEmployee(
  employeeId: string,
  employee: EmployeeDoc,
): Promise<ClaimSyncResult> {
  const role = employee.accessRole
  if (!isAccessRole(role)) {
    throw new HttpsError('failed-precondition', 'Employee has no valid accessRole')
  }

  const uids = Array.from(new Set(employee.authUids ?? [])).filter(
    (uid): uid is string => typeof uid === 'string' && uid.length > 0,
  )

  const result: ClaimSyncResult = { updated: [], failed: [] }

  for (const uid of uids) {
    try {
      const user = await adminAuth.getUser(uid)
      await adminAuth.setCustomUserClaims(uid, {
        ...(user.customClaims ?? {}),
        employeeId,
        role,
      })
      result.updated.push(uid)
    } catch (err) {
      logger.error('claim sync failed for uid', { uid, employeeId, err })
      result.failed.push(uid)
    }
  }

  return result
}

// ── setEmployeeClaims ────────────────────────────────────────────────────────

/**
 * Re-sync one employee's claims after a role change or a manual repair.
 *
 * Authorization, all re-derived server-side:
 *   1. caller holds `permissions.manage` (override ?? roleDefault, from Firestore)
 *   2. caller clears the below-level rule against the target (spec §4)
 *   3. the role being conferred is strictly below the caller's, unless owner
 *
 * The payload carries an `employeeId` and nothing else. The role is read from
 * the employee document — accepting a role from the client would let any
 * caller mint themselves an owner claim.
 */
export const setEmployeeClaims = onCall<{ employeeId?: unknown }>(async (request) => {
  const uid = request.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required')

  const employeeId = typeof request.data?.employeeId === 'string' ? request.data.employeeId.trim() : ''
  if (!employeeId) throw new HttpsError('invalid-argument', 'employeeId is required')

  const actor = await requirePermission(uid, 'permissions.manage')

  const ref = db.collection(COLLECTIONS.employees).doc(employeeId)
  const snap = await ref.get()
  if (!snap.exists) throw new HttpsError('not-found', 'Employee not found')

  const employee = snap.data() as EmployeeDoc
  const role = employee.accessRole
  if (!isAccessRole(role)) {
    throw new HttpsError('failed-precondition', 'Employee has no valid accessRole')
  }

  if (!canAccessSensitive(actor, { id: employeeId, accessRole: role })) {
    throw new HttpsError('permission-denied', 'Target is not below your access level')
  }
  if (!mayConferRole(actor, role)) {
    throw new HttpsError('permission-denied', 'You may not confer a role at or above your own')
  }

  const sync = await syncClaimsForEmployee(employeeId, employee)

  await writeAudit({
    action: 'permission.change',
    actorEmployeeId: actor.id,
    actorUid: uid,
    targetType: 'employee',
    targetId: employeeId,
    reason: 'claims.resync',
    after: { role, uids: sync.updated, failedUids: sync.failed },
  })

  return { employeeId, role, updatedUids: sync.updated.length, failedUids: sync.failed.length }
})

// ── onEmployeeRoleChange ─────────────────────────────────────────────────────

/**
 * Firestore trigger: refresh claims the moment `accessRole` changes.
 *
 * Without this a demotion would sit dormant until the person next signed in —
 * a former manager would keep manager rules access for the life of their
 * refresh token. The trigger fires on any path that changes the field: the
 * employee editor, an import, or a console edit.
 *
 * Writes only to `auditLog`, never back to `employees`, so it cannot re-trigger
 * itself.
 */
export const onEmployeeRoleChange = onDocumentUpdated(
  `${COLLECTIONS.employees}/{employeeId}`,
  async (event) => {
    const before = event.data?.before.data() as EmployeeDoc | undefined
    const after = event.data?.after.data() as EmployeeDoc | undefined
    if (!before || !after) return

    const previousRole = before.accessRole
    const nextRole = after.accessRole
    if (previousRole === nextRole) return

    const employeeId = event.params.employeeId

    if (!isAccessRole(nextRole)) {
      logger.error('accessRole changed to an invalid value; claims not synced', {
        employeeId,
        previousRole,
        nextRole,
      })
      return
    }

    const sync = await syncClaimsForEmployee(employeeId, after)

    logger.info('accessRole changed — claims refreshed', {
      employeeId,
      previousRole,
      nextRole,
      updated: sync.updated.length,
      failed: sync.failed.length,
    })

    await writeAudit({
      action: 'permission.change',
      // A Firestore trigger cannot see who made the write; the actor is
      // recorded on the client-side mutation's own audit entry where one
      // exists. 'system' marks this as the derived claim refresh.
      actorEmployeeId: 'system',
      actorUid: 'system',
      targetType: 'employee',
      targetId: employeeId,
      reason: 'role.change',
      before: { role: previousRole as AccessRole | undefined },
      after: { role: nextRole, uids: sync.updated, failedUids: sync.failed },
    })
  },
)
