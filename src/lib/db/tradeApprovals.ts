/**
 * One extra trade read `trades.ts` doesn't expose: every trade currently
 * awaiting a MANAGER's decision, regardless of which employee is a party to
 * it — a manager approving isn't `fromEmployeeId`, `postedBy`, `toEmployeeId`
 * or `claimedBy` on the trade they're reviewing, so `listMyTrades()` can't
 * find it for them. Kept as its own module rather than added to trades.ts
 * (off-limits for this change) — same "later phases add their own module
 * here" pattern this barrel file's own comment already describes.
 *
 * firestore.rules' `mayReadTrade()` grants a full, unscoped read to anyone
 * holding `trades.approve` (its `hasPerm('trades.approve')` branch) —
 * department scoping for approvals (spec §4) is a UI/Function-level concern
 * layered on top via `canApproveForDepartment()`, not a read-time
 * restriction, so one `status in [...]` query covers every department and
 * the caller narrows it afterwards.
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
import type { Department, Trade, TradeEligibilitySnapshot, TradeStatus } from '@/types/models'

import { isPermissionDenied } from './errors'

function toTrade(snap: QueryDocumentSnapshot<DocumentData>): Trade {
  const d = snap.data()
  return {
    id: snap.id,
    type: d.type === 'direct' ? 'direct' : 'pool',
    shiftId: String(d.shiftId ?? ''),
    weekId: String(d.weekId ?? ''),
    fromEmployeeId: (d.fromEmployeeId as string | null) ?? null,
    postedBy: String(d.postedBy ?? ''),
    toEmployeeId: (d.toEmployeeId as string | null) ?? null,
    claimedBy: (d.claimedBy as string | null) ?? null,
    status: (d.status as TradeStatus) ?? 'open',
    approvedBy: (d.approvedBy as string | null) ?? null,
    declineReason: (d.declineReason as string | null) ?? null,
    department: d.department as Department,
    eligibilitySnapshot: d.eligibilitySnapshot as TradeEligibilitySnapshot,
    message: (d.message as string | null) ?? null,
    expiresAt: d.expiresAt ?? null,
    locationId: (d.locationId as string | null) ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

function byCreatedAsc(a: Trade, b: Trade): number {
  const at = (v: unknown) =>
    v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0
  return at(a.createdAt) - at(b.createdAt)
}

export interface PendingTradeApprovals {
  /** type='pool', status='claimed' — a first-come claim awaiting sign-off. */
  poolClaims: Trade[]
  /** type='direct', status='pending-approval' — the named recipient accepted. */
  directPending: Trade[]
}

/** Everything currently awaiting a manager decision, across every department. */
export async function listTradesAwaitingApproval(): Promise<PendingTradeApprovals> {
  const empty: PendingTradeApprovals = { poolClaims: [], directPending: [] }
  try {
    const snap = await getDocs(
      query(
        collection(db, COLLECTIONS.trades),
        where('status', 'in', ['claimed', 'pending-approval'] satisfies TradeStatus[]),
      ),
    )
    const all = snap.docs.map(toTrade).sort(byCreatedAsc)
    return {
      poolClaims: all.filter((t) => t.type === 'pool' && t.status === 'claimed'),
      directPending: all.filter((t) => t.type === 'direct' && t.status === 'pending-approval'),
    }
  } catch (err) {
    if (isPermissionDenied(err)) return empty
    throw err
  }
}
