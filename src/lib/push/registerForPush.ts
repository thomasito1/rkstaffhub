/**
 * FCM web-push registration — client half of Phase 2 push notifications.
 * Server-side send lives in functions/src/push.ts / tradeTriggers.ts; this
 * module's only job is to get an FCM token for THIS browser and merge it into
 * `employees/{id}.pushTokens` (src/types/models.ts's PushToken/PushPlatform —
 * see registerPushToken() in src/lib/db/employees.ts for the merge rule).
 *
 * Platform is always 'web' here — this is the browser/PWA client. A native
 * iOS/Android registration, if one is ever built, is a different module; the
 * `PushPlatform` union already has room for it.
 *
 * NEVER call this from AuthProvider/login (CLAUDE.md: permission requests
 * must happen in context, not at sign-in). This module only exports plain
 * functions + one hook; something else decides *when* to call them —
 * typically PushPermissionPrompt's "Allow" action for the first registration,
 * and usePushForegroundRefresh for the silent on-foreground refresh.
 */

import { useEffect } from 'react'
import { getMessaging, getToken } from 'firebase/messaging'

import { app } from '@/lib/firebase'
import { registerPushToken } from '@/lib/db/employees'

/** Matches vite.config.ts's injectManifest `filename` (src/sw.ts → dist/sw.js). */
const SW_URL = '/sw.js'

/** Namespaced so it never collides with another app's key on the same origin. */
const LAST_TOKEN_KEY = 'rk-staffhub:push-token:web'

export type PushRegistrationStatus =
  | 'registered'
  | 'unsupported'
  | 'denied'
  | 'no-vapid-key'
  | 'error'

export interface PushRegistrationResult {
  status: PushRegistrationStatus
  token?: string
}

function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window
  )
}

/** Reuses an already-registered worker at this scope rather than re-registering on every call. */
async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(SW_URL)
  if (existing) return existing
  return navigator.serviceWorker.register(SW_URL, { type: 'module' })
}

/**
 * Shared by both entry points below: register the SW, fetch a token, merge it
 * into Firestore. Assumes Notification permission has already been decided —
 * callers gate on that (requesting it, or checking it's already granted)
 * before reaching here.
 */
async function fetchAndStoreToken(employeeId: string): Promise<PushRegistrationResult> {
  const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined
  if (!vapidKey) {
    console.warn(
      '[push] VITE_FIREBASE_VAPID_KEY is not set (see .env.example) — skipping token registration.',
    )
    return { status: 'no-vapid-key' }
  }

  try {
    const registration = await getServiceWorkerRegistration()
    const messaging = getMessaging(app)
    const token = await getToken(messaging, {
      vapidKey,
      serviceWorkerRegistration: registration,
    })
    if (!token) return { status: 'error' }

    const previousToken = window.localStorage.getItem(LAST_TOKEN_KEY)
    await registerPushToken(employeeId, {
      token,
      platform: 'web',
      replaceToken: previousToken && previousToken !== token ? previousToken : null,
    })
    window.localStorage.setItem(LAST_TOKEN_KEY, token)

    return { status: 'registered', token }
  } catch (err) {
    console.error('[push] failed to register for push', err)
    return { status: 'error' }
  }
}

/**
 * Explicit opt-in path — call this from the "Allow" action of a permission
 * prompt (see PushPermissionPrompt). Requests Notification permission if it
 * hasn't been decided yet; a user who already denied it gets 'denied' back
 * immediately (browsers never re-prompt once denied).
 */
export async function requestAndRegisterPush(
  employeeId: string,
): Promise<PushRegistrationResult> {
  if (!isPushSupported()) return { status: 'unsupported' }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return { status: 'denied' }

  return fetchAndStoreToken(employeeId)
}

/**
 * Silent refresh — never prompts. A no-op unless this browser already has
 * permission granted from a prior Allow. FCM tokens can rotate, so a device
 * that only ever registered once at first-Allow could go quietly stale;
 * usePushForegroundRefresh calls this on every app-foreground to catch that.
 */
export async function refreshPushTokenIfGranted(
  employeeId: string,
): Promise<PushRegistrationResult> {
  if (!isPushSupported()) return { status: 'unsupported' }
  if (Notification.permission !== 'granted') return { status: 'denied' }

  return fetchAndStoreToken(employeeId)
}

/**
 * Re-runs token registration whenever the app comes back to the foreground
 * (tab becomes visible, or the window regains focus) — see
 * refreshPushTokenIfGranted() above for why this is more than a one-shot
 * on-mount registration. Safe to call before auth resolves: does nothing
 * while `employeeId` is null/undefined.
 *
 * Call once from whichever screen owns the signed-in employeeId (e.g. a
 * future Shift Pool page, after its own first-visit PushPermissionPrompt).
 */
export function usePushForegroundRefresh(employeeId: string | null | undefined): void {
  useEffect(() => {
    if (!employeeId) return

    function onForeground() {
      if (document.visibilityState === 'visible' && employeeId) {
        void refreshPushTokenIfGranted(employeeId)
      }
    }

    document.addEventListener('visibilitychange', onForeground)
    window.addEventListener('focus', onForeground)
    return () => {
      document.removeEventListener('visibilitychange', onForeground)
      window.removeEventListener('focus', onForeground)
    }
  }, [employeeId])
}
