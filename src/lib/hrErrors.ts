/**
 * Typed error vocabulary for the HR Cloud Functions
 * (functions/src/disciplinaryActions.ts, functions/src/signatures.ts) and
 * their client wrappers — same reasoning as `PunchErrorCode`/`TradeErrorCode`:
 * a callable's own `code` is locked to Firebase's fixed enum, so a specific
 * reason travels in `HttpsError`'s `details.code` instead, and both sides
 * need the same string literals. Pure, no Firebase imports — reached from
 * functions/ via the same symlink trick as the other shared modules.
 */
export type HrErrorCode =
  | 'hr/below-level-required'
  | 'hr/not-own-target'
  | 'hr/already-resolved'
  | 'hr/invalid-signature-image'
  | 'hr/reason-required'
