import {
  EmailAuthProvider,
  GoogleAuthProvider,
  PhoneAuthProvider,
  RecaptchaVerifier,
  browserLocalPersistence,
  browserSessionPersistence,
  createUserWithEmailAndPassword,
  linkWithCredential,
  linkWithPopup,
  sendPasswordResetEmail,
  setPersistence,
  signInWithCredential,
  signInWithEmailAndPassword,
  signInWithPopup,
  type AuthCredential,
  type User,
} from 'firebase/auth'
import { FirebaseError } from 'firebase/app'
import { httpsCallable } from 'firebase/functions'

import { auth, functions } from '@/lib/firebase'
import { getAppSettings } from '@/lib/db'
import { errorCode, inviteError, googleCredentialFromError, authErrorEmail, ACCOUNT_EXISTS_CODE } from '@/lib/auth/authErrors'

/**
 * Every Firebase Auth call the sign-in and invite screens make.
 *
 * The screens own presentation; this module owns the SDK. Two consequences:
 *
 *  1. **Claims and employee binding are server-side.** `acceptInvite` calls a
 *     Cloud Function and nothing else. This module never writes an employee
 *     document and never touches custom claims — spec §2 puts both on the
 *     server, and a client that could do either would be a hole in §4.
 *
 *  2. **The account-linking collision is handled here, not in the page.**
 *     Signing in with Google using an address that already has a password
 *     account throws `auth/account-exists-with-different-credential`. The
 *     Google credential is stashed, the error is rethrown for the UI to
 *     explain, and the next successful password sign-in for that same address
 *     links it automatically. Keeping the stash in this module means no screen
 *     can forget to finish the link.
 */

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * "Remember me on this device". Local persistence survives a browser restart;
 * session persistence dies with the tab, which is what a shared back-office
 * machine wants.
 */
export async function setRememberMe(remember: boolean): Promise<void> {
  await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence)
}

// ── Account-linking collision (spec §2) ─────────────────────────────────────

interface PendingLink {
  email: string
  credential: AuthCredential
}

/**
 * Held in memory only, deliberately. An OAuth credential is a bearer token for
 * an identity; persisting it to localStorage would outlive the flow that needs
 * it. A reload loses the pending link and the user simply retries Google.
 */
let pendingLink: PendingLink | null = null

/** The address whose existing account is waiting to absorb a Google credential. */
export function getPendingLinkEmail(): string | null {
  return pendingLink?.email ?? null
}

export function clearPendingLink(): void {
  pendingLink = null
}

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Attach a stashed Google credential to the account that just signed in.
 * Swallows the "already linked" outcomes: the goal state is reached either
 * way, and surfacing them would show an error after a successful sign-in.
 */
async function completePendingLink(user: User): Promise<void> {
  const pending = pendingLink
  if (!pending) return
  clearPendingLink()
  try {
    await linkWithCredential(user, pending.credential)
  } catch (err) {
    const code = errorCode(err)
    if (code !== 'auth/provider-already-linked' && code !== 'auth/credential-already-in-use') {
      throw err
    }
  }
}

// ── Sign in ─────────────────────────────────────────────────────────────────

function googleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider()
  // Staff share devices. Always let them pick which Google account to use
  // rather than silently reusing whoever is signed in on the browser.
  provider.setCustomParameters({ prompt: 'select_account' })
  return provider
}

export async function signInWithGoogle(): Promise<void> {
  try {
    await signInWithPopup(auth, googleProvider())
    clearPendingLink()
  } catch (err) {
    if (errorCode(err) === ACCOUNT_EXISTS_CODE) {
      const credential = googleCredentialFromError(err)
      const email = authErrorEmail(err)
      // Stash only when both halves survived; without the credential there is
      // nothing to link and the UI should not promise that there is.
      if (credential && email) pendingLink = { email, credential }
    }
    throw err
  }
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  const { user } = await signInWithEmailAndPassword(auth, email.trim(), password)
  if (pendingLink && sameEmail(pendingLink.email, email)) {
    await completePendingLink(user)
  }
}

export async function sendPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email.trim())
}

// ── Linking additional methods ──────────────────────────────────────────────

function requireUser(): User {
  const user = auth.currentUser
  if (!user) throw new FirebaseError('auth/no-current-user', 'No signed-in user to link to')
  return user
}

export async function linkGoogleToCurrentUser(): Promise<void> {
  await linkWithPopup(requireUser(), googleProvider())
}

export async function linkEmailPasswordToCurrentUser(
  email: string,
  password: string,
): Promise<void> {
  await linkWithCredential(requireUser(), EmailAuthProvider.credential(email.trim(), password))
}

/**
 * Sign-in methods currently attached to the session, for the profile page's
 * "Login methods" card (spec §2). Reads the local user object, so it is
 * synchronous and reflects the last token refresh.
 */
