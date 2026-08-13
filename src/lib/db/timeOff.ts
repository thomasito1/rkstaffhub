/**
 * Time-off data access — `timeOff/{requestId}` (spec §3, §6).
 *
 * Time off is the one availability signal that BLOCKS scheduling rather than
 * warning: §6's conflicts engine refuses to schedule against approved time off,
 * where it merely warns about "not available". That is why every request
 * carries a `conflicts` array of shift ids — the approver needs to see, at the
 * moment they approve, exactly which already-scheduled shifts they are about to
 * break. Computing it at approval time only would hide the damage until later.
 *
 * Dates are inclusive plain "YYYY-MM-DD" strings, matching how a person asks
 * for time off ("the 14th through the 16th"), so no instant and no timezone is
 * involved in the comparison.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type DocumentSnapshot,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'

import { weekIdsBetween } from '@/lib/deadlines'
import { COLLECTIONS, db } from '@/lib/firebase'
import type { TimeOffCategory, TimeOffRequest, TimeOffStatus } from '@/types/models'

import { isPermissionDenied, readOrNullIfDenied } from './errors'
import { listShifts } from './schedules'

export interface NewTimeOffInput {
  employeeId: string
  /** Inclusive "YYYY-MM-DD" bounds. */
  startDate: string
  endDate: string
  category: TimeOffCategory
  reason?: string
  locationId?: string | null
}

function timeOffDoc(id: string) {
  return doc(db, COLLECTIONS.timeOff, id)
}

