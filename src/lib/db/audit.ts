/**
 * Audit log data access — `auditLog/{entryId}` (spec §3, §17).
 *
 * WRITES ARE SERVER-SIDE ONLY. firestore.rules denies create/update/delete on
 * auditLog to every client unconditionally; a log a client can write is a log a
 * client can forge. Cloud Functions append entries as part of the sensitive
 * mutation they are recording (punch/tip edits, publishes, overrides, key
 * changes, period locks, imports — CLAUDE.md).
 *
 * This module therefore exposes reads, plus buildAuditEntry() as the shared
 * payload shape so the Functions and the viewer cannot drift apart.
 */

import {
  collection,
  getDocs,
  limit as limitTo,
  orderBy,
  query,
  serverTimestamp,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import type { AuditAction, AuditEntry } from '@/types/models'

const DEFAULT_LIMIT = 100

function toAuditEntry(snap: QueryDocumentSnapshot<DocumentData>): AuditEntry {
  const d = snap.data()
  return {
    id: snap.id,
    action: d.action as AuditAction,
    actorEmployeeId: String(d.actorEmployeeId ?? ''),
    actorUid: String(d.actorUid ?? ''),
    targetType: String(d.targetType ?? ''),
    targetId: String(d.targetId ?? ''),
    reason: (d.reason as string | null) ?? null,
    before: d.before,
    after: d.after,
    at: d.at,
  }
}

/**
 * Newest entries first. Requires `settings.manage` (rules) — the audit-log
 * viewer is a Phase 6 screen, but reads are available now for debugging.
 *
 * Ordered by `at` alone, which the automatic single-field index covers.
 */
export async function listRecentAuditEntries(max = DEFAULT_LIMIT): Promise<AuditEntry[]> {
  const snap = await getDocs(
    query(collection(db, COLLECTIONS.auditLog), orderBy('at', 'desc'), limitTo(max)),
  )
  return snap.docs.map(toAuditEntry)
}

/** Everything recorded against one action type, newest first. */
export async function listAuditEntriesByAction(
  action: AuditAction,
  max = DEFAULT_LIMIT,
): Promise<AuditEntry[]> {
  const snap = await getDocs(
    query(
      collection(db, COLLECTIONS.auditLog),
      where('action', '==', action),
      orderBy('at', 'desc'),
      limitTo(max),
    ),
  )
  return snap.docs.map(toAuditEntry)
}

/**
 * The history of one record — e.g. every edit to one employee's punches.
 *
 * Filters on `targetType` server-side (the composite index in
 * firestore.indexes.json covers targetType + at DESC) and on `targetId`
 * client-side. Adding targetId to the query would need a third index for what
 * is, at this data volume, a trivial filter over an already-bounded page.
 */
export async function listAuditEntriesForTarget(
  targetType: string,
  targetId: string,
  max = DEFAULT_LIMIT,
): Promise<AuditEntry[]> {
  const snap = await getDocs(
    query(
      collection(db, COLLECTIONS.auditLog),
      where('targetType', '==', targetType),
      orderBy('at', 'desc'),
      limitTo(max * 4),
    ),
  )
  return snap.docs
    .map(toAuditEntry)
    .filter((e) => e.targetId === targetId)
    .slice(0, max)
}

/**
 * The canonical write payload. Callable from a Cloud Function (which is the
 * only context whose writes the rules accept); exported here so the shape stays
 * in one place.
 *
 * `reason` is required by spec §9 for punch and tip edits and by §7 for a
 * manager's trade override — pass it whenever the action supports one.
 */
export function buildAuditEntry(input: {
  action: AuditAction
  actorEmployeeId: string
  actorUid: string
  targetType: string
  targetId: string
  reason?: string | null
  before?: unknown
  after?: unknown
}): Omit<AuditEntry, 'id'> {
  return {
    action: input.action,
    actorEmployeeId: input.actorEmployeeId,
    actorUid: input.actorUid,
    targetType: input.targetType,
    targetId: input.targetId,
    reason: input.reason ?? null,
    before: input.before ?? null,
    after: input.after ?? null,
    at: serverTimestamp(),
  }
}
