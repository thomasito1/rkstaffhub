import { initializeApp, type FirebaseApp } from 'firebase/app'
import { getAuth, connectAuthEmulator, type Auth } from 'firebase/auth'
import {
  getFirestore,
  connectFirestoreEmulator,
  type Firestore,
} from 'firebase/firestore'
import {
  getStorage,
  connectStorageEmulator,
  type FirebaseStorage,
} from 'firebase/storage'
import {
  getFunctions,
  connectFunctionsEmulator,
  type Functions,
} from 'firebase/functions'

/**
 * Firebase wiring.
 *
 * CRITICAL (CLAUDE.md): this app uses a STANDALONE Firebase project and must
 * never touch the existing Leah/ERP Firestore. The project id comes from env
 * and defaults to the emulator-only demo project.
 *
 * Local development runs entirely against emulators. A `demo-` prefixed project
 * id makes the emulators refuse to reach any real backend, which is the safety
 * property we want while seeding and testing.
 */

const env = import.meta.env

const config = {
  apiKey: env.VITE_FIREBASE_API_KEY ?? 'demo-api-key',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? 'demo-rk-staffhub.firebaseapp.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID ?? 'demo-rk-staffhub',
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET ?? 'demo-rk-staffhub.appspot.com',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '000000000000',
  appId: env.VITE_FIREBASE_APP_ID ?? '1:000000000000:web:0000000000000000000000',
}

export const USE_EMULATORS = env.VITE_USE_EMULATORS === 'true' || env.DEV

if (!USE_EMULATORS && config.projectId.startsWith('demo-')) {
  throw new Error(
    'Refusing to start: emulators are disabled but the project id is still the demo project. ' +
      'Set VITE_FIREBASE_* in .env.local before running against a real backend.',
  )
}

export const app: FirebaseApp = initializeApp(config)
export const auth: Auth = getAuth(app)
export const db: Firestore = getFirestore(app)
export const storage: FirebaseStorage = getStorage(app)
export const functions: Functions = getFunctions(app)

if (USE_EMULATORS) {
  const host = env.VITE_EMULATOR_HOST ?? '127.0.0.1'
  const port = (key: string, fallback: number) => Number(env[key] ?? fallback)

  connectAuthEmulator(auth, `http://${host}:${port('VITE_EMULATOR_AUTH_PORT', 9099)}`, {
    disableWarnings: true,
  })
  connectFirestoreEmulator(db, host, port('VITE_EMULATOR_FIRESTORE_PORT', 8080))
  connectStorageEmulator(storage, host, port('VITE_EMULATOR_STORAGE_PORT', 9199))
  connectFunctionsEmulator(functions, host, port('VITE_EMULATOR_FUNCTIONS_PORT', 5001))

  if (env.DEV) {
    console.info(
      `[firebase] emulators connected on ${host} (project: ${config.projectId})`,
    )
  }
}

/** Firestore collection paths — single source of truth, spec §3. */
export const COLLECTIONS = {
  employees: 'employees',
  shiftRoles: 'shiftRoles',
  availability: 'availability',
  schedules: 'schedules',
  shiftTemplates: 'shiftTemplates',
  trades: 'trades',
  timeOff: 'timeOff',
  punches: 'punches',
  tipReports: 'tipReports',
  tasks: 'tasks',
  taskInstances: 'taskInstances',
  policies: 'policies',
  signatures: 'signatures',
  disciplinaryActions: 'disciplinaryActions',
  disciplinaryLadder: 'disciplinaryLadder',
  payPeriods: 'payPeriods',
  settings: 'settings',
  /**
   * Emulator/dev-only Secret Manager stand-in (spec §13, Phase 5) — never
   * read or written by the client; listed here only so `COLLECTIONS` stays
   * the single source of truth for every collection path in the app.
   */
  devSecrets: '_devSecrets',
  permissions: 'permissions',
  invites: 'invites',
  auditLog: 'auditLog',
} as const

/** Sensitive subdocuments — see the deviation note at the top of firestore.rules. */
export const PRIVATE_DOCS = {
  compensation: 'private/compensation',
  admin: 'private/admin',
} as const
