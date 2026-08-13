/**
 * App settings data access — `settings/app` (spec §3).
 *
 * One document, read by nearly every screen (geofence for the clock §8,
 * deadlines for availability §5 and publishing §6, timezone for all deadline
 * math). Rules: any signed-in user reads; `settings.manage` writes.
 *
 * There is deliberately no DEFAULT_APP_SETTINGS constant here. The seeded
 * values live in exactly one place — scripts/seed.ts — so an environment can
 * never drift between "what the code assumes" and "what the document says".
 * Callers must handle `null` (unseeded) rather than silently falling back to a
 * geofence that would let people clock in from anywhere.
 */

import {
  doc,
  getDoc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
  type FirestoreError,
} from 'firebase/firestore'

import { COLLECTIONS, db } from '@/lib/firebase'
import type { AppSettings, FeatureFlags } from '@/types/models'

const APP_SETTINGS_ID = 'app'

function appSettingsDoc() {
  return doc(db, COLLECTIONS.settings, APP_SETTINGS_ID)
}

/** `null` when settings/app has not been seeded yet. */
export async function getAppSettings(): Promise<AppSettings | null> {
  const snap = await getDoc(appSettingsDoc())
  return snap.exists() ? (snap.data() as AppSettings) : null
}

/**
 * Live settings. Used by the clock so an admin widening the geofence takes
 * effect without a reload. Returns the unsubscribe function.
 */
export function subscribeAppSettings(
  onChange: (settings: AppSettings | null) => void,
  onError?: (err: FirestoreError) => void,
): () => void {
  return onSnapshot(
    appSettingsDoc(),
    (snap) => onChange(snap.exists() ? (snap.data() as AppSettings) : null),
    onError,
  )
}

/** Shallow merge. Nested objects (geofence, featureFlags) are replaced wholesale. */
export async function updateAppSettings(patch: Partial<AppSettings>): Promise<void> {
  await updateDoc(appSettingsDoc(), { ...patch, updatedAt: serverTimestamp() })
}

/** Create-or-replace. Used by the seed script and first-run setup. */
export async function writeAppSettings(settings: AppSettings): Promise<void> {
  await setDoc(appSettingsDoc(), { ...settings, updatedAt: serverTimestamp() })
}

/**
 * Flip a single feature flag. Read-modify-write rather than a dotted path so
 * the flag map stays a single object and an unknown flag cannot be introduced
 * by a typo in a caller.
 */
export async function setFeatureFlag<K extends keyof FeatureFlags>(
  flag: K,
  value: FeatureFlags[K],
): Promise<void> {
  const current = await getAppSettings()
  if (!current) throw new Error('settings/app does not exist — run the seed first.')
  await updateAppSettings({ featureFlags: { ...current.featureFlags, [flag]: value } })
}
