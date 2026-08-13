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
 * `AuditAction` in src/types/models.ts is a closed union taken verbatim from
 * spec §17, and it has no invite-specific member. Everything this package
 * records is a change to *who holds which claim*, so all of it is logged as
 * `permission.change`; `targetType` ('invite' | 'employee') and `reason`
 * ('invite.accept' | 'claims.resync' | 'role.change') say which. Adding
 * `invite.accept` to the union would mean editing models.ts, which this task
 * forbids — flagged for Rafa instead.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'

import { COLLECTIONS, db } from './firebase'

/** Subset of `AuditAction` (src/types/models.ts) this package emits. */
export type AuditAction = 'permission.change'

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
