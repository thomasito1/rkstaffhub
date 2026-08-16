/**
 * Task instance materialization — spec §10: "A Cloud Scheduler function
 * materializes taskInstances (daily at 4am for that day's daily + per-shift
 * tasks based on the published schedule; weekly on Monday; monthly on the
 * 1st)."
 *
 * Each of the three scheduled functions below does two things, in order:
 * first it sweeps the PRIOR period's still-`open` instances of its own
 * cadence(s) to `missed` (spec: "just flag as missed if incomplete by end of
 * day" — generalized the same way for week/month), THEN it creates the new
 * period's instances. Running the sweep first means a manager never sees a
 * stale "still open" instance sitting next to a brand-new one for the same
 * cadence.
 *
 * TWO DIFFERENT SHAPES, deliberately:
 *
 * - `role`/`department` assignTo, cadence daily/weekly/monthly: ONE pool
 *   instance (`assigneeEmployeeId: null`) — spec's "claimable pool tasks for
 *   their role" describes a single napkin-restock-style task anyone in scope
 *   claims, not one copy per eligible person.
 * - `employee` assignTo (any cadence): one instance PER listed employeeId,
 *   pre-assigned — no ambiguity about who, nothing to claim.
 * - `per-shift` cadence: one instance PER MATCHING PUBLISHED SHIFT that day,
 *   pre-assigned to that shift's own employeeId (shifts with no assignee are
 *   skipped — there's no one to walk through clock-out for it). This is
 *   INTENTIONALLY different from the daily/weekly/monthly pool shape above:
 *   "per-shift" names a 1:1 tie to a specific shift, so a day with three
 *   matching Server shifts materializes three instances, one per server,
 *   each surfacing at THAT server's own clock-out — never a shared pool.
 *
 * IDEMPOTENCY: every instance id is deterministic
 * (`${taskDefId}_${period}[_${employeeId-or-shiftId}]`), so a rerun (a
 * redeploy, a manual replay) only ever fills in what's missing — existing
 * instance ids are read first and skipped, never overwritten, so a rerun can
 * never clobber someone's already-`done`/`missed` instance.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { logger } from 'firebase-functions'

import { COLLECTIONS, db } from './firebase'
import { todayIsoInRestaurantTz, weekIdForIsoDate, yearMonthInRestaurantTz } from './punchHelpers'
import type { Department, EmployeeDoc, ShiftDoc, ShiftRoleDoc, TaskCadence, TaskDefinitionDoc, TaskInstanceDoc } from './model'
import { sendPush } from './push'

const RESTAURANT_TZ = 'America/New_York'

interface DefWithId extends TaskDefinitionDoc {
  id: string
}

interface Candidate {
  id: string
  data: Omit<TaskInstanceDoc, 'status'> & { status: 'open'; createdAt: FirebaseFirestore.FieldValue }
}

function baseInstance(
  def: DefWithId,
  period: string,
  cadence: TaskCadence,
  department: Department,
  assigneeEmployeeId: string | null,
): Candidate['data'] {
  return {
    taskDefId: def.id,
    title: def.title ?? '',
    titleEs: def.titleEs ?? '',
    dueRule: def.dueRule ?? '',
    requiresPhoto: def.requiresPhoto ?? false,
    cadence,
    period,
    assigneeEmployeeId,
    status: 'open',
    department,
    createdAt: FieldValue.serverTimestamp(),
  } as Candidate['data']
}

/** Every active task definition, regardless of cadence — a restaurant this size has a handful, not hundreds, so filtering cadence in code avoids an `in`-query composite index entirely. */
async function activeDefinitions(): Promise<DefWithId[]> {
  const snap = await db.collection(COLLECTIONS.tasks).where('active', '==', true).get()
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as TaskDefinitionDoc) }))
}

/** Pool (role/department) or per-employee candidates for a daily/weekly/monthly definition. */
async function poolOrEmployeeCandidates(def: DefWithId, period: string): Promise<Candidate[]> {
  const assignTo = def.assignTo
  if (!assignTo || assignTo.ids.length === 0) return []
  const cadence = def.cadence as TaskCadence

  if (assignTo.type === 'employee') {
    const candidates: Candidate[] = []
    for (const employeeId of assignTo.ids) {
      const empSnap = await db.collection(COLLECTIONS.employees).doc(employeeId).get()
      const department = ((empSnap.data() as EmployeeDoc | undefined)?.department ?? 'Admin') as Department
      candidates.push({
        id: `${def.id}_${period}_${employeeId}`,
        data: baseInstance(def, period, cadence, department, employeeId),
      })
    }
    return candidates
  }

  let department: Department = 'Admin'
  if (assignTo.type === 'department') {
    department = (assignTo.ids[0] as Department) ?? 'Admin'
  } else {
    const roleId = assignTo.ids[0]
    if (roleId) {
      const roleSnap = await db.collection(COLLECTIONS.shiftRoles).doc(roleId).get()
      department = ((roleSnap.data() as ShiftRoleDoc | undefined)?.department ?? 'Admin') as Department
    }
  }
  return [{ id: `${def.id}_${period}`, data: baseInstance(def, period, cadence, department, null) }]
}

function shiftMatchesAssignTo(shift: ShiftDoc, assignTo: TaskDefinitionDoc['assignTo']): boolean {
  if (!assignTo) return false
  if (assignTo.type === 'role') return !!shift.roleId && assignTo.ids.includes(shift.roleId)
  if (assignTo.type === 'department') return !!shift.department && assignTo.ids.includes(shift.department)
  return !!shift.employeeId && assignTo.ids.includes(shift.employeeId)
}

