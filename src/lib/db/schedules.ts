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
 * unconditionally — a log a client can write is a log a client can forge.
 * RESOLVED (Aug 13, 2026 ruling — promoted from tracked gap to first task):
 * publishSchedule()/republishSchedule() now call the `recordSchedulePublish`
 * Cloud Function (functions/src/schedulePublish.ts), pattern-matched to
 * `recordScheduleOverride`. The Function independently derives publish-vs-
 * republish from the week's CURRENTLY STORED status — it does not trust a
 * client-asserted mode — flips the shifts and the week atomically in one
 * transaction, and then writes the auditLog entry the client could never
 * write. Do not revert this to a client-side batch write; that is exactly the
 * gap this closed.
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
import { COLLECTIONS, db, functions } from '@/lib/firebase'
import { httpsCallable } from 'firebase/functions'
import type {
  AiDraftMeta,
  Department,
  Schedule,
  ScheduleStatus,
  Shift,
  ShiftStatus,
  SkillLevel,
} from '@/types/models'

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
/**
 * RESOLVED (was: "Phase 2 change needed" — see firestore.rules for the full
 * history). `department` and `status` are pushed into the Firestore QUERY as
 * `where()` equality constraints, not applied as a post-fetch `.filter()`.
 *
 * That distinction is load-bearing. Firestore evaluates the security rule
 * against every document a query would return and denies the WHOLE query if
 * any one of them fails — it does not silently filter. The shifts rule allows
 * a staff member to read a shift only when it is published AND (theirs OR in
 * their department). If `listShifts()` fetched the whole subcollection and
 * filtered client-side, a staff member's call on a mixed FOH/BOH or
 * mixed draft/published week would be denied outright, and this function's
 * catch would turn that into a silent `[]` — indistinguishable from "nothing
 * scheduled."
 *
 * Pushing `department`/`status` into the query means the query itself can
 * only ever match documents the rule already allows, so it succeeds. Both are
 * plain equality filters — Firestore does not require a composite index for
 * multiple `==` clauses with no `orderBy`, so no `firestore.indexes.json`
 * change was needed.
 *
 * CALLER CONTRACT: any staff-facing call MUST pass both
 * `{ department: employee.department, status: 'published' }`. Prefer
 * `listPublishedShiftsForDepartment()` below, which makes that the only option.
 * `includeCancelled`/`openOnly` stay as post-fetch filters — they narrow a
 * result set the rule has already approved, so they cannot trigger a denial.
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
  if (opts?.department) constraints.push(where('department', '==', opts.department))
  if (opts?.status) constraints.push(where('status', '==', opts.status))

  try {
    const snap = await getDocs(query(shiftsCollection(weekId), ...constraints))
    return snap.docs
      .map((s) => toShift(weekId, s))
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

/**
 * The ONLY correct way for a staff-facing screen to list a week's shifts.
 * Confirmed policy: staff see only their own department's published schedule —
 * FOH staff cannot view BOH's week and vice versa. Managers+ hold
 * `schedule.create`/`schedule.edit` and bypass department scoping entirely in
 * the rule, so this helper is for staff call sites, not admin ones.
 *
 * Forces both required constraints so a future caller cannot accidentally
 * regress to the client-side-filter bug this replaced.
 */
export async function listPublishedShiftsForDepartment(
  weekId: string,
  department: Department,
): Promise<Shift[]> {
  return listShifts(weekId, { department, status: 'published' })
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

/**
 * Both publish and republish call the SAME Cloud Function: the server derives
 * which one this is from the week's currently stored status, not from a
 * client-asserted mode (see file header). A client "publishing" an
 * already-live week is corrected to a republish, not obeyed.
 */
async function callRecordSchedulePublish(weekId: string): Promise<PublishResult> {
  const call = httpsCallable<
    { weekId: string },
    {
      weekId: string
      status: 'published' | 'republished'
      publishedShiftIds: string[]
      notifyEmployeeIds: string[]
    }
  >(functions, 'recordSchedulePublish')

  const res = await call({ weekId })
  return {
    weekId: res.data.weekId,
    status: res.data.status,
    publishedShiftIds: res.data.publishedShiftIds,
    notifyEmployeeIds: res.data.notifyEmployeeIds,
  }
}

/**
 * Draft → Published (§6). Flips every draft shift in the week to 'published',
 * stamps the week document, and writes the §17 auditLog entry — all inside
 * `recordSchedulePublish` (functions/src/schedulePublish.ts), atomically for
 * the state change and as a best-effort follow-up write for the audit entry,
 * matching `recordScheduleOverride`'s shape.
 */
export async function publishSchedule(weekId: string): Promise<PublishResult> {
  return callRecordSchedulePublish(weekId)
}

/**
 * Published → Republished (§6): edits made after a publish go live, and only
 * the affected employees are notified — the owners of shifts THIS call
 * flipped from draft. Edits to an ALREADY-published shift (a time change, a
 * reassignment) do not currently appear in that set; catching those needs a
 * per-shift change log, which remains a separate, not-yet-built gap.
 */
export async function republishSchedule(weekId: string): Promise<PublishResult> {
  return callRecordSchedulePublish(weekId)
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
