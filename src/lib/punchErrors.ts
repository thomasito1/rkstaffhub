/**
 * Typed error vocabulary for the punch Cloud Functions
 * (functions/src/punchActions.ts) and their client wrappers — same reasoning
 * as TradeErrorCode (src/lib/scheduling/tradeEligibility.ts): a callable's own
 * `code` is locked to Firebase's fixed enum, so a specific reason travels in
 * `HttpsError`'s `details.code` instead, and both sides need the same string
 * literals. Pure, no Firebase imports — reached from functions/ via the same
 * symlink trick as the other shared modules in this codebase.
 */
export type PunchErrorCode =
  | 'punch/clock-not-required'
  | 'punch/already-open'
  | 'punch/no-open-punch'
  | 'punch/selfie-missing'
  | 'punch/selfie-invalid'
  | 'punch/selfie-stale'
  | 'punch/gps-imprecise'
  | 'punch/outside-geofence'
  | 'punch/shift-mismatch'
  | 'punch/tips-required'
  | 'punch/reason-required'
  | 'punch/below-level-required'
