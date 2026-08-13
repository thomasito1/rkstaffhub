/**
 * Invite acceptance — spec §2.
 *
 *   "Admin creates employee record → system generates an invite (email link).
 *    Employee accepts, signs in with any method, and is bound to the employee
 *    doc via invite token."
 *
 * The two callables here are the exact pair `src/lib/auth/authActions.ts`
 * calls, with the exact payloads it sends. `getInvite` runs for a signed-OUT
 * visitor (they cannot read `invites/{id}` — firestore.rules gates it behind
 * `employees.edit`); `acceptInvite` runs immediately after that visitor
 * authenticates, and binds the calling uid to the employee.
 *
 * The invite token is a bearer secret. Everything below follows from that:
 * unknown, revoked, expired and already-used tokens all fail identically, so
 * the endpoint cannot be used to discover which tokens exist.
 */

import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { FieldValue, Timestamp, type DocumentSnapshot } from 'firebase-admin/firestore'
import { logger } from 'firebase-functions'

import { writeAudit } from './audit'
import { syncClaimsForEmployee } from './claims'
import { COLLECTIONS, db } from './firebase'
import { displayName, isAccessRole, type EmployeeDoc, type InviteDoc } from './model'

/** Longest token we will even look up. Bounds abuse of the unauthenticated path. */
const MAX_TOKEN_LENGTH = 512

/**
 * ONE error for every unusable token — unknown, revoked, expired, already
 * accepted. Distinguishing them would turn this endpoint into an oracle that
 * confirms a guessed token is real.
 */
function unusableToken(): HttpsError {
  return new HttpsError('not-found', 'This invite link is no longer valid')
}

function readToken(data: { token?: unknown } | undefined): string {
  const token = typeof data?.token === 'string' ? data.token.trim() : ''
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    throw new HttpsError('invalid-argument', 'A token is required')
  }
  return token
}

/** Firestore Timestamp | ISO string | epoch millis | Date → Date | null. */
function toDate(value: unknown): Date | null {
  if (!value) return null
  if (value instanceof Timestamp) return value.toDate()
  if (value instanceof Date) return value
  if (typeof value === 'number') return new Date(value)
  if (typeof value === 'string') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  return null
}

/** An invite with no expiry never expires; one with a past expiry is dead. */
function isExpired(invite: InviteDoc, now: Date): boolean {
  const expiresAt = toDate(invite.expiresAt)
  return expiresAt !== null && expiresAt.getTime() <= now.getTime()
}

async function findInviteByToken(token: string): Promise<DocumentSnapshot | null> {
  const found = await db
    .collection(COLLECTIONS.invites)
    .where('token', '==', token)
    .limit(1)
    .get()
  return found.docs[0] ?? null
}

/** Primary shift role (falling back to the first) → display name + skill level. */
async function primaryRole(
  employee: EmployeeDoc,
): Promise<{ roleName: string | null; skillLevel: number | null }> {
  const roles = employee.shiftRoles ?? []
  const chosen = roles.find((r) => r.isPrimary) ?? roles[0]
  if (!chosen?.roleId) return { roleName: null, skillLevel: null }

  const snap = await db.collection(COLLECTIONS.shiftRoles).doc(chosen.roleId).get()
  const name = snap.exists ? ((snap.get('name') as string | undefined) ?? null) : null

  return {
    roleName: name,
    skillLevel: typeof chosen.skillLevel === 'number' ? chosen.skillLevel : null,
  }
}

/** `invite.createdBy` is an employees/{id}; anything else resolves to null. */
async function inviterName(createdBy: string | undefined): Promise<string | null> {
  if (!createdBy) return null
  const snap = await db.collection(COLLECTIONS.employees).doc(createdBy).get()
  if (!snap.exists) return null
  return displayName(snap.data() as EmployeeDoc) || null
}

// ── getInvite ────────────────────────────────────────────────────────────────

/**
 * UNAUTHENTICATED BY DESIGN. The person opening an invite link has no account
 * yet — requiring auth here would make the flow impossible.
 *
 * Returns strictly what `InvitePreview` in `src/lib/auth/authActions.ts`
 * declares, and nothing more. In particular it never returns the employee id,
 * the access role, or any pay data: an invite link is emailed, forwardable, and
 * must not leak the roster.
 */
export const getInvite = onCall<{ token?: unknown }>(async (request) => {
  const token = readToken(request.data)

  const inviteSnap = await findInviteByToken(token)
  if (!inviteSnap) throw unusableToken()

  const invite = inviteSnap.data() as InviteDoc
  if (invite.status !== 'pending') throw unusableToken()
  if (isExpired(invite, new Date())) throw unusableToken()
  if (!invite.employeeId) throw unusableToken()

  const employeeSnap = await db
    .collection(COLLECTIONS.employees)
    .doc(invite.employeeId)
    .get()
  if (!employeeSnap.exists) throw unusableToken()

  const employee = employeeSnap.data() as EmployeeDoc
  const { roleName, skillLevel } = await primaryRole(employee)
  const expiresAt = toDate(invite.expiresAt)

  return {
    employeeName: displayName(employee),
    email: invite.email ?? employee.email ?? '',
    roleName,
    skillLevel,
    invitedByName: await inviterName(invite.createdBy),
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
  }
})

// ── acceptInvite ─────────────────────────────────────────────────────────────

interface AcceptOutcome {
  employeeId: string
  employee: EmployeeDoc
  /** True when a previous call already completed the binding (retry path). */
  alreadyAccepted: boolean
  previousStatus: EmployeeDoc['status']
}

