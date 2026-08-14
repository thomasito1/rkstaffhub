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

import { FieldValue, type DocumentReference } from 'firebase-admin/firestore'
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Never throws. An audit write that fails must not roll back the mutation it
 * describes — that would turn a logging outage into an outage of invite
 * acceptance. Retries once after a short delay (a transient Firestore hiccup
 * is the expected failure mode here, not a persistent outage); if the retry
 * also fails, logs at error level and returns `false` so the caller can set a
 * durable, queryable marker on the record it just mutated — an audit entry
 * may be late, it must never be silently missing (Rafa's ruling, Aug 14
 * 2026). Returns `true` once the entry is written, on either attempt.
 */
export async function writeAudit(input: AuditInput): Promise<boolean> {
  const doc = {
    action: input.action,
    actorEmployeeId: input.actorEmployeeId,
    actorUid: input.actorUid,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    at: FieldValue.serverTimestamp(),
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await db.collection(COLLECTIONS.auditLog).add(doc)
      return true
    } catch (err) {
      logger.error('auditLog write failed', { input, err, attempt })
      if (attempt === 1) await sleep(250)
    }
  }
  return false
}

/**
 * Best-effort follow-up to a `writeAudit()` that returned `false`. Flags the
 * record the audit entry was ABOUT (not auditLog, which just failed) so the
 * gap is queryable from data any admin screen already reads — no new
 * collection, no dependency on a Phase 6 dashboard that doesn't exist yet.
 * Never throws: if even this write fails, the incident is logged and the
 * caller's response to the client is unaffected either way — the state
 * change this audit entry describes already committed.
 */
export async function markAuditPending(
  ref: DocumentReference,
  action: AuditAction,
): Promise<void> {
  try {
    await ref.update({
      auditPending: true,
      auditPendingAction: action,
      auditPendingAt: FieldValue.serverTimestamp(),
    })
  } catch (err) {
    logger.error('failed to set auditPending marker after an audit write failure', {
      path: ref.path,
      action,
      err,
    })
  }
}
