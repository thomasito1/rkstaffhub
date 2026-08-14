/**
 * submitAvailability — spec §5's Thursday 23:59 ET deadline, enforced
 * server-side for real. firestore.rules cannot express this check (no tz
 * database — see PROGRESS.md's "Not enforced in rules" note) and a
 * client-side-only guard is trivially bypassed by any client that skips it,
 * so this is now the ONLY way a submission (create, or a resubmit while
 * still pending) reaches Firestore — firestore.rules' own `availability`
 * write rule no longer grants a self-submission shape at all. Withdrawing a
 * still-open temporary override (`clearTemporaryAvailability`, a delete) and
 * reviewing someone else's submission stay plain client writes; neither
 * carries a deadline question.
 *
 * ON-BEHALF SUBMISSION (spec §5: "managers with availability.approve can
 * still edit/enter on their behalf" past the deadline) is derived from
 * IDENTITY, not a client-asserted flag: `employeeId !== actor.id` plus
 * holding `availability.approve` is what bypasses the lock, exactly the same
 * "never trust a client's claimed intent, re-derive it" shape as every other
 * privileged Function in this codebase.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

import { COLLECTIONS, db } from './firebase'
import { hasPermission, loadRoleDefaults, resolveActor } from './permissions'
import { isAvailabilityLocked } from './availabilityHelpers'

const RECURRING_WEEK_ID = 'recurring'
const WEEKDAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const STATUSES = ['available', 'unavailable', 'partial'] as const

interface AvailabilityDayInput {
  status: (typeof STATUSES)[number]
  from?: string | null
  to?: string | null
}

export interface SubmitAvailabilityRequest {
  employeeId: string
  /** Ignored when `type` is 'recurring'. */
  weekId: string
  type: 'recurring' | 'temporary'
  days: Partial<Record<(typeof WEEKDAY_KEYS)[number], AvailabilityDayInput>>
  locationId?: string | null
}

export interface SubmitAvailabilityResponse {
  id: string
  weekId: string
}

function normalizeDay(raw: AvailabilityDayInput | undefined): AvailabilityDayInput {
  if (!raw || !STATUSES.includes(raw.status)) return { status: 'available', from: null, to: null }
  return {
    status: raw.status,
    from: raw.status === 'partial' ? (raw.from ?? null) : null,
    to: raw.status === 'partial' ? (raw.to ?? null) : null,
  }
}

export const submitAvailability = onCall<SubmitAvailabilityRequest>(
  async (request): Promise<SubmitAvailabilityResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { employeeId, type } = request.data
    if (!employeeId || (type !== 'recurring' && type !== 'temporary')) {
      throw new HttpsError('invalid-argument', 'employeeId and a valid type are required.')
    }

    const actor = await resolveActor(uid)
    const isSelf = actor.id === employeeId

    let onBehalf = false
    if (!isSelf) {
      const roleDefaults = await loadRoleDefaults()
      if (!hasPermission(actor, 'availability.approve', roleDefaults)) {
        throw new HttpsError('permission-denied', 'You may only submit your own availability.')
      }
      onBehalf = true
    }

    const isRecurring = type === 'recurring'
    const weekId = isRecurring ? RECURRING_WEEK_ID : request.data.weekId
    if (!isRecurring && !weekId) {
      throw new HttpsError('invalid-argument', 'weekId is required for a temporary submission.')
    }

    // Recurring baselines are never week-locked (spec §5); on-behalf bypasses
    // the lock by design — that IS the override spec names.
    if (!isRecurring && !onBehalf && isAvailabilityLocked(weekId, new Date())) {
      throw new HttpsError(
        'failed-precondition',
        'The deadline for this week has passed.',
        { code: 'availability/locked' },
      )
    }

    const days: Record<string, AvailabilityDayInput> = {}
    for (const key of WEEKDAY_KEYS) days[key] = normalizeDay(request.data.days?.[key])

    const id = `${weekId}_${employeeId}`
    await db
      .collection(COLLECTIONS.availability)
      .doc(id)
      .set({
        employeeId,
        weekId,
        type,
        days,
        status: 'pending',
        reviewedBy: null,
        reviewedAt: null,
        declineReason: null,
        submittedAt: FieldValue.serverTimestamp(),
        locationId: request.data.locationId ?? null,
        updatedAt: FieldValue.serverTimestamp(),
      })

    return { id, weekId }
  },
)
