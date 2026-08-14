/**
 * Availability data access — `availability/{weekId}_{employeeId}` (spec §3, §5).
 *
 * TWO KINDS OF SUBMISSION, ONE COLLECTION
 * ---------------------------------------
 * Spec §5: staff submit **recurring** availability that "rolls forward weekly",
 * plus **temporary** week-specific overrides where "temporary wins for that
 * week" — the 7shifts model.
 *
 * The §3 document id template is `{weekId}_{employeeId}`, which holds exactly
 * one document per employee per week. Recurring availability, however, belongs
 * to no single week: it is the person's standing baseline until they replace
 * it. RESOLUTION: recurring is stored under the same id template with the
 * sentinel week key `"recurring"` → `availability/recurring_{employeeId}`.
 * Temporary keeps the real weekId.
 *
 * That choice buys three things worth having: one collection and one id
 * template (so the rules block stays a single path match), a two-document read
 * for any effective lookup with no composite index, and a baseline that keeps
 * rolling forward on its own instead of needing a new document written every
 * week for every employee. The alternative — dating each recurring submission
 * and scanning backwards for the latest one that precedes the target week —
 * needs an ordered composite query per employee per week and leaves the roster
 * accumulating a document per person per week forever.
 *
 * DEADLINE. §5 locks submissions for the following week at Thursday 23:59 ET.
 * firestore.rules cannot express this (no tz database), so a client-side-only
 * guard would be trivially bypassed — submitAvailability() is a Cloud Function
 * (functions/src/availabilityActions.ts) and is the ONLY way a submission (or a
 * resubmit while still pending) reaches Firestore; the rules' own write grant
 * for a fresh self-submission was removed. Withdrawing a still-open temporary
 * override (clearTemporaryAvailability, a delete) stays a plain client write —
 * it carries no deadline question. Managers holding `availability.approve`
 * submit on someone's behalf and bypass the lock automatically — the Function
 * derives that from `employeeId !== caller`, never from a client-asserted flag.
 *
 * DENIED READS. Staff can read their own availability; `availability.viewAll`
 * reads everyone's. A denied read returns null/[] per the layer-wide rule in
 * db/errors.ts. Any other error rethrows.
 */

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type DocumentData,
  type DocumentSnapshot,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'
import { httpsCallable, type FunctionsError } from 'firebase/functions'

import { COLLECTIONS, db, functions } from '@/lib/firebase'
import { isFirebaseError } from '@/lib/firebaseError'
import {
  WEEKDAY_KEYS,
  type Availability,
  type AvailabilityDay,
  type AvailabilityStatus,
  type AvailabilityType,
  type WeekdayKey,
} from '@/types/models'

import { isPermissionDenied, readOrNullIfDenied } from './errors'

// ── ids & shapes ─────────────────────────────────────────────────────────────

/** Sentinel week key for the rolling baseline — see the file header. */
export const RECURRING_WEEK_ID = 'recurring'

/** `availability/{weekId}_{employeeId}`, or `availability/recurring_{employeeId}`. */
export function availabilityId(weekId: string, employeeId: string): string {
  return `${weekId}_${employeeId}`
}

export interface AvailabilityInput {
  employeeId: string
  /** Ignored when `type` is 'recurring' — the baseline is not week-scoped. */
  weekId: string
  type: AvailabilityType
  days: Partial<Record<WeekdayKey, AvailabilityDay>>
  locationId?: string | null
}

/** Where an effective day came from — the glance grid labels overrides. */
export type AvailabilitySource = 'temporary' | 'recurring' | 'none'

export interface EffectiveAvailability {
  employeeId: string
  weekId: string
  /** Which record is in force for the week as a whole. */
  source: AvailabilitySource
  /** Always all seven keys. Missing days default to 'available'. */
  days: Record<WeekdayKey, AvailabilityDay>
  /** The record the days came from, for status/reviewer display. */
  record: Availability | null
  /**
   * The in-force record is still awaiting review. The schedule builder shows
   * this as "unconfirmed" rather than treating it as approved fact (§5).
   */
  isPending: boolean
}

/** Thrown by submitAvailability() past the Thursday 23:59 ET lock (§5). */
export class AvailabilityLockedError extends Error {
  readonly weekId: string
  constructor(weekId: string) {
    super(`Availability for ${weekId} locked at Thursday 23:59 ET (spec §5)`)
    this.name = 'AvailabilityLockedError'
    this.weekId = weekId
  }
}

// ── internals ────────────────────────────────────────────────────────────────

function availabilityDoc(weekId: string, employeeId: string) {
  return doc(db, COLLECTIONS.availability, availabilityId(weekId, employeeId))
}

/** A day with no entry is availability's safest default: available (§5). */
function defaultDay(): AvailabilityDay {
  return { status: 'available', from: null, to: null }
}

function toDay(raw: unknown): AvailabilityDay {
  const d = (raw ?? {}) as Partial<AvailabilityDay>
  const status = d.status
  if (status !== 'available' && status !== 'unavailable' && status !== 'partial') {
    return defaultDay()
  }
  return {
    status,
    // from/to are only meaningful for 'partial'; drop stray times on the other
    // two so a day toggled back to Available cannot render a phantom range.
    from: status === 'partial' ? (d.from ?? null) : null,
    to: status === 'partial' ? (d.to ?? null) : null,
  }
}

