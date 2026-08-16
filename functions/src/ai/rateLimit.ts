/**
 * Cost guard for `generateAiSchedule` (spec §13, Rafa's guardrail #7:
 * "rate-limit the generation callable"). A single restaurant-wide rolling
 * window rather than per-employee — the actual cost driver is total LLM
 * spend, not who's calling it, and this is small enough (~35 employees, a
 * handful of managers who could plausibly call this) that a shared cap is
 * simpler and just as effective at stopping a runaway retry loop or a
 * misbehaving client from burning real API spend.
 *
 * THE THRESHOLD IS A STARTING GUESS, not a number Rafa gave us — spec §13
 * says "rate-limit" without a number. Flagged in PROGRESS.md's open
 * questions; tune once real usage/cost data exists.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/v2/https'

import { AI_RATE_LIMIT_ID, COLLECTIONS, db } from '../firebase'

export const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000 // 10 minutes
export const RATE_LIMIT_MAX_PER_WINDOW = 5

/**
 * Throws `resource-exhausted` if the restaurant has already made
 * `RATE_LIMIT_MAX_PER_WINDOW` generation calls within the trailing window;
 * otherwise records this call and returns. Transactional so two concurrent
 * calls can't both read the same under-limit count and both proceed.
 */
export async function checkAndRecordGeneration(): Promise<void> {
  const ref = db.collection(COLLECTIONS.settings).doc(AI_RATE_LIMIT_ID)

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    const now = Date.now()
    const existing = (snap.get('recentGenerationsAtMs') as number[] | undefined) ?? []
    const pruned = existing.filter((t) => now - t < RATE_LIMIT_WINDOW_MS)

    if (pruned.length >= RATE_LIMIT_MAX_PER_WINDOW) {
      throw new HttpsError(
        'resource-exhausted',
        `Too many AI schedule generations — limit is ${RATE_LIMIT_MAX_PER_WINDOW} per ${RATE_LIMIT_WINDOW_MS / 60_000} minutes. Try again shortly.`,
      )
    }

    pruned.push(now)
    tx.set(ref, { recentGenerationsAtMs: pruned, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  })
}