export function listLinkedMethods(): { providerId: string; email: string | null }[] {
  const user = auth.currentUser
  if (!user) return []
  return user.providerData.map((p) => ({ providerId: p.providerId, email: p.email }))
}

// ── Phone OTP — scaffolded, shipped OFF (spec §2) ───────────────────────────

/**
 * Reads `settings/app.featureFlags.phoneOtp`. Never hardcoded: flipping the
 * flag in Firestore (plus enabling the provider in the Firebase console) turns
 * the method on with no code change.
 *
 * The document is readable by signed-in users only, so on the sign-out side of
 * the login screen the read is denied — that failure resolves to `false`,
 * which is the safe default and matches the shipped state.
 */
export async function isPhoneOtpEnabled(): Promise<boolean> {
  try {
    const settings = await getAppSettings()
    return settings?.featureFlags.phoneOtp === true
  } catch {
    return false
  }
}

/**
 * Send the SMS. `containerId` is an element the invisible reCAPTCHA mounts
 * into. Returns the verification id to pair with the typed code.
 */
export async function startPhoneVerification(
  phoneNumber: string,
  containerId: string,
): Promise<string> {
  const verifier = new RecaptchaVerifier(auth, containerId, { size: 'invisible' })
  try {
    return await new PhoneAuthProvider(auth).verifyPhoneNumber(phoneNumber, verifier)
  } finally {
    verifier.clear()
  }
}

export async function signInWithPhoneCode(
  verificationId: string,
  code: string,
): Promise<void> {
  await signInWithCredential(auth, PhoneAuthProvider.credential(verificationId, code))
}

export async function linkPhoneToCurrentUser(
  verificationId: string,
  code: string,
): Promise<void> {
  await linkWithCredential(requireUser(), PhoneAuthProvider.credential(verificationId, code))
}

// ── Invite acceptance (spec §2) ─────────────────────────────────────────────

/**
 * What the invite screen needs to render step 1. Returned by the `getInvite`
 * callable rather than read from Firestore: `invites/{id}` is readable only
 * with `employees.edit` (firestore.rules), and the person opening an invite
 * link is not signed in at all.
 */
export interface InvitePreview {
  employeeName: string
  email: string
  /** Display label for the role chip, e.g. "Server". */
  roleName: string | null
  /** Skill level for the chip's "· L1" suffix. */
  skillLevel: number | null
  /** Who sent it, for "{{name}} invited you to join the team". */
  invitedByName: string | null
  /** ISO 8601. Rendered as a relative expiry line. */
  expiresAt: string | null
}

/** Previews keyed by token, so acceptance knows the address to register. */
const invitePreviews = new Map<string, InvitePreview>()

export async function fetchInvite(token: string): Promise<InvitePreview> {
  if (!token) throw inviteError('invite/missing-token', 'No invite token in the URL')
  const call = httpsCallable<{ token: string }, InvitePreview>(functions, 'getInvite')
  const { data } = await call({ token })
  invitePreviews.set(token, data)
  return data
}

/**
 * Authenticate, then hand the token to the server.
 *
 * The order matters: the Cloud Function binds the *calling* uid to the
 * employee document and issues the `role` / `employeeId` claims, so a session
 * must exist before it is called. The client contributes nothing but proof of
 * identity — it does not write the employee doc and does not set claims.
 *
 * The callable is not deployed yet. Its failure is mapped to
 * `auth.errors.inviteServiceUnavailable`, and because the auth account was
 * already created by then, retrying is safe: the second attempt links or signs
 * into the same account instead of creating a duplicate.
 */
export async function acceptInvite(
  token: string,
  method: 'google' | 'password',
  password?: string,
): Promise<void> {
  if (!token) throw inviteError('invite/missing-token', 'No invite token in the URL')

  if (method === 'google') {
    // Already signed in (e.g. the callable failed and they are retrying):
    // link rather than replace the session.
    if (auth.currentUser && !auth.currentUser.providerData.some((p) => p.providerId === 'google.com')) {
      await linkGoogleToCurrentUser()
    } else if (!auth.currentUser) {
      await signInWithGoogle()
    }
  } else {
    if (!password) throw inviteError('invite/missing-password', 'A password is required')
    const preview = invitePreviews.get(token) ?? (await fetchInvite(token))
    if (!preview.email) throw inviteError('invite/unknown-email', 'Invite has no email')
    if (auth.currentUser) {
      await linkEmailPasswordToCurrentUser(preview.email, password)
    } else {
      await createUserWithEmailAndPassword(auth, preview.email, password)
    }
  }

  const call = httpsCallable<{ token: string }, { employeeId: string }>(functions, 'acceptInvite')
  await call({ token })

  // Force a token refresh so the freshly issued employeeId/role claims are on
  // the ID token before the app reads them (AuthProvider resolves the employee
  // record from the claim).
  await auth.currentUser?.getIdToken(true)
}
