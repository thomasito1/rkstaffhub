/**
 * Schedule + shift data access — `schedules/{weekId}` and its `shifts`
 * subcollection (spec §3, §6, §17).
 *
 * The week document is the unit of publication; the shifts under it are the
 * unit of editing. Everything is keyed by weekId (the ISO Monday), so the
 * builder, the staff "My Shifts" view and the labor footer all address the same
 * documents without a date-range query.
 *
 * PUBLISH IS A SENSITIVE MUTATION. §17 requires an `auditLog` entry for every
 * schedule publish, and firestore.rules denies auditLog writes to all clients
 * unconditionally — a log a client can write is a log a client can forge. So
 * publishSchedule()/republishSchedule() BUILD the entry with the shared
 * buildAuditEntry() and hand it back to the caller; the write itself belongs to
 * the Cloud Function that will own the whole publish transaction. See the TODOs
 * on those two functions. Do not "fix" this by calling addDoc on auditLog — it
 * will be denied, and correctly so.
 *
 * NOT IN THIS MODULE: the §6 conflicts engine (double-booking, approved time
 * off, skill floor, overtime) and labor cost math. Those are computed views
 * over this data and belong beside the builder, not in the data layer.
 */

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type DocumentData,
  type DocumentSnapshot,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'

import { addDaysToIsoDate, datesForWeekId } from '@/lib/deadlines'
import { COLLECTIONS, db } from '@/lib/firebase'
import type {
  AiDraftMeta,
  AuditEntry,
  Department,
  Schedule,
  ScheduleStatus,
  Shift,
  ShiftStatus,
  SkillLevel,
} from '@/types/models'

import { buildAuditEntry } from './audit'
import { isPermissionDenied, readOrNullIfDenied } from './errors'

// ── shapes ───────────────────────────────────────────────────────────────────

export interface NewShiftInput {
  /** Omit or pass null for an OPEN shift — the unassigned row per role (§6). */
  employeeId?: string | null
  /** "YYYY-MM-DD". Must fall inside the target week. */
  date: string
  /** "HH:mm" 24h, restaurant local time. */
  startTime: string
  endTime: string
  roleId: string
  requiredSkillLevel?: SkillLevel
  department: Department
  station?: string | null
  notes?: string | null
  isOnCall?: boolean
  status?: ShiftStatus
  locationId?: string | null
}

/** Who performed a sensitive mutation. The db layer never reads auth itself. */
export interface Actor {
  employeeId: string
  uid: string
}

export interface PublishResult {
  weekId: string
  status: ScheduleStatus
  /** Shift ids moved from draft to published by this call. */
  publishedShiftIds: string[]
  /**
   * Employees to notify (§6). For a first publish this is everyone scheduled;
   * for a republish it is only the owners of shifts this call changed —
   * "targeted notifications only to affected employees".
   */
  notifyEmployeeIds: string[]
  /** Built, NOT written — see the file header. Hand to the callable. */
  auditEntry: Omit<AuditEntry, 'id'>
}

/** Firestore rejects `undefined`; a patch of optional fields is full of it. */
function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out
}

// ── internals ────────────────────────────────────────────────────────────────

function scheduleDoc(weekId: string) {
  return doc(db, COLLECTIONS.schedules, weekId)
}

function shiftsCollection(weekId: string) {
  return collection(db, `${COLLECTIONS.schedules}/${weekId}/shifts`)
}

function shiftDoc(weekId: string, shiftId: string) {
  return doc(db, `${COLLECTIONS.schedules}/${weekId}/shifts/${shiftId}`)
}

