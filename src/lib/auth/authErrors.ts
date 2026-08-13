import { FirebaseError } from 'firebase/app'
import { GoogleAuthProvider, type AuthCredential } from 'firebase/auth'

/**
 * Firebase error code → translated message key.
 *
 * Nothing in the app should ever render a raw Firebase message: they are
 * English-only, and several of them leak whether an account exists. Every call
 * site funnels its `catch` through `toAuthError()` and renders `messageKey`
 * with `t()`.
 *
 * Codes come from three families:
 *   auth/*      — Firebase Auth
 *   functions/* — callable Cloud Functions (the invite endpoints)
 *   invite/*    — our own client-side preconditions, raised as FirebaseError
 *                 so a single mapper handles every failure shape.
 */

export interface AuthErrorInfo {
  /** Raw code, kept for logging and for branching on specific cases. */
  code: string
  /** i18n key under `auth.errors.*`. */
  messageKey: string
  /**
   * The address that already owns an account, for
   * `auth/account-exists-with-different-credential`. Null otherwise.
   */
  email: string | null
  /**
   * The user closed or blocked the popup. Callers should reset loading state
   * silently rather than showing an error — this is not a failure, it is a
   * change of mind.
   */
  cancelled: boolean
  /**
   * `auth/account-exists-with-different-credential` — the account-linking
   * collision. Callers must offer the existing method, then link (spec §2).
   */
  accountExists: boolean
}

const MESSAGE_KEYS: Record<string, string> = {
  // ── Credentials ──────────────────────────────────────────────────────────
  // Firebase collapses wrong-password and unknown-user into
  // `invalid-credential` when email-enumeration protection is on. We say the
  // same vague thing for all of them on purpose.
  'auth/invalid-credential': 'auth.errors.invalidCredentials',
  'auth/invalid-login-credentials': 'auth.errors.invalidCredentials',
  'auth/wrong-password': 'auth.errors.invalidCredentials',
  'auth/user-not-found': 'auth.errors.invalidCredentials',
  'auth/invalid-email': 'auth.errors.invalidEmail',
  'auth/missing-email': 'auth.errors.missingEmail',
  'auth/missing-password': 'auth.errors.missingPassword',
  'auth/weak-password': 'auth.errors.weakPassword',
  'auth/user-disabled': 'auth.errors.userDisabled',

  // ── Rate limiting / transport ────────────────────────────────────────────
  'auth/too-many-requests': 'auth.errors.tooManyAttempts',
  'auth/network-request-failed': 'auth.errors.networkError',
  'auth/timeout': 'auth.errors.networkError',

  // ── Popups ───────────────────────────────────────────────────────────────
  'auth/popup-closed-by-user': 'auth.errors.popupClosed',
  'auth/cancelled-popup-request': 'auth.errors.popupClosed',
  'auth/user-cancelled': 'auth.errors.popupClosed',
  'auth/popup-blocked': 'auth.errors.popupBlocked',
  'auth/unauthorized-domain': 'auth.errors.unauthorizedDomain',
  'auth/operation-not-allowed': 'auth.errors.methodNotEnabled',

  // ── Linking (spec §2) ────────────────────────────────────────────────────
  'auth/account-exists-with-different-credential': 'auth.errors.accountExists',
  'auth/email-already-in-use': 'auth.errors.emailInUse',
  'auth/credential-already-in-use': 'auth.errors.credentialInUse',
  'auth/provider-already-linked': 'auth.errors.providerAlreadyLinked',
  'auth/requires-recent-login': 'auth.errors.requiresRecentLogin',
  'auth/no-current-user': 'auth.errors.notSignedIn',

  // ── Phone (scaffolded behind the phoneOtp flag) ──────────────────────────
  'auth/invalid-phone-number': 'auth.errors.invalidPhone',
  'auth/invalid-verification-code': 'auth.errors.invalidCode',
  'auth/code-expired': 'auth.errors.codeExpired',

  // ── Invite callables ─────────────────────────────────────────────────────
  // The Cloud Functions are not deployed yet; `not-found` and `internal` are
  // the codes a missing endpoint produces, so they must degrade to a sentence
  // an employee can act on rather than a stack trace.
  'functions/not-found': 'auth.errors.inviteServiceUnavailable',
  'functions/unavailable': 'auth.errors.inviteServiceUnavailable',
  'functions/internal': 'auth.errors.inviteServiceUnavailable',
  'functions/deadline-exceeded': 'auth.errors.inviteServiceUnavailable',
  'functions/cancelled': 'auth.errors.inviteServiceUnavailable',
  'functions/unauthenticated': 'auth.errors.notSignedIn',
  'functions/permission-denied': 'auth.errors.inviteNotYours',
  'functions/invalid-argument': 'auth.errors.inviteInvalid',
  'functions/failed-precondition': 'auth.errors.inviteExpired',
  'functions/already-exists': 'auth.errors.inviteAlreadyAccepted',

  // ── Client-side preconditions ────────────────────────────────────────────
  'invite/missing-token': 'auth.errors.inviteInvalid',
  'invite/missing-password': 'auth.errors.missingPassword',
  'invite/unknown-email': 'auth.errors.inviteInvalid',
}

const CANCELLED_CODES = new Set([
  'auth/popup-closed-by-user',
  'auth/cancelled-popup-request',
  'auth/user-cancelled',
])

export const ACCOUNT_EXISTS_CODE = 'auth/account-exists-with-different-credential'

/** Narrow an unknown `catch` binding to a Firebase code, or `''`. */
export function errorCode(err: unknown): string {
  if (err instanceof FirebaseError) return err.code
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return ''
}

/**
 * The address carried by an account-collision error. Firebase puts it on
 * `customData.email`; older shapes used a top-level `email`.
 */
export function authErrorEmail(err: unknown): string | null {
  if (err instanceof FirebaseError) {
    const custom = err.customData as { email?: unknown } | undefined
    if (typeof custom?.email === 'string') return custom.email
  }
  if (typeof err === 'object' && err !== null && 'email' in err) {
    const email = (err as { email: unknown }).email
    if (typeof email === 'string') return email
  }
  return null
}

/**
 * The Google credential the user just proved they own, recovered from a failed
 * sign-in. This is what gets linked onto the existing account once they have
 * re-authenticated with their original method (spec §2).
 */
export function googleCredentialFromError(err: unknown): AuthCredential | null {
  if (!(err instanceof FirebaseError)) return null
  try {
    return GoogleAuthProvider.credentialFromError(err)
  } catch {
    return null
  }
}

export function toAuthError(err: unknown): AuthErrorInfo {
  const code = errorCode(err)
  return {
    code,
    messageKey: MESSAGE_KEYS[code] ?? 'auth.errors.generic',
    email: authErrorEmail(err),
    cancelled: CANCELLED_CODES.has(code),
    accountExists: code === ACCOUNT_EXISTS_CODE,
  }
}

/** Raise one of our own `invite/*` preconditions in the same shape as Firebase. */
export function inviteError(
  code: 'invite/missing-token' | 'invite/missing-password' | 'invite/unknown-email',
  message: string,
): FirebaseError {
  return new FirebaseError(code, message)
}
