import type { TFunction } from 'i18next'

import { isFirebaseError } from '@/lib/firebaseError'

/**
 * Maps a `generateAiSchedule` failure (thrown as `AiActionRejected` by
 * `src/lib/ai/aiActions.ts`) to a bilingual, user-facing string — CLAUDE.md
 * forbids surfacing a raw error, and `AiActionRejected.message` is whatever
 * the callable happened to throw (including plain-Error messages like the
 * dev secret store's "no value stored for ...", which must never reach a
 * user verbatim).
 *
 * Shared by the toolbar "Generate with AI" button and the banner's
 * "regenerate with instructions" box — both call the same callable and must
 * treat the same failure the same way.
 *
 * Uses `isFirebaseError` (not a bare `.code === '...'`) per
 * `src/lib/firebaseError.ts`'s own warning: a callable's code arrives
 * prefixed ('functions/resource-exhausted'), so a bare comparison silently
 * never matches.
 *
 *   - 'resource-exhausted' → the cost-guard rate limit (functions/src/ai/
 *     rateLimit.ts) — a specific "try again shortly" message, not generic.
 *   - 'failed-precondition' → the week is already live, or no AI provider is
 *     configured/active yet (functions/src/ai/generate.ts).
 *   - anything else (including 'internal', which is what an uncaught plain
 *     `Error` — e.g. the seeded "no secret configured" case — surfaces as)
 *     falls back to a generic, non-crashing message.
 */
export function aiErrorMessage(t: TFunction, err: unknown): string {
  if (isFirebaseError(err, 'resource-exhausted')) {
    return t('scheduleBuilder.ai.error.rateLimited')
  }
  if (isFirebaseError(err, 'failed-precondition')) {
    return t('scheduleBuilder.ai.error.notReady')
  }
  return t('scheduleBuilder.ai.error.generic')
}
