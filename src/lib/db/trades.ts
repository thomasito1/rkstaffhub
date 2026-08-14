/**
 * Trade data access — `trades/{tradeId}` (spec §7, §17).
 *
 * Posting and cancelling your own still-open post are the only trade writes
 * firestore.rules lets a client make (see its `mayCreate`/`isOwnCancel`).
 * Every other transition — claim, accept, approve, decline — is unreachable
 * from a client `update` at all, because each needs eligibility independently
 * recomputed against the CURRENT shift, not trusted from a stale snapshot
 * (the same reasoning `TradeEligibilitySnapshot`'s own doc comment gives, and
 * why ShiftModal recomputes eligibility live rather than trusting a cached
 * value). Those four live in `src/lib/scheduling/trades.ts`, thin wrappers
 * over the `tradeActions` Cloud Functions.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import type { Department, Trade, TradeEligibilitySnapshot, TradeStatus, TradeType } from '@/types/models'

import { isPermissionDenied, readOrNullIfDenied } from './errors'
import { getShift } from './schedules'

/** Direct offers only (mockup 18c) — advisory display window, not enforced (see PROGRESS.md's Phase 3 scheduled-sweep note). */
const DIRECT_EXPIRY_MS = 48 * 60 * 60 * 1000

export interface NewTradeInput {
  type: TradeType
  shiftId: string
  weekId: string
  /** null only for a manager posting an already-open shift to the pool. */
  fromEmployeeId: string | null
  postedBy: string
  /** Direct offers only; required for 'direct', must be omitted for 'pool'. */
  toEmployeeId?: string | null
  message?: string | null
  locationId?: string | null
}

function tradeDoc(id: string) {
  return doc(db, COLLECTIONS.trades, id)
}

function toTrade(
  snap: DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>,
): Trade {
  const d = snap.data() ?? {}
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

/** Newest post first. */
function byCreatedDesc(a: Trade, b: Trade): number {
  const at = (v: unknown) => (v && typeof v === 'object' && 'toMillis' in v ? (v as { toMillis(): number }).toMillis() : 0)
  return at(b.createdAt) - at(a.createdAt)
}

/**
 * True once a direct offer's 48h window has passed. Display-only: nothing
 * currently flips `status` on expiry (no enforcement mechanism exists yet —
 * scheduled against Phase 3's Cloud Scheduler work, see PROGRESS.md), so a
 * still-`open` expired offer must be rendered as expired client-side rather
 * than trusted at face value.
 */
export function isTradeExpired(trade: Trade, now: Date = new Date()): boolean {
  if (trade.type !== 'direct' || trade.status !== 'open') return false
  const raw = trade.expiresAt
  const expiresAt =
    raw instanceof Date
      ? raw
      : raw && typeof raw === 'object' && 'toDate' in raw
        ? (raw as { toDate(): Date }).toDate()
        : null
  return expiresAt != null && expiresAt.getTime() <= now.getTime()
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function getTrade(id: string): Promise<Trade | null> {
  return readOrNullIfDenied(async () => {
    const snap = await getDoc(tradeDoc(id))
    return snap.exists() ? toTrade(snap) : null
  })
}

/** Open pool trades in one department — mockup 16's browsable pool. */
export async function listOpenTradesForDepartment(department: Department): Promise<Trade[]> {
  try {
    const snap = await getDocs(
      query(
        collection(db, COLLECTIONS.trades),
        where('type', '==', 'pool'),
        where('status', '==', 'open'),
        where('department', '==', department),
      ),
    )
    return snap.docs.map(toTrade).sort(byCreatedDesc)
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}

/**
 * Every trade where `employeeId` is a party — poster, offer recipient, or
 * pool claimant. Firestore has no single query across four different fields,
 * so this runs four narrow equality queries (each already covered by
 * `mayReadTrade`) and merges by id — simpler and index-free versus a
 * composite `or()` query for a roster this size (spec: ~35 employees).
 */
export async function listMyTrades(employeeId: string): Promise<Trade[]> {
  const fields = ['fromEmployeeId', 'postedBy', 'toEmployeeId', 'claimedBy'] as const

  try {
    const snapshots = await Promise.all(
      fields.map((field) =>
        getDocs(query(collection(db, COLLECTIONS.trades), where(field, '==', employeeId))),
      ),
    )
    const byId = new Map<string, Trade>()
    for (const snap of snapshots) {
      for (const d of snap.docs) byId.set(d.id, toTrade(d))
    }
    return Array.from(byId.values()).sort(byCreatedDesc)
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}

// ── writes ───────────────────────────────────────────────────────────────────

/**
 * Post a trade — a self-service drop/offer, or a manager posting an
 * already-open shift to the pool. Department and eligibilitySnapshot are
 * derived from the REAL shift, never trusted from the caller, matching what
 * firestore.rules' `matchesShift()` independently re-verifies server-side.
 */
export async function createTrade(input: NewTradeInput): Promise<Trade> {
  const shift = await getShift(input.weekId, input.shiftId)
  if (!shift) {
    throw new Error(`Shift ${input.weekId}/${input.shiftId} does not exist.`)
  }

  if (input.fromEmployeeId) {
    if (shift.employeeId !== input.fromEmployeeId) {
      throw new Error('This shift is not assigned to the employee posting the trade.')
    }
  } else if (shift.employeeId) {
    throw new Error('Only an unassigned shift can be posted to the pool by a manager.')
  }

  if (input.type === 'direct' && !input.toEmployeeId) {
    throw new Error('A direct trade needs a recipient.')
  }
  if (input.type === 'pool' && input.toEmployeeId) {
    throw new Error('A pool trade has no fixed recipient.')
  }

  const ref = doc(collection(db, COLLECTIONS.trades))
  const payload = {
    type: input.type,
    shiftId: input.shiftId,
    weekId: input.weekId,
    fromEmployeeId: input.fromEmployeeId,
    postedBy: input.postedBy,
    toEmployeeId: input.type === 'direct' ? (input.toEmployeeId ?? null) : null,
    claimedBy: null,
    status: 'open' as const,
    approvedBy: null,
    declineReason: null,
    department: shift.department,
    eligibilitySnapshot: {
      roleId: shift.roleId,
      requiredSkillLevel: shift.requiredSkillLevel,
    },
    message: input.message?.trim() || null,
    expiresAt: input.type === 'direct' ? new Date(Date.now() + DIRECT_EXPIRY_MS) : null,
    locationId: input.locationId ?? null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  await setDoc(ref, payload)

  return { id: ref.id, ...payload }
}

/** Withdraw your own still-open post. Every other transition is a Cloud Function. */
export async function cancelTrade(id: string, postedBy: string): Promise<void> {
  const existing = await getTrade(id)
  if (!existing) throw new Error(`Trade ${id} does not exist.`)
  if (existing.postedBy !== postedBy) {
    throw new Error('Only the poster can cancel this trade.')
  }
  if (existing.status !== 'open') {
    throw new Error(`Only an open trade can be cancelled (this one is ${existing.status}).`)
  }

  await updateDoc(tradeDoc(id), {
    fromEmployeeId: existing.fromEmployeeId,
    postedBy: existing.postedBy,
    toEmployeeId: existing.toEmployeeId,
    claimedBy: existing.claimedBy,
    type: existing.type,
    shiftId: existing.shiftId,
    weekId: existing.weekId,
    department: existing.department,
    eligibilitySnapshot: existing.eligibilitySnapshot,
    status: 'cancelled',
    updatedAt: serverTimestamp(),
  })
}