/** One instance per matching PUBLISHED shift on `date`, pre-assigned to that shift's employeeId. Shifts with no assignee are skipped. */
async function perShiftCandidates(def: DefWithId, date: string, weekId: string): Promise<Candidate[]> {
  const shiftsSnap = await db
    .collection(COLLECTIONS.schedules)
    .doc(weekId)
    .collection('shifts')
    .where('date', '==', date)
    .where('status', '==', 'published')
    .get()

  const candidates: Candidate[] = []
  for (const shiftDoc of shiftsSnap.docs) {
    const shift = shiftDoc.data() as ShiftDoc
    if (!shift.employeeId) continue
    if (!shiftMatchesAssignTo(shift, def.assignTo)) continue
    candidates.push({
      id: `${def.id}_${weekId}_${shiftDoc.id}`,
      data: { ...baseInstance(def, date, 'per-shift', shift.department ?? 'Admin', shift.employeeId), shiftId: shiftDoc.id },
    })
  }
  return candidates
}

/** Writes every candidate whose id doesn't already exist — a rerun only ever fills gaps. */
async function createMissing(candidates: Candidate[]): Promise<number> {
  if (candidates.length === 0) return 0
  const refs = candidates.map((c) => db.collection(COLLECTIONS.taskInstances).doc(c.id))
  const existing = await db.getAll(...refs)
  const batch = db.batch()
  let created = 0
  existing.forEach((snap, i) => {
    const candidate = candidates[i]
    const ref = refs[i]
    if (snap.exists || !candidate || !ref) return
    batch.set(ref, candidate.data)
    created += 1
  })
  if (created > 0) await batch.commit()
  return created
}

/** Managers in `department` (Owner/GM included, matching `checkForgottenClockOuts`' own lookup). */
async function managersInDepartment(department: Department): Promise<string[]> {
  const snap = await db
    .collection(COLLECTIONS.employees)
    .where('department', '==', department)
    .where('status', '==', 'active')
    .where('accessRole', 'in', ['manager', 'gm', 'owner'])
    .get()
  return snap.docs.map((d) => d.id)
}

/** Marks still-`open` instances of `cadence` whose `period` is strictly before `currentPeriod` as `missed`, and notifies that department's managers per instance (spec §15: "missed tasks (managers)"). ISO period strings ("YYYY-MM-DD" / weekId / "YYYY-MM") sort lexicographically, so plain string comparison is exact. */
async function sweepMissed(cadence: TaskCadence, currentPeriod: string): Promise<void> {
  const snap = await db
    .collection(COLLECTIONS.taskInstances)
    .where('cadence', '==', cadence)
    .where('status', '==', 'open')
    .get()

  const toMiss = snap.docs.filter((d) => {
    const period = (d.data() as TaskInstanceDoc).period
    return typeof period === 'string' && period < currentPeriod
  })
  if (toMiss.length === 0) return

  const batch = db.batch()
  for (const doc of toMiss) batch.update(doc.ref, { status: 'missed', updatedAt: FieldValue.serverTimestamp() })
  await batch.commit()

  for (const doc of toMiss) {
    const instance = doc.data() as TaskInstanceDoc
    const department = (instance.department ?? 'Admin') as Department
    const managerIds = await managersInDepartment(department)
    if (managerIds.length === 0) continue
    const { failed } = await sendPush({
      employeeIds: managerIds,
      category: 'task.missed',
      params: { taskTitle: { en: instance.title ?? '', es: instance.titleEs ?? '' }, dateLabel: instance.period ?? '' },
    })
    if (failed.length > 0) {
      logger.error('failed to notify some managers about a missed task', { instanceId: doc.id, failed })
    }
  }
}

export const materializeDailyTasks = onSchedule(
  { schedule: '0 4 * * *', timeZone: RESTAURANT_TZ },
  async () => {
    const today = todayIsoInRestaurantTz()
    await sweepMissed('daily', today)
    await sweepMissed('per-shift', today)

    const weekId = weekIdForIsoDate(today)
    const defs = await activeDefinitions()

    const candidates: Candidate[] = []
    for (const def of defs) {
      if (def.cadence === 'daily') candidates.push(...(await poolOrEmployeeCandidates(def, today)))
      if (def.cadence === 'per-shift') candidates.push(...(await perShiftCandidates(def, today, weekId)))
    }
    const created = await createMissing(candidates)
    logger.info('materializeDailyTasks', { today, created })
  },
)

export const materializeWeeklyTasks = onSchedule(
  { schedule: '0 4 * * 1', timeZone: RESTAURANT_TZ },
  async () => {
    const weekId = weekIdForIsoDate(todayIsoInRestaurantTz())
    await sweepMissed('weekly', weekId)

    const defs = await activeDefinitions()
    const candidates: Candidate[] = []
    for (const def of defs) {
      if (def.cadence === 'weekly') candidates.push(...(await poolOrEmployeeCandidates(def, weekId)))
    }
    const created = await createMissing(candidates)
    logger.info('materializeWeeklyTasks', { weekId, created })
  },
)

export const materializeMonthlyTasks = onSchedule(
  { schedule: '0 4 1 * *', timeZone: RESTAURANT_TZ },
  async () => {
    const yearMonth = yearMonthInRestaurantTz()
    await sweepMissed('monthly', yearMonth)

    const defs = await activeDefinitions()
    const candidates: Candidate[] = []
    for (const def of defs) {
      if (def.cadence === 'monthly') candidates.push(...(await poolOrEmployeeCandidates(def, yearMonth)))
    }
    const created = await createMissing(candidates)
    logger.info('materializeMonthlyTasks', { yearMonth, created })
  },
)
