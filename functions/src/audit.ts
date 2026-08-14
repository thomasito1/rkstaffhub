/**
 * `auditLog` append — spec §17, CLAUDE.md ("sensitive mutations write to
 * auditLog").
 *
 * firestore.rules denies create/update/delete on `auditLog` to every client
 * unconditionally; the admin SDK bypasses rules, which is the whole point. A
 * log a client can write is a log a client can forge.
 *
 * The payload shape matches `buildAuditEntry()` in `src/lib/db/audit.ts` so the
 * writer and the (Phase 6) viewer cannot drift apart.
 *
 * ── ACTION VOCABULARY ───────────────────────────────────────────────────────
 * `AuditAction` in src/types/models.ts is the closed union, spec §17 plus the
 * §6/§7 override actions added alongside this file. Claim-related mutations
 * (invite acceptance, manual re-sync, a role-change trigger) are all changes to
 * *who holds which claim*, so they share `permission.change`, disambiguated by
 * `targetType` ('invite' | 'employee') and `reason` ('invite.accept' |
 * 'claims.resync' | 'role.change'). `schedule.override` and `schedule.publish`
 * are their own actions, since neither is a claim change — see
 * scheduleOverride.ts and schedulePublish.ts.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'

import { COLLECTIONS, db } from './firebase'

/** Subset of `AuditAction` (src/types/models.ts) this package emits. */
export type AuditAction = 'permission.change' | 'schedule.override' | 'schedule.publish'

export interface AuditInput {
  action: AuditAction
  /** employees/{id} of the actor, or 'system' for a Firestore trigger. */
  actorEmployeeId: string
  /** Firebase uid of the actor, or 'system' for a Firestore trigger. */
  actorUid: string
  targetType: string
  targetId: string
  reason?: string | null
  before?: unknown
  after?: unknown
}

/**
 * Never throws. An audit write that fails must not roll back the mutation it
 * describes — that would turn a logging outage into an outage of invite
 * acceptance. Failures are logged at error level for alerting instead.
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await db.collection(COLLECTIONS.auditLog).add({
      action: input.action,
      actorEmployeeId: input.actorEmployeeId,
      actorUid: input.actorUid,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      at: FieldValue.serverTimestamp(),
    })
  } catch (err) {
    logger.error('auditLog write failed', { input, err })
  }
}
