/**
 * Task-photo upload — spec §10 photo-proof mechanic, gated by
 * `featureFlags.taskPhotoProof`. Same shape as
 * `src/lib/timeClock/selfieUpload.ts`: upload to Storage BEFORE calling the
 * completing action (`completeTaskInstance`), so the instance is never marked
 * done without its proof already durably stored.
 *
 * Path must match storage.rules' `task-photos/{employeeId}/{fileName}`
 * exactly (create-only, <2MB, image/jpe?g) — a photo write is immutable, so
 * the filename must be unique per completion attempt (never reused for a
 * retry of the same instance).
 */
import { ref, uploadBytes } from 'firebase/storage'

import { storage } from '@/lib/firebase'

export function taskPhotoStoragePath(employeeId: string, instanceId: string): string {
  return `task-photos/${employeeId}/${instanceId}-${Date.now()}.jpg`
}

/** Uploads a task-completion photo. Throws on failure — the caller decides how to surface it. */
export async function uploadTaskPhoto(employeeId: string, instanceId: string, blob: Blob): Promise<string> {
  const path = taskPhotoStoragePath(employeeId, instanceId)
  await uploadBytes(ref(storage, path), blob, { contentType: 'image/jpeg' })
  return path
}
