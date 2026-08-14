/**
 * Selfie upload — spec §8. Shared by the live clock-in/out flow and the
 * offline-queue sync path (src/lib/offlineQueue/punchQueue.ts) — both need
 * the exact same upload, just at different moments (immediately vs. once
 * connectivity returns).
 *
 * Path shape must match storage.rules' `punch-selfies/{employeeId}/{yyyy-mm}/{punchId}.jpg`
 * exactly, and the file itself must satisfy its size/content-type
 * constraints (<2MB, image/jpeg) — the Cloud Function re-verifies both
 * server-side (functions/src/punchHelpers.ts's `verifySelfieUpload`), so a
 * mismatch here fails at punch-creation time, not silently.
 */
import { collection, doc } from 'firebase/firestore'
import { ref, uploadBytes } from 'firebase/storage'

import { COLLECTIONS, db, storage } from '@/lib/firebase'

/**
 * A Firestore-native id, minted client-side before the doc exists — same
 * "pre-mint an id, upload/write to it later" pattern `src/lib/db/trades.ts`
 * uses for a fresh trade doc. Works offline too (id generation needs no
 * network round-trip), which the offline queue depends on.
 */
export function mintPunchId(): string {
  return doc(collection(db, COLLECTIONS.punches)).id
}

/** "YYYY-MM" in the restaurant's own timezone — must match the server's own computation exactly. */
function yearMonthInRestaurantTz(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date())
  const year = parts.find((p) => p.type === 'year')?.value ?? '0000'
  const month = parts.find((p) => p.type === 'month')?.value ?? '00'
  return `${year}-${month}`
}

export function selfieStoragePath(employeeId: string, punchId: string): string {
  return `punch-selfies/${employeeId}/${yearMonthInRestaurantTz()}/${punchId}.jpg`
}

/** Uploads a captured selfie JPEG. Throws on failure (network, rules denial) — callers decide whether to queue and retry. */
export async function uploadPunchSelfie(employeeId: string, punchId: string, blob: Blob): Promise<string> {
  const path = selfieStoragePath(employeeId, punchId)
  await uploadBytes(ref(storage, path), blob, { contentType: 'image/jpeg' })
  return path
}