/**
 * REQUIRES AUTH. `authActions.acceptInvite()` signs the user in (or links a
 * credential) and only then calls this, because the binding is between the
 * *calling* uid and the employee document.
 *
 * IDEMPOTENT. The client comment in authActions.ts promises that "retrying is
 * safe"; a dropped response after a successful write must not strand someone
 * with an accepted invite and no claims. So:
 *   - the Firestore mutation runs in a transaction (all-or-nothing),
 *   - a retry whose uid is already bound to this employee re-issues the claims
 *     and returns success instead of erroring,
 *   - claims are set AFTER the transaction and are safe to set repeatedly, so a
 *     failure between the two heals on the next attempt,
 *   - the audit entry is written only on the transition, so a retry does not
 *     duplicate it.
 */
export const acceptInvite = onCall<{ token?: unknown }>(async (request) => {
  const uid = request.auth?.uid
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Sign in before accepting an invite')
  }
  const token = readToken(request.data)

  const inviteSnap = await findInviteByToken(token)
  if (!inviteSnap) throw unusableToken()
  const inviteRef = inviteSnap.ref

  const inviteEmployeeId = (inviteSnap.data() as InviteDoc).employeeId
  if (!inviteEmployeeId) throw unusableToken()

  // One uid, one person. If this account is already bound elsewhere, accepting
  // would leave it in two employees' authUids and hand it whichever claim was
  // written last.
  const boundElsewhere = await db
    .collection(COLLECTIONS.employees)
    .where('authUids', 'array-contains', uid)
    .limit(2)
    .get()
  for (const doc of boundElsewhere.docs) {
    if (doc.id !== inviteEmployeeId) {
      throw new HttpsError(
        'failed-precondition',
        'This sign-in is already linked to another employee',
      )
    }
  }

  const employeeRef = db.collection(COLLECTIONS.employees).doc(inviteEmployeeId)

  const outcome: AcceptOutcome = await db.runTransaction(async (tx) => {
    const snaps = await tx.getAll(inviteRef, employeeRef)
    const freshInvite = snaps[0]
    const freshEmployee = snaps[1]
    // getAll resolves one snapshot per ref; the guard is for the type checker.
    if (!freshInvite || !freshEmployee) throw unusableToken()

    const invite = freshInvite.data() as InviteDoc | undefined
    if (!invite || invite.token !== token) throw unusableToken()
    if (!freshEmployee.exists) throw unusableToken()

    const employee = freshEmployee.data() as EmployeeDoc
    const uids = employee.authUids ?? []

    // ── retry path ──────────────────────────────────────────────────────────
    if (invite.status === 'accepted') {
      if (!uids.includes(uid)) {
        // Accepted by somebody else. Not the same failure as an unknown token:
        // this caller is authenticated and holds a real token, so a precise
        // error costs nothing and prevents a confusing silent success.
        throw new HttpsError('failed-precondition', 'This invite has already been used')
      }
      return {
        employeeId: freshEmployee.id,
        employee,
        alreadyAccepted: true,
        previousStatus: employee.status,
      }
    }

    if (invite.status !== 'pending') throw unusableToken()
    if (isExpired(invite, new Date())) throw unusableToken()

    if (employee.status === 'archived' || employee.status === 'inactive') {
      throw new HttpsError('failed-precondition', 'This employee record is not active')
    }
    if (!isAccessRole(employee.accessRole)) {
      throw new HttpsError('failed-precondition', 'Employee has no valid accessRole')
    }

    // pending → active. Any other status (already active, e.g. a re-invite to
    // add a sign-in method) is left exactly as it is.
    const nextStatus = employee.status === 'pending' ? 'active' : employee.status

    tx.update(employeeRef, {
      authUids: FieldValue.arrayUnion(uid),
      ...(nextStatus === employee.status ? {} : { status: nextStatus }),
      updatedAt: FieldValue.serverTimestamp(),
    })

    tx.update(inviteRef, {
      status: 'accepted',
      acceptedAt: FieldValue.serverTimestamp(),
      acceptedByUid: uid,
    })

    return {
      employeeId: freshEmployee.id,
      employee: {
        ...employee,
        status: nextStatus,
        authUids: [...uids, uid],
      },
      alreadyAccepted: false,
      previousStatus: employee.status,
    }
  })

  // Claims live in Auth, not Firestore, so they cannot join the transaction.
  // Setting them is idempotent, which is what makes the retry path above safe.
  const sync = await syncClaimsForEmployee(outcome.employeeId, outcome.employee)
  if (!sync.updated.includes(uid)) {
    logger.error('invite accepted but claims were not set for the calling uid', {
      uid,
      employeeId: outcome.employeeId,
      failed: sync.failed,
    })
    throw new HttpsError('internal', 'Could not finish setting up this account')
  }

  if (!outcome.alreadyAccepted) {
    await writeAudit({
      action: 'permission.change',
      actorEmployeeId: outcome.employeeId,
      actorUid: uid,
      targetType: 'invite',
      targetId: inviteSnap.id,
      reason: 'invite.accept',
      before: { inviteStatus: 'pending', employeeStatus: outcome.previousStatus ?? null },
      after: {
        employeeId: outcome.employeeId,
        role: outcome.employee.accessRole,
        status: outcome.employee.status,
        uid,
      },
    })
  }

  return { employeeId: outcome.employeeId }
})
