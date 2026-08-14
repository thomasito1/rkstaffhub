/**
 * Manager override of the §6 skill-floor block.
 *
 * The conflicts engine (`src/lib/scheduling/conflicts.ts`) marks a shift
 * assignment BLOCKED when the candidate's effective skill level is below the
 * shift's `requiredSkillLevel` — but marks it `overridable: true`, unlike every
 * other block. Spec §6: "skill level below shift's requiredSkillLevel (block
 * unless manager overrides with a logged reason)". The logging is the whole
 * requirement, and `auditLog` is create:false for every client
 * (firestore.rules) — a log a client can write is a log a client can forge —
 * so the override cannot be a client-side write with a client-side promise to
 * also log it later.
 *
 * This callable owns BOTH halves atomically: it assigns the shift AND writes
 * the audit entry in one transaction. A normal (non-conflicting) assignment
 * does NOT go through this function — src/lib/db/schedules.ts's updateShift()
 * already works for that, because firestore.rules already lets a
 * schedule.edit holder write a shift directly. This function exists only for
 * the narrow case where that write would encode a fact (someone under-leveled
 * is being scheduled anyway) that must be independently verified and durably
 * logged, not merely asserted by the caller.
 *
 * INDEPENDENT VERIFICATION, not trust: the callable does not accept "yes this
 * needs an override" from the client. It re-fetches the shift, the candidate's
 * shiftRoles, and the covering roles' canCoverRoleIds, and recomputes the same
 * effective-skill logic conflicts.ts uses (duplicated here for the same reason
 * permissions.ts duplicates hasPermission — this package cannot import `@/lib`
 * across the TypeScript project boundary). If the candidate is NOT actually
 * under-leveled, the call fails with `failed-precondition` rather than quietly
 * logging an override nobody needed — that would make the audit trail lie.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

import { COLLECTIONS, db } from './firebase'
import { requirePermission } from './permissions'
import { markAuditPending, writeAudit } from './audit'
import type { EmployeeDoc, ShiftDoc, ShiftRoleDoc } from './model'

export interface RecordScheduleOverrideRequest {
  weekId: string
  shiftId: string
  employeeId: string
  reason: string
}

export interface RecordScheduleOverrideResponse {
  weekId: string
  shiftId: string
  employeeId: string
  effectiveSkillLevel: number
  requiredSkillLevel: number
}

/**
 * Mirrors `effectiveSkillFor()` in src/lib/scheduling/conflicts.ts. Direct
 * role match wins outright; otherwise the best level among held roles whose
 * `canCoverRoleIds` includes the target role (asymmetric — a Server never
 * covers Bartender even though Bartender covers Server).
 */
function effectiveSkillFor(
  shiftRoles: EmployeeDoc['shiftRoles'],
  targetRoleId: string,
  canCoverRoleIds: Record<string, string[]>,
): number {
  const roles = shiftRoles ?? []

  const direct = roles.find((r) => r.roleId === targetRoleId)
  if (direct) return direct.skillLevel

  let best = 0
  for (const held of roles) {
    const covers = canCoverRoleIds[held.roleId] ?? []
    if (covers.includes(targetRoleId) && held.skillLevel > best) {
      best = held.skillLevel
    }
  }
  return best
}

function requireNonEmptyReason(reason: unknown): string {
  const trimmed = typeof reason === 'string' ? reason.trim() : ''
  if (!trimmed) {
    throw new HttpsError(
      'invalid-argument',
      'A reason is required to override the skill-level block.',
    )
  }
  return trimmed
}

