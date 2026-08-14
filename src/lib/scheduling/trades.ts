/**
 * Client wrappers for the trade-transition Cloud Functions — see
 * `functions/src/tradeActions.ts` for what each independently re-verifies and
 * why claim/accept/approve/decline cannot be plain client writes.
 *
 * Posting a trade and cancelling your own open post ARE plain client writes —
 * see `src/lib/db/trades.ts` — because those risk nothing irreversible and
 * firestore.rules already permits them directly.
 */
import { httpsCallable, type FunctionsError } from 'firebase/functions'
import { functions } from '@/lib/firebase'

export class TradeActionRejected extends Error {
  constructor(
    message: string,
    public readonly code: FunctionsError['code'],
    /** Carries `{ code: TradeErrorCode }` when the Function set one — see firebaseError.ts. */
    public readonly details: unknown,
  ) {
    super(message)
    this.name = 'TradeActionRejected'
  }
}

async function callTradeAction<Req, Res>(name: string, input: Req): Promise<Res> {
  const call = httpsCallable<Req, Res>(functions, name)
  try {
    const res = await call(input)
    return res.data
  } catch (err) {
    const fnErr = err as FunctionsError
    throw new TradeActionRejected(fnErr.message ?? 'Trade action failed', fnErr.code, fnErr.details)
  }
}

export interface ClaimTradeResult {
  tradeId: string
  status: 'claimed'
  claimedBy: string
  notifyEmployeeIds: string[]
}

/** Pool only — first-come claim on an open drop (spec §7). */
export function claimTrade(tradeId: string): Promise<ClaimTradeResult> {
  return callTradeAction('claimTrade', { tradeId })
}

export interface AcceptTradeResult {
  tradeId: string
  status: 'pending-approval'
  notifyEmployeeIds: string[]
}

/** Direct only — the named recipient accepts an offer. */
export function acceptTrade(tradeId: string): Promise<AcceptTradeResult> {
  return callTradeAction('acceptTrade', { tradeId })
}

export interface ApproveTradeInput {
  tradeId: string
  /** Required only when the assignee currently fails eligibility. */
  overrideReason?: string
}

export interface ApproveTradeResult {
  tradeId: string
  status: 'approved'
  assigneeId: string
  overridden: boolean
  notifyEmployeeIds: string[]
}

/**
 * A manager (or GM/Owner) approves a claimed/pending-approval trade. Pass
 * `overrideReason` only once the UI has already shown the assignee is
 * ineligible and a `trades.manualAssign` holder confirms anyway — the
 * Function logs it to auditLog (`trade.override`, spec §7/§17).
 */
export function approveTrade(input: ApproveTradeInput): Promise<ApproveTradeResult> {
  return callTradeAction('approveTrade', input)
}

export interface DeclineTradeInput {
  tradeId: string
  reason?: string
}

export interface DeclineTradeResult {
  tradeId: string
  /** Pool declines reopen for anyone else to claim; direct declines are terminal. */
  status: 'open' | 'declined'
  notifyEmployeeIds: string[]
}

export function declineTrade(input: DeclineTradeInput): Promise<DeclineTradeResult> {
  return callTradeAction('declineTrade', input)
}
