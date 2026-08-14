/**
 * Firebase's SDKs disagree on error-code SHAPE, and that disagreement caused a
 * real bug (see below) — this module exists to kill the whole class of it,
 * not just the one instance that got caught.
 *
 *   - firebase/firestore: bare,                e.g. 'permission-denied'
 *   - firebase/auth:      prefix baked into the code itself, e.g. 'auth/user-not-found'
 *   - firebase/functions: WRAPS the callable's HttpsError code with a
 *                         'functions/' prefix, e.g. 'functions/failed-precondition'
 *   - firebase/storage:   prefixed,             e.g. 'storage/unauthorized'
 *
 * A bare `err.code === 'failed-precondition'` matches Firestore-shaped codes
 * but silently NEVER matches the other three SDKs — which is exactly what
 * happened in the schedule-override rejection handler: `override.ts`'s own
 * `RecordScheduleOverrideRequest` throws `failed-precondition` /
 * `aborted` via `HttpsError` server-side, the client SDK reports it back as
 * `functions/failed-precondition`, and a bare comparison against the short
 * name never fired.
 *
 * `isFirebaseError()` compares the CODE'S TAIL, so every caller writes the
 * short, memorable form the server actually threw (`'failed-precondition'`,
 * `'permission-denied'`, `'user-not-found'`) and it matches regardless of
 * which SDK's prefix convention produced the error. Route every Firebase
 * error-code comparison through this — do not write a bare `.code === '...'`
 * check again; that is how this bug came back.
 */

export function isFirebaseError(err: unknown, code: string): boolean {
  const actual = firebaseErrorCode(err)
  return actual !== null && (actual === code || actual.endsWith(`/${code}`))
}

/**
 * The error's `code` field as a string, or `null` if it isn't Firebase-shaped.
 *
 * A callable's `HttpsError` code is always one of Firebase's fixed
 * `FunctionsErrorCode` values (wrapped client-side as `functions/<code>`) —
 * never an app-specific string. When a callable needs a more specific reason
 * than that fixed enum offers (e.g. trade eligibility's `trade/ineligible-skill`),
 * it puts the enumerated app code in `HttpsError`'s `details.code` instead
 * (functions/src/tradeActions.ts). Preferring `details.code` here, when
 * present, keeps this the one place every caller compares error codes —
 * regardless of which layer produced the specific string.
 */
export function firebaseErrorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null

  const details = (err as { details?: unknown }).details
  if (details && typeof details === 'object' && 'code' in details) {
    const detailCode = (details as { code?: unknown }).code
    if (typeof detailCode === 'string') return detailCode
  }

  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}
