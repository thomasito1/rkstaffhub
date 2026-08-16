/**
 * Admin SDK singletons for every Function in this codebase.
 *
 * The admin SDK bypasses firestore.rules. That is correct here and nowhere
 * else: `auditLog` is `create: false` for all clients and `invites` is
 * `update: false`, precisely so that only this server can append an audit
 * entry or mark an invite accepted (spec §17, firestore.rules).
 *
 * Because rules are bypassed, every Function in this package must re-derive
 * authorization itself. See `permissions.ts`.
 */

import { getApps, initializeApp, type App } from 'firebase-admin/app'
import { getAuth, type Auth } from 'firebase-admin/auth'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import { getStorage, type Storage } from 'firebase-admin/storage'

const app: App = getApps()[0] ?? initializeApp()

export const db: Firestore = getFirestore(app)
export const adminAuth: Auth = getAuth(app)
export const storage: Storage = getStorage(app)

/**
 * Collection paths. Mirrors `COLLECTIONS` in `src/lib/firebase.ts` — only the
 * subset this package touches is listed, so a typo cannot silently create a
 * new collection.
 */
export const COLLECTIONS = {
  employees: 'employees',
  shiftRoles: 'shiftRoles',
  schedules: 'schedules',
  permissions: 'permissions',
  invites: 'invites',
  auditLog: 'auditLog',
  trades: 'trades',
  timeOff: 'timeOff',
  settings: 'settings',
  punches: 'punches',
  tipReports: 'tipReports',
  availability: 'availability',
  tasks: 'tasks',
  taskInstances: 'taskInstances',
  payPeriods: 'payPeriods',
} as const

/** `settings/{APP_SETTINGS_ID}` — mirrors src/lib/db/settings.ts's constant. */
export const APP_SETTINGS_ID = 'app'

/** Sensitive subdocuments — see the deviation note atop firestore.rules. */
export const PRIVATE = {
  compensation: 'compensation',
  admin: 'admin',
} as const
