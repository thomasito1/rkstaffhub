/**
 * AI provider settings — `settings/aiProviders` (spec §13, Phase 5).
 * Metadata only (provider, model, last4, active flag) — the key itself
 * never reaches the client (`firestore.rules`: read is `ai.configureKeys`-
 * gated, write is Cloud-Function-only). Writes go through
 * `src/lib/ai/aiActions.ts`'s `configureAiProvider`/`setActiveAiProvider`
 * callables, never a plain client write.
 */
import { doc, getDoc } from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import type { AiSettings } from '@/types/models'

import { readOrNullIfDenied } from './errors'

const AI_SETTINGS_ID = 'aiProviders'

/** `null` means either nothing configured yet OR the caller lacks `ai.configureKeys` — the rules deny a read outright rather than returning an empty doc, so this is not distinguishable from here, matching every other `readOrNullIfDenied` read in this codebase. */
export async function getAiSettings(): Promise<AiSettings | null> {
  return readOrNullIfDenied(async () => {
    const snap = await getDoc(doc(db, COLLECTIONS.settings, AI_SETTINGS_ID))
    if (!snap.exists()) return null
    const d = snap.data()
    return {
      id: snap.id,
      active: (d.active as AiSettings['active']) ?? null,
      providers: d.providers ?? {},
      updatedAt: d.updatedAt,
    }
  })
}