function toSchedule(snap: DocumentSnapshot<DocumentData>): Schedule {
  const d = snap.data() ?? {}
  const status = d.status
  return {
    id: snap.id,
    weekId: String(d.weekId ?? snap.id),
    status:
      status === 'published' || status === 'republished'
        ? (status as ScheduleStatus)
        : 'draft',
    publishedAt: d.publishedAt ?? null,
    publishedBy: (d.publishedBy as string | null) ?? null,
    laborTargetPct: (d.laborTargetPct as number | null) ?? null,
    aiDraftMeta: (d.aiDraftMeta as AiDraftMeta | null) ?? null,
    locationId: (d.locationId as string | null) ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

const SHIFT_STATUSES: ShiftStatus[] = ['draft', 'published', 'traded', 'dropped', 'cancelled']

function toShift(
  weekId: string,
  snap: DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>,
): Shift {
  const d = snap.data() ?? {}
  const status = d.status as ShiftStatus
  const skill = Number(d.requiredSkillLevel ?? 1)
  return {
    id: snap.id,
    // Filled from the path, never trusted from the document — the parent key is
    // the authority on which week a shift belongs to.
    weekId,
    employeeId: (d.employeeId as string | null) ?? null,
    date: String(d.date ?? ''),
    startTime: String(d.startTime ?? ''),
    endTime: String(d.endTime ?? ''),
    roleId: String(d.roleId ?? ''),
    requiredSkillLevel: (skill === 2 || skill === 3 ? skill : 1) as SkillLevel,
    department: (d.department as Department) ?? 'FOH',
    station: (d.station as string | null) ?? null,
    notes: (d.notes as string | null) ?? null,
    isOnCall: d.isOnCall === true,
    status: SHIFT_STATUSES.includes(status) ? status : 'draft',
    locationId: (d.locationId as string | null) ?? null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

function byStartTime(a: Shift, b: Shift): number {
  return a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)
}

/** Distinct assigned employees, open shifts excluded. */
function assignedEmployeeIds(shifts: Shift[]): string[] {
  return [...new Set(shifts.map((s) => s.employeeId).filter((id): id is string => id !== null))]
}

// ── reads ────────────────────────────────────────────────────────────────────

/**
 * The week document. `null` = no schedule started for that week OR not visible
 * to you (staff can only read a published schedule for their department, §17).
 */
export async function getSchedule(weekId: string): Promise<Schedule | null> {
  return readOrNullIfDenied(async () => {
    const snap = await getDoc(scheduleDoc(weekId))
    return snap.exists() ? toSchedule(snap) : null
  })
}

/**
 * Every shift in a week, chronologically.
 *
 * Filters that map to a single equality (`employeeId`, `date`, `roleId`) are
 * pushed to Firestore where they are covered by automatic single-field indexes;
 * status narrowing happens client-side so no combination of these needs a
 * composite index for what is at most a couple hundred documents per week.
 *
 * Cancelled shifts are excluded by default — they are kept for history but must
 * never render as coverage in the builder or in "Who's Working".
 */
export async function listShifts(
  weekId: string,
  opts?: {
    employeeId?: string
    date?: string
    roleId?: string
    department?: Department
    status?: ShiftStatus
    includeCancelled?: boolean
    /** true = only open shifts, false = only assigned. */
    openOnly?: boolean
  },
): Promise<Shift[]> {
  const constraints: QueryConstraint[] = []
  if (opts?.employeeId) constraints.push(where('employeeId', '==', opts.employeeId))
  if (opts?.date) constraints.push(where('date', '==', opts.date))
  if (opts?.roleId) constraints.push(where('roleId', '==', opts.roleId))

  try {
    const snap = await getDocs(query(shiftsCollection(weekId), ...constraints))
    return snap.docs
      .map((s) => toShift(weekId, s))
      .filter((s) => (opts?.department ? s.department === opts.department : true))
      .filter((s) => (opts?.status ? s.status === opts.status : true))
      .filter((s) => (opts?.includeCancelled ? true : s.status !== 'cancelled'))
      .filter((s) =>
        opts?.openOnly === undefined
          ? true
          : opts.openOnly
            ? s.employeeId === null
            : s.employeeId !== null,
      )
      .sort(byStartTime)
  } catch (err) {
    if (isPermissionDenied(err)) return []
    throw err
  }
}

/** One shift. `null` on missing or denied. */
export async function getShift(weekId: string, shiftId: string): Promise<Shift | null> {
  return readOrNullIfDenied(async () => {
    const snap = await getDoc(shiftDoc(weekId, shiftId))
    return snap.exists() ? toShift(weekId, snap) : null
  })
}

// ── writes ───────────────────────────────────────────────────────────────────

/**
 * Ensure the week document exists so shifts have a parent to be published with.
 * `merge: true` — never clobber an existing week's status or labor target.
 */
export async function ensureSchedule(
  weekId: string,
  opts?: { laborTargetPct?: number | null },
): Promise<Schedule> {
  const existing = await getSchedule(weekId)
  if (existing) {
    if (opts?.laborTargetPct !== undefined) {
      await updateDoc(scheduleDoc(weekId), {
        laborTargetPct: opts.laborTargetPct,
        updatedAt: serverTimestamp(),
      })
      return { ...existing, laborTargetPct: opts.laborTargetPct }
    }
    return existing
  }

  const created = {
    weekId,
    status: 'draft' as const,
    publishedAt: null,
    publishedBy: null,
    laborTargetPct: opts?.laborTargetPct ?? null,
    aiDraftMeta: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  await setDoc(scheduleDoc(weekId), created, { merge: true })
  return { id: weekId, ...created }
}

/** Manual week-level labor target for the §6 footer (no POS integration in v1). */
export async function setLaborTargetPct(weekId: string, pct: number | null): Promise<void> {
  await updateDoc(scheduleDoc(weekId), { laborTargetPct: pct, updatedAt: serverTimestamp() })
}

/**
 * Add a shift to a week's draft.
 *
 * New shifts are 'draft' regardless of the week's status: a shift added to an
 * already-published week is not live until someone republishes, which is what
 * makes the §6 republish step meaningful instead of decorative.
 */
export async function createShift(weekId: string, input: NewShiftInput): Promise<Shift> {
  await ensureSchedule(weekId)

  const ref = doc(shiftsCollection(weekId))
  const payload = {
    employeeId: input.employeeId ?? null,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    roleId: input.roleId,
    requiredSkillLevel: input.requiredSkillLevel ?? 1,
    department: input.department,
    station: input.station ?? null,
    notes: input.notes ?? null,
    isOnCall: input.isOnCall ?? false,
    status: input.status ?? ('draft' as ShiftStatus),
    locationId: input.locationId ?? null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  }
  await setDoc(ref, payload)

  return {
    id: ref.id,
    weekId,
    ...payload,
    requiredSkillLevel: payload.requiredSkillLevel as SkillLevel,
  }
}

/**
 * Patch a shift. `weekId` and `id` are not patchable — moving a shift to a
 * different week means a different document, so callers create and delete
 * rather than pretending a subcollection key can be edited.
 */
export async function updateShift(
  weekId: string,
  shiftId: string,
  patch: Partial<Omit<Shift, 'id' | 'weekId' | 'createdAt' | 'updatedAt'>>,
): Promise<void> {
  await updateDoc(shiftDoc(weekId, shiftId), {
    ...pruneUndefined(patch),
    updatedAt: serverTimestamp(),
  })
}

/** Assign an open shift, or hand it to someone else. `null` reopens it. */
export async function assignShift(
  weekId: string,
  shiftId: string,
  employeeId: string | null,
): Promise<void> {
  await updateShift(weekId, shiftId, { employeeId })
}

/**
 * Hard delete. Correct for a draft shift created in error.
 *
 * A shift that has already been published should usually be cancelled instead
 * (`updateShift(..., { status: 'cancelled' })`) so the person who was told to
 * come in still has a record of it; deleting it makes the change invisible to
 * them. This function does not enforce that — the builder decides — but the
 * distinction is deliberate.
 */
export async function deleteShift(weekId: string, shiftId: string): Promise<void> {
  await deleteDoc(shiftDoc(weekId, shiftId))
}

// ── publish ──────────────────────────────────────────────────────────────────

async function publishInternal(
  weekId: string,
  actor: Actor,
  mode: 'publish' | 'republish',
): Promise<PublishResult> {
  const shifts = await listShifts(weekId)
  const draftShifts = shifts.filter((s) => s.status === 'draft')

  const batch = writeBatch(db)
  for (const s of draftShifts) {
    batch.update(shiftDoc(weekId, s.id), { status: 'published', updatedAt: serverTimestamp() })
  }

  const status: ScheduleStatus = mode === 'publish' ? 'published' : 'republished'
  batch.set(
    scheduleDoc(weekId),
    {
      weekId,
      status,
      publishedAt: serverTimestamp(),
      publishedBy: actor.employeeId,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  )
  await batch.commit()

  // §6: first publish notifies everyone scheduled; a republish notifies only
  // the employees whose shifts this call actually changed.
  const notifyEmployeeIds =
    mode === 'publish' ? assignedEmployeeIds(shifts) : assignedEmployeeIds(draftShifts)

  // §17 requires an auditLog entry for every schedule publish. Built here so
  // the payload shape lives with the mutation; NOT written, because
  // firestore.rules denies auditLog writes to every client (see file header).
  //
  // TODO(Phase 2 — Cloud Function): move this whole function server-side as a
  // callable `publishSchedule({ weekId, mode })` that flips the shifts, stamps
  // the week, appends this exact entry to auditLog, and fans out the
  // notifications. Until then the audit trail for publishes is INCOMPLETE —
  // the client cannot close that gap on its own, and faking it here would be
  // worse than the gap.
  const auditEntry = buildAuditEntry({
    action: 'schedule.publish',
    actorEmployeeId: actor.employeeId,
    actorUid: actor.uid,
    targetType: 'schedule',
    targetId: weekId,
    reason: null,
    before: { status: mode === 'publish' ? 'draft' : 'published' },
    after: {
      status,
      mode,
      shiftsPublished: draftShifts.length,
      notifiedEmployeeIds: notifyEmployeeIds,
    },
  })

  return {
    weekId,
    status,
    publishedShiftIds: draftShifts.map((s) => s.id),
    notifyEmployeeIds,
    auditEntry,
  }
}

/**
 * Draft → Published (§6). Flips every draft shift in the week to 'published'
 * and stamps the week document.
 *
 * Returns the audit entry to write and the employees to notify; see the TODO
 * inside publishInternal for why neither happens here.
 */
export async function publishSchedule(weekId: string, actor: Actor): Promise<PublishResult> {
  return publishInternal(weekId, actor, 'publish')
}

/**
 * Published → Republished (§6): edits made after a publish go live, and only
 * the affected employees are notified.
 *
 * "Affected" is approximated as the owners of the shifts this call flipped from
 * draft — which is exactly the set of shifts added since the last publish. Edits
 * to an ALREADY-published shift (a time change, a reassignment) do not currently
 * appear in that set; catching those needs a per-shift change log, which is part
 * of the same Cloud Function job as the audit write.
 */
export async function republishSchedule(weekId: string, actor: Actor): Promise<PublishResult> {
  return publishInternal(weekId, actor, 'republish')
}

// ── copy week ────────────────────────────────────────────────────────────────

export interface CopyWeekResult {
  createdShiftIds: string[]
  /** Source shifts whose date fell outside the source week — skipped, not guessed. */
  skipped: number
}

/**
 * "Copy week from previous" — a required §6 convenience.
 *
 * Each source shift is re-dated by its position in the week (Monday→Monday,
 * Saturday→Saturday) rather than by adding a fixed number of days, so a copy
 * across a DST boundary lands on the right weekday.
 *
 * Copies land as 'draft' and carry no publish state: copying into a published
 * week stages the shifts for a republish rather than silently putting people on
 * the floor. Cancelled, dropped and traded source shifts are not copied — they
 * describe what happened to that week, not the shape of a normal week. Employee
 * assignments ARE copied (that is the point of the feature); the §6 conflicts
 * engine flags anyone who is now on approved time off.
 *
 * Not idempotent: calling it twice copies twice. The builder confirms first.
 */
export async function copyWeekFrom(
  sourceWeekId: string,
  targetWeekId: string,
): Promise<CopyWeekResult> {
  const sourceDates = datesForWeekId(sourceWeekId)
  const sourceShifts = (await listShifts(sourceWeekId, { includeCancelled: true })).filter(
    (s) => s.status === 'draft' || s.status === 'published',
  )

  await ensureSchedule(targetWeekId)

  const createdShiftIds: string[] = []
  let skipped = 0
  const batch = writeBatch(db)

  for (const s of sourceShifts) {
    const dayIndex = sourceDates.indexOf(s.date)
    if (dayIndex === -1) {
      skipped += 1
      continue
    }

    const ref = doc(shiftsCollection(targetWeekId))
    batch.set(ref, {
      employeeId: s.employeeId,
      date: addDaysToIsoDate(targetWeekId, dayIndex),
      startTime: s.startTime,
      endTime: s.endTime,
      roleId: s.roleId,
      requiredSkillLevel: s.requiredSkillLevel,
      department: s.department,
      station: s.station,
      notes: s.notes ?? null,
      isOnCall: s.isOnCall,
      status: 'draft' as ShiftStatus,
      locationId: s.locationId ?? null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    })
    createdShiftIds.push(ref.id)
  }

  // A full week is ~150 shifts, comfortably inside the 500-write batch limit;
  // the copy is atomic so a half-copied week can never reach the builder.
  if (createdShiftIds.length > 0) await batch.commit()

  return { createdShiftIds, skipped }
}