/** Fills every weekday key, so callers can index without a null check. */
function toDays(raw: unknown): Record<WeekdayKey, AvailabilityDay> {
  const source = (raw ?? {}) as Record<string, unknown>
  const out = {} as Record<WeekdayKey, AvailabilityDay>
  for (const key of WEEKDAY_KEYS) out[key] = toDay(source[key])
  return out
}

function toAvailability(
  snap: DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>,
): Availability {
  const d = snap.data() ?? {}
  const type: AvailabilityType = d.type === 'temporary' ? 'temporary' : 'recurring'
  const status = d.status
  return {
    id: snap.id,
    employeeId: String(d.employeeId ?? ''),
    weekId: String(d.weekId ?? ''),
    type,
    days: toDays(d.days),
    status:
      status === 'approved' || status === 'declined'
        ? (status as AvailabilityStatus)
        : 'pending',
    reviewedBy: (d.reviewedBy as string | null) ?? null,
    reviewedAt: d.reviewedAt ?? null,
    submittedAt: d.submittedAt ?? null,
    declineReason: (d.declineReason as string | null) ?? null,
    locationId: (d.locationId as string | null) ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

// ── resolution (pure) ────────────────────────────────────────────────────────

/**
 * THE ONE PIECE OF REAL LOGIC HERE. Resolve what an employee's availability
 * actually is for a week, given their rolling baseline and any week-specific
 * override.
 *
 * Rules, in order:
 *
 * 1. A **declined** temporary is not in force. The employee asked for a
 *    week-specific change and a manager said no, so the baseline still governs —
 *    falling through to recurring is the whole point of a decline. (A declined
 *    *recurring* likewise falls through to the default, all-available week: a
 *    rejected submission cannot be used to mark someone unavailable.)
 * 2. Otherwise a temporary record **wins for that week** (spec §5), including
 *    while it is still pending — that is what the employee last told us, and the
 *    builder surfaces `isPending` so a manager can see it is unconfirmed.
 * 3. Per-day fallback: a temporary that omits a day inherits that day from the
 *    recurring baseline. In practice the override is whole-week — the reader
 *    above materialises all seven keys, and the submission UI writes all seven —
 *    so this only fires for a record assembled outside toAvailability(). It
 *    exists so a partial write cannot silently reset untouched days to
 *    "available", which would quietly hand the builder a person who is not free.
 * 4. Nothing on file → every day available, `source: 'none'`. Availability is
 *    permissive by default; the conflicts engine (§6) warns on scheduling
 *    against Not-available, and inventing an unavailable day nobody submitted
 *    would block real shifts.
 *
 * Pure and total — no clock, no Firestore, every input shape accepted.
 */
export function resolveEffectiveAvailability(
  employeeId: string,
  weekId: string,
  recurring: Availability | null,
  temporary: Availability | null,
): EffectiveAvailability {
  const liveRecurring = recurring && recurring.status !== 'declined' ? recurring : null
  const liveTemporary = temporary && temporary.status !== 'declined' ? temporary : null

  if (!liveTemporary && !liveRecurring) {
    const days = {} as Record<WeekdayKey, AvailabilityDay>
    for (const key of WEEKDAY_KEYS) days[key] = defaultDay()
    return { employeeId, weekId, source: 'none', days, record: null, isPending: false }
  }

  const inForce = liveTemporary ?? liveRecurring
  const days = {} as Record<WeekdayKey, AvailabilityDay>
  for (const key of WEEKDAY_KEYS) {
    // Rule 3: a temporary day is used when the temporary record carries one at
    // all; only genuinely absent days fall back to the baseline.
    const fromTemporary = liveTemporary?.days[key]
    days[key] = fromTemporary ?? liveRecurring?.days[key] ?? defaultDay()
  }

  return {
    employeeId,
    weekId,
    source: liveTemporary ? 'temporary' : 'recurring',
    days,
    record: inForce,
    isPending: inForce?.status === 'pending',
  }
}

// ── reads ────────────────────────────────────────────────────────────────────

/**
 * One availability document. Pass `RECURRING_WEEK_ID` for the baseline.
 * `null` = not submitted OR not visible to you (see db/errors).
 */
export async function getAvailability(
  employeeId: string,
  weekId: string,
): Promise<Availability | null> {
  return readOrNullIfDenied(async () => {
    const snap = await getDoc(availabilityDoc(weekId, employeeId))
    return snap.exists() ? toAvailability(snap) : null
  })
}

/** The rolling baseline for one person (§5). */
export async function getRecurringAvailability(
  employeeId: string,
): Promise<Availability | null> {
  return getAvailability(employeeId, RECURRING_WEEK_ID)
}

/**
 * Every week-specific submission for one week — the §5 Requests list.
 *
 * Filters on `weekId` (single-field, automatically indexed) and narrows status
 * client-side, which keeps this off the composite-index list for a query
 * returning at most one document per employee. Recurring baselines are NOT
 * included: they are not submissions "for" this week. Sorted by employeeId so
 * the list is stable across reloads; the UI re-sorts by name once it has the
 * roster.
 */
export async function listAvailabilityForWeek(
  weekId: string,
  opts?: { status?: AvailabilityStatus },
): Promise<Availability[]> {
  const constraints: QueryConstraint[] = [where('weekId', '==', weekId)]
  try {
    const snap = await getDocs(query(collection(db, COLLECTIONS.availability), ...constraints))
    return snap.docs
      .map(toAvailability)
      .filter((a) => a.type === 'temporary')
      .filter((a) => (opts?.status ? a.status === opts.status : true))
      .sort((a, b) => a.employeeId.localeCompare(b.employeeId))
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}

/**
 * What one employee's availability actually is for one week, temporary
 * overriding recurring — see resolveEffectiveAvailability() for the rules.
 *
 * Two independent document reads rather than a query: they are separate
 * documents under the same rules path, so there is no permission boundary being
 * batched across, and either one coming back denied simply resolves to null.
 */
export async function effectiveAvailabilityFor(
  employeeId: string,
  weekId: string,
): Promise<EffectiveAvailability> {
  const [recurring, temporary] = await Promise.all([
    getRecurringAvailability(employeeId),
    getAvailability(employeeId, weekId),
  ])
  return resolveEffectiveAvailability(employeeId, weekId, recurring, temporary)
}

// ── writes ───────────────────────────────────────────────────────────────────

/**
 * Create or replace a submission, returning it to `pending` review (§5).
 *
 * A Cloud Function call (functions/src/availabilityActions.ts), not a plain
 * client write — that Function is the actual Thursday 23:59 ET deadline
 * enforcement (firestore.rules cannot express it). Throws
 * AvailabilityLockedError past the deadline; a manager holding
 * `availability.approve` submitting on someone else's behalf bypasses it
 * automatically (the Function derives that from identity, not a client flag).
 * Recurring baselines are never week-locked.
 *
 * Whole-submission write: a re-submission replaces the previous week's
 * answers rather than merging into them, so a day the employee cleared
 * actually clears. `status` resets to pending on every submit — an approved
 * week that is edited is a new thing for a manager to look at.
 */
export async function submitAvailability(input: AvailabilityInput): Promise<Availability> {
  const isRecurring = input.type === 'recurring'
  const weekId = isRecurring ? RECURRING_WEEK_ID : input.weekId

  const days = {} as Record<WeekdayKey, AvailabilityDay>
  for (const key of WEEKDAY_KEYS) days[key] = toDay(input.days[key])

  const call = httpsCallable<
    {
      employeeId: string
      weekId: string
      type: AvailabilityType
      days: Record<WeekdayKey, AvailabilityDay>
      locationId?: string | null
    },
    { id: string; weekId: string }
  >(functions, 'submitAvailability')

  try {
    await call({
      employeeId: input.employeeId,
      weekId,
      type: input.type,
      days,
      locationId: input.locationId ?? null,
    })
  } catch (err) {
    if (isFirebaseError(err, 'availability/locked')) {
      throw new AvailabilityLockedError(weekId)
    }
    throw err as FunctionsError
  }

  const payload = {
    employeeId: input.employeeId,
    weekId,
    type: input.type,
    days,
    status: 'pending' as const,
    reviewedBy: null,
    reviewedAt: null,
    declineReason: null,
    submittedAt: serverTimestamp(),
    locationId: input.locationId ?? null,
    updatedAt: serverTimestamp(),
  }

  return { id: availabilityId(weekId, input.employeeId), ...payload }
}

/** Manager approval (§5). `reviewedBy` is the reviewing employee's id. */
export async function approveAvailability(id: string, reviewedBy: string): Promise<void> {
  await updateDoc(doc(db, COLLECTIONS.availability, id), {
    status: 'approved',
    reviewedBy,
    reviewedAt: serverTimestamp(),
    declineReason: null,
    updatedAt: serverTimestamp(),
  })
}

/**
 * Manager decline (§5). THE REASON IS REQUIRED — "declines require a reason
 * shown to the employee". An empty or whitespace-only reason is rejected here
 * rather than written as an empty string, because the employee's only route to
 * fixing their submission is reading why it was refused.
 */
export async function declineAvailability(
  id: string,
  reason: string,
  reviewedBy?: string,
): Promise<void> {
  const trimmed = reason.trim()
  if (!trimmed) {
    throw new Error('A decline reason is required (spec §5) and must not be empty.')
  }
  await updateDoc(doc(db, COLLECTIONS.availability, id), {
    status: 'declined',
    declineReason: trimmed,
    reviewedBy: reviewedBy ?? null,
    reviewedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
}

/**
 * Withdraw a week-specific override so the recurring baseline governs again.
 * Deleting is correct here — a withdrawn override should leave no trace that
 * the glance grid would render as an override band.
 */
export async function clearTemporaryAvailability(
  employeeId: string,
  weekId: string,
): Promise<void> {
  await deleteDoc(availabilityDoc(weekId, employeeId))
}