export const recordScheduleOverride = onCall<RecordScheduleOverrideRequest>(
  async (request): Promise<RecordScheduleOverrideResponse> => {
    const uid = request.auth?.uid
    if (!uid) {
      throw new HttpsError('unauthenticated', 'Sign in required.')
    }

    const { weekId, shiftId, employeeId } = request.data
    if (!weekId || !shiftId || !employeeId) {
      throw new HttpsError('invalid-argument', 'weekId, shiftId and employeeId are required.')
    }
    const reason = requireNonEmptyReason(request.data.reason)

    // schedule.edit, not trades.manualAssign: this is the §6 build-time
    // override, not the §7 trade-eligibility override. The role defaults only
    // grant schedule.edit to manager+ anyway, matching spec's "manager
    // overrides" language without hard-coding accessRole.
    const actor = await requirePermission(uid, 'schedule.edit')

    const shiftRef = db
      .collection(COLLECTIONS.schedules)
      .doc(weekId)
      .collection('shifts')
      .doc(shiftId)

    const employeeRef = db.collection(COLLECTIONS.employees).doc(employeeId)

    const [shiftSnap, employeeSnap, roleRolesSnap] = await Promise.all([
      shiftRef.get(),
      employeeRef.get(),
      db.collection(COLLECTIONS.shiftRoles).get(),
    ])

    if (!shiftSnap.exists) {
      throw new HttpsError('not-found', 'That shift no longer exists.')
    }
    if (!employeeSnap.exists) {
      throw new HttpsError('not-found', 'That employee no longer exists.')
    }

    const shift = shiftSnap.data() as ShiftDoc
    const employee = employeeSnap.data() as EmployeeDoc

    if (employee.status !== 'active') {
      throw new HttpsError(
        'failed-precondition',
        'Only an active employee can be assigned to a shift.',
      )
    }

    const roleId = shift.roleId
    const requiredSkillLevel = shift.requiredSkillLevel
    if (!roleId || typeof requiredSkillLevel !== 'number') {
      throw new HttpsError('failed-precondition', 'Shift is missing role or skill data.')
    }

    const canCoverRoleIds: Record<string, string[]> = {}
    for (const doc of roleRolesSnap.docs) {
      const data = doc.data() as ShiftRoleDoc
      canCoverRoleIds[doc.id] = data.canCoverRoleIds ?? []
    }

    const effectiveSkillLevel = effectiveSkillFor(employee.shiftRoles, roleId, canCoverRoleIds)

    // The one guard that matters: refuse to log an override nobody needed.
    if (effectiveSkillLevel >= requiredSkillLevel) {
      throw new HttpsError(
        'failed-precondition',
        'This candidate already meets the required skill level — no override applies.',
      )
    }

    const previousEmployeeId = shift.employeeId ?? null

    // Re-read inside the transaction: the skill computation above is fine
    // against a slightly stale snapshot (role catalogs and shiftRoles don't
    // change mid-request), but the WRITE must not blindly clobber a shift
    // another manager assigned in the moment between the initial get() and now.
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(shiftRef)
      if (!fresh.exists) {
        throw new HttpsError('not-found', 'That shift no longer exists.')
      }
      const freshData = fresh.data() as ShiftDoc
      if ((freshData.employeeId ?? null) !== previousEmployeeId) {
        throw new HttpsError(
          'aborted',
          'This shift changed since you opened it — reload and try again.',
        )
      }
      // dirtySincePublish flags this for the next republish's change count
      // (see schedulePublish.ts) — an override on an already-live shift is
      // exactly the kind of post-publish edit that must not go unnoticed.
      tx.update(shiftRef, {
        employeeId,
        dirtySincePublish: true,
        updatedAt: FieldValue.serverTimestamp(),
      })
    })

    const audited = await writeAudit({
      action: 'schedule.override',
      actorEmployeeId: actor.id,
      actorUid: uid,
      targetType: 'shift',
      targetId: `${weekId}/${shiftId}`,
      reason,
      before: { employeeId: previousEmployeeId },
      after: {
        employeeId,
        roleId,
        requiredSkillLevel,
        effectiveSkillLevel,
      },
    })
    if (!audited) await markAuditPending(shiftRef, 'schedule.override')

    return { weekId, shiftId, employeeId, effectiveSkillLevel, requiredSkillLevel }
  },
)
