/// <reference lib="webworker" />

/**
 * Service worker source — bundled by vite-plugin-pwa's `injectManifest`
 * strategy (see vite.config.ts: srcDir 'src', filename 'sw.ts' → dist/sw.js).
 *
 * NOT part of the app's `tsc -b` program (tsconfig.json excludes it): the
 * ServiceWorkerGlobalScope's `self`/`clients`/`registration` types conflict
 * with the DOM lib the rest of the app types against in the same tsconfig
 * "lib" array, and Vite/esbuild transpiles this file without type-checking it
 * regardless. `tsconfig.sw.json` exists solely for manual `tsc -p
 * tsconfig.sw.json --noEmit` checks against this one file's own worker libs —
 * it is not wired into any npm script.
 *
 * Two independent jobs share this one root-scope worker — the standard fix
 * for "vite-plugin-pwa's generated SW and a separate firebase-messaging-sw.js
 * can't both control '/'" (two service workers cannot cleanly co-own one
 * scope):
 *
 *   1. Workbox precaching — the same app-shell behavior the old `generateSW`
 *      config gave via its `workbox: {...}` block (globPatterns +
 *      navigateFallback + cleanupOutdatedCaches). The punch offline queue
 *      (spec §15) is IndexedDB-based application code, not Workbox — nothing
 *      here touches it.
 *   2. Firebase Messaging's background handler — shows a system notification
 *      for a push that arrives while no tab has focus. Foreground pushes
 *      (tab open and focused) are NOT handled here; FCM delivers those to
 *      `onMessage` in the page context instead, which this build does not
 *      yet wire up (out of scope for this change — see PROGRESS.md).
 */

import { initializeApp } from 'firebase/app'
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw'
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>
}

// ── App shell precaching ────────────────────────────────────────────────────
// `self.__WB_MANIFEST` must appear EXACTLY ONCE, literally (not destructured,
// not repeated) — workbox-build's injectManifest asserts there is only one
// match for its injectionPoint text in the whole file and text-replaces that
// one occurrence with the real precache entry list at build time. Capture it
// into a local so the rest of this file can reason about it (e.g. the dev-mode
// guard below) without introducing a second literal match.
cleanupOutdatedCaches()
const precacheManifest = self.__WB_MANIFEST
precacheAndRoute(precacheManifest)

// Same intent as the old `navigateFallback: 'index.html'`: an SPA route with
// no matching precache entry still resolves to the app shell instead of a
// network 404 when offline.
//
// Dev mode's SW (devOptions.enabled) intentionally precaches nothing —
// `precacheManifest` is `[]` there — and createHandlerBoundToURL() throws
// ("not precached") for a URL that isn't in a non-empty manifest. Only wire
// the fallback up when there is something to fall back to; `npm run dev`
// already serves index.html directly for unmatched routes on its own.
if (precacheManifest.length > 0) {
  registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))
}

// ── Firebase Messaging background handler ───────────────────────────────────
// Same values src/lib/firebase.ts reads — VITE_ env vars are inlined at
// build time by Vite, so `import.meta.env` resolves identically in this
// worker bundle. Duplicated rather than imported from lib/firebase.ts: that
// module also touches Auth/Firestore/Storage/Functions and connects
// emulators, none of which belong in a service worker.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? 'demo-api-key',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? 'demo-rk-staffhub.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? 'demo-rk-staffhub',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? 'demo-rk-staffhub.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '000000000000',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '1:000000000000:web:0000000000000000000000',
}

const firebaseApp = initializeApp(firebaseConfig)
const messaging = getMessaging(firebaseApp)

// functions/src/push.ts always sends `notification.{title,body}` plus a
// `data.category` (a PushCategory string, e.g. "trade.pool-drop") — read
// as a plain string here rather than importing the shared union type, since
// this file isn't part of the type-checked app program (see header) and a
// service worker has no real business importing app-level model types.
onBackgroundMessage(messaging, (payload) => {
  const title = payload.notification?.title ?? 'RK Staff Hub'
  self.registration.showNotification(title, {
    body: payload.notification?.body,
    icon: '/pwa-192x192.png',
    data: payload.data,
  })
})

// Focuses an already-open tab, or opens a new one, when the user taps the
// notification itself (not the payload deep link — functions/src/push.ts
// does not currently set FCM's `fcmOptions.link`, so this always lands on
// the app root; ZenZap's separate stub payload does carry a `deepLink`, but
// that is Leah's future integration, not this worker's).
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      const existing = clientsArr.find((c) => 'focus' in c) as WindowClient | undefined
      if (existing) return existing.focus()
      return self.clients.openWindow('/')
    }),
  )
})