function toTimeOff(
  snap: DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>,
): TimeOffRequest {
  const d = snap.data() ?? {}
  const status = d.status
  const category = d.category
  return {
    id: snap.id,
    employeeId: String(d.employeeId ?? ''),
    startDate: String(d.startDate ?? ''),
    endDate: String(d.endDate ?? ''),
    category: category === 'paid' ? 'paid' : 'unpaid',
    reason: String(d.reason ?? ''),
    status:
      status === 'approved' || status === 'declined' ? (status as TimeOffStatus) : 'pending',
    reviewedBy: (d.reviewedBy as string | null) ?? null,
    reviewedAt: d.reviewedAt ?? null,
    conflicts: Array.isArray(d.conflicts) ? d.conflicts.map(String) : [],
    declineReason: (d.declineReason as string | null) ?? null,
    locationId: (d.locationId as string | null) ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

/** Soonest first — a time-off list is read forwards in time. */
function byStartDate(a: TimeOffRequest, b: TimeOffRequest): number {
  return a.startDate.localeCompare(b.startDate) || a.employeeId.localeCompare(b.employeeId)
}

// ── conflicts ────────────────────────────────────────────────────────────────

/**
 * Shift ids that already sit inside a requested range (§6).
 *
 * Shifts live under `schedules/{weekId}/shifts`, so a date range is resolved by
 * scanning the weeks it touches — usually one or two — and filtering on the
 * shift's own date. There is no collection-group query here on purpose: a
 * collection group over every week of shifts, for a three-day request, would be
 * a far bigger read and would need its own index.
 *
 * Cancelled shifts are excluded (listShifts default): a cancelled shift is not a
 * conflict, nobody is expected to work it. Open shifts never conflict either —
 * they belong to no one.
 *
 * NOTE ON VISIBILITY. listShifts returns [] where the rules deny a read, so an
 * employee requesting time off against a week they cannot see yet (an
 * unpublished draft) will submit with an empty conflict list. This is why the
 * approver's screen must recompute conflicts before approving rather than
 * trusting the stored array — a manager can see the drafts the employee cannot.
 */
export async function findConflictingShifts(
  employeeId: string,
  startDate: string,
  endDate: string,
): Promise<string[]> {
  if (endDate < startDate) return []

  const weekIds = weekIdsBetween(startDate, endDate)
  const perWeek = await Promise.all(
    weekIds.map((weekId) => listShifts(weekId, { employeeId })),
  )

  return perWeek
    .flat()
    .filter((s) => s.date >= startDate && s.date <= endDate)
    .map((s) => s.id)
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function getTimeOff(id: string): Promise<TimeOffRequest | null> {
  return readOrNullIfDenied(async () => {
    const snap = await getDoc(timeOffDoc(id))
    return snap.exists() ? toTimeOff(snap) : null
  })
}

/**
 * Requests, newest range first. `employeeId` and `status` are pushed to
 * Firestore as single-field equalities when only one of them is given; asking
 * for both narrows the second client-side so this never needs a composite index.
 *
 * A date window filters client-side on overlap — a request from the 10th to the
 * 20th conflicts with a week in the middle of it, which a range query on
 * startDate alone would miss.
 */
export async function listTimeOff(opts?: {
  employeeId?: string
  status?: TimeOffStatus
  /** Inclusive window; returns requests that OVERLAP it at all. */
  from?: string
  to?: string
}): Promise<TimeOffRequest[]> {
  const constraints: QueryConstraint[] = []
  if (opts?.employeeId) constraints.push(where('employeeId', '==', opts.employeeId))
  else if (opts?.status) constraints.push(where('status', '==', opts.status))

  try {
    const snap = await getDocs(query(collection(db, COLLECTIONS.timeOff), ...constraints))
    return snap.docs
      .map(toTimeOff)
      .filter((r) => (opts?.status ? r.status === opts.status : true))
      .filter((r) => (opts?.to ? r.startDate <= opts.to : true))
      .filter((r) => (opts?.from ? r.endDate >= opts.from : true))
      .sort(byStartDate)
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}

// ── writes ───────────────────────────────────────────────────────────────────

/**
 * File a request, with its conflicting shifts captured up front (§6).
 *
 * Rejects a backwards range rather than storing one: an end before its start
 * would silently match nothing in every conflict check that ever ran against it.
 */
export async function requestTimeOff(input: NewTimeOffInput): Promise<TimeOffRequest> {
  if (input.endDate < input.startDate) {
    throw new Error(
      `Time-off range ends before it starts (${input.startDate} → ${input.endDate}).`,
    )
  }

  const conflicts = await findConflictingShifts(
    input.employeeId,
    input.startDate,
    input.endDate,
  )

  const ref = doc(collection(db, COLLECTIONS.timeOff))
  const payload = {
    employeeId: input.employeeId,
    startDate: input.startDate,
    endDate: input.endDate,
    category: input.category,
    reason: input.reason?.trim() ?? '',
    status: 'pending' as const,
    reviewedBy: null,
    reviewedAt: null,
    conflicts,
    declineReason: null,
    locationId: input.locationId ?? null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  await setDoc(ref, payload)

  return { id: ref.id, ...payload }
}

/**
 * Approve (§6). Conflicts are RECOMPUTED first: the request may have sat in the
 * queue while the schedule moved underneath it, and an approver must not be
 * shown a stale "no conflicts" from the day it was filed. Approved time off
 * blocks scheduling, so the stored list is what the builder later trusts.
 *
 * Approving over conflicts is allowed — someone has to be able to say "yes, and
 * we will cover those shifts" — but the shifts are recorded, not silently kept.
 */
export async function approveTimeOff(
  id: string,
  reviewedBy: string,
): Promise<{ conflicts: string[] }> {
  const existing = await getTimeOff(id)
  const conflicts = existing
    ? await findConflictingShifts(existing.employeeId, existing.startDate, existing.endDate)
    : []

  await updateDoc(timeOffDoc(id), {
    status: 'approved',
    reviewedBy,
    reviewedAt: serverTimestamp(),
    conflicts,
    declineReason: null,
    updatedAt: serverTimestamp(),
  })

  return { conflicts }
}

/**
 * Decline (§6). A reason is optional in the spec for time off — unlike an
 * availability decline, which §5 explicitly requires one for — but it is stored
 * whenever given and the UI should ask for it.
 */
export async function declineTimeOff(
  id: string,
  reviewedBy: string,
  reason?: string,
): Promise<void> {
  const trimmed = reason?.trim()
  await updateDoc(timeOffDoc(id), {
    status: 'declined',
    reviewedBy,
    reviewedAt: serverTimestamp(),
    declineReason: trimmed && trimmed.length > 0 ? trimmed : null,
    updatedAt: serverTimestamp(),
  })
}

/**
 * Refresh the stored conflicts without deciding the request — for the approver
 * screen, which recomputes on open so the cards it shows are current.
 */
export async function refreshTimeOffConflicts(id: string): Promise<string[]> {
  const existing = await getTimeOff(id)
  if (!existing) return []
  const conflicts = await findConflictingShifts(
    existing.employeeId,
    existing.startDate,
    existing.endDate,
  )
  await updateDoc(timeOffDoc(id), { conflicts, updatedAt: serverTimestamp() })
  return conflicts
}
