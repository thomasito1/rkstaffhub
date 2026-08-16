/**
 * Escalation ladder config — a single `disciplinaryLadder/{ladderId}` doc,
 * readable by anyone signed in (firestore.rules), writable only via
 * `settings.manage`. `src/lib/hr/disciplinaryLadder.ts` is the pure
 * computation this config feeds.
 */
import { collection, getDocs, limit, query } from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import type { DisciplinaryLadder } from '@/types/models'

import { isPermissionDenied } from './errors'

/** There is exactly one ladder config document; the seed/Settings UI enforces that singleton convention. */
export async function getDisciplinaryLadder(): Promise<DisciplinaryLadder | null> {
  try {
    const snap = await getDocs(query(collection(db, COLLECTIONS.disciplinaryLadder), limit(1)))
    if (snap.empty) return null
    const first = snap.docs[0]
    if (!first) return null
    const d = first.data()
    return {
      id: first.id,
      steps: Array.isArray(d.steps) ? d.steps : [],
      locationId: (d.locationId as string | null) ?? null,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    }
  } catch (err) {
    if (isPermissionDenied(err)) return null
    throw err
  }
}
