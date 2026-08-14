import { useCallback, useEffect, useMemo, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'

import {
  createShift as dbCreateShift,
  deleteShift as dbDeleteShift,
  updateShift as dbUpdateShift,
  effectiveAvailabilityFor,
  getAppSettings,
  getEmployeeCompensation,
  getSchedule,
  listEmployees,
  listShiftRoles,
  listShifts,
  listTimeOff,
  publishSchedule as dbPublishSchedule,
  republishSchedule as dbRepublishSchedule,
  type Actor,
  type EmployeeCompensation,
  type NewShiftInput,
  type PublishResult,
} from '@/lib/db'
import { COLLECTIONS, db } from '@/lib/firebase'
import { datesForWeekId } from '@/lib/deadlines'
import {
  findConflicts,
  type Conflict,
  type ConflictContext,
  type ShiftLike,
} from '@/lib/scheduling/conflicts'
import {
  WEEKDAY_KEYS,
  type Employee,
  type Schedule,
  type Shift,
  type ShiftRole,
  type TimeOffRequest,
  type WeekdayKey,
} from '@/types/models'

/**
 * Assembles everything the §6 conflicts engine needs to run against REAL
 * seeded data, so the schedule builder never feeds `findConflicts()` a stub.
 *
 * Loads, for the whole active roster (not just assigned employees — the
 * eligible-employees picker in ShiftModal needs to score EVERYONE):
 *   - the week's shifts (draft + published, cancelled excluded)
 *   - shiftRoles, for `canCoverRoleIds` coverage
 *   - each employee's effective availability for the week (temporary overrides
 *     recurring, via `effectiveAvailabilityFor`)
 *   - time off overlapping the week (approved blocks, per §6)
 *   - hourly compensation for every ASSIGNED employee, for the labor footer
 *
 * `conflictsFor(shift, employeeId)` is the one function everything else calls:
 * the grid uses it to flag already-assigned cards, the modal uses it to score
 * every eligible-employees row.
 */

export type ConflictsFor = (shift: ShiftLike, employeeId: string) => Conflict[]

export interface ScheduleData {
  weekId: string
  setWeekId: (weekId: string) => void
  weekDates: string[]

  loading: boolean
  loadError: boolean
  reload: () => Promise<void>

  schedule: Schedule | null
  employees: Employee[]
  employeesById: Map<string, Employee>
  roles: ShiftRole[]
  rolesById: Map<string, ShiftRole>
  canCoverRoleIds: Record<string, string[]>
  shifts: Shift[]
  compensationByEmployee: Map<string, EmployeeCompensation | null>
  /** schedule.laborTargetPct, falling back to settings/app (spec §6). */
  laborTargetPct: number
  /** Manual sales projection, keyed by "YYYY-MM-DD" — see the load-time note. */
  projectedSalesByDate: Record<string, number>
  projectedSalesTotal: number | null

  /** Weekday key ('mon'..'sun') for a "YYYY-MM-DD" date inside this week. */
  weekdayKeyFor: (isoDate: string) => WeekdayKey | undefined
  /** Every conflict for assigning `employeeId` to `shift`, live, most severe first. */
  conflictsFor: (shift: ShiftLike, employeeId: string) => Conflict[]
  /** An employee's other shifts this week, for double-booking/overtime math. */
  otherShiftsFor: (employeeId: string, excludeShiftId?: string) => Shift[]

  createShift: (input: NewShiftInput) => Promise<Shift>
  updateShift: (
    shiftId: string,
    patch: Partial<Omit<Shift, 'id' | 'weekId' | 'createdAt' | 'updatedAt'>>,
  ) => Promise<void>
  deleteShift: (shiftId: string) => Promise<void>
  publish: (actor: Actor) => Promise<PublishResult>
  republish: (actor: Actor) => Promise<PublishResult>
}

function toShiftLike(shift: Shift): ShiftLike {
  return {
    id: shift.id,
    date: shift.date,
    startTime: shift.startTime,
    endTime: shift.endTime,
    roleId: shift.roleId,
    requiredSkillLevel: shift.requiredSkillLevel,
    employeeId: shift.employeeId,
  }
}

export function useScheduleData(initialWeekId: string): ScheduleData {
  const [weekId, setWeekId] = useState(initialWeekId)
  const weekDates = useMemo(() => datesForWeekId(weekId), [weekId])
  const dateToWeekday = useMemo(() => {
    const map = new Map<string, WeekdayKey>()
    weekDates.forEach((date, index) => {
      const key = WEEKDAY_KEYS[index]
      if (key) map.set(date, key)
    })
    return map
  }, [weekDates])

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [schedule, setSchedule] = useState<Schedule | null>(null)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [roles, setRoles] = useState<ShiftRole[]>([])
  const [shifts, setShifts] = useState<Shift[]>([])
  const [timeOff, setTimeOff] = useState<TimeOffRequest[]>([])
  const [availability, setAvailability] = useState<
    Map<string, Awaited<ReturnType<typeof effectiveAvailabilityFor>>>
  >(new Map())
  const [compensation, setCompensation] = useState<Map<string, EmployeeCompensation | null>>(
    new Map(),
  )
  const [laborTargetPct, setLaborTargetPct] = useState(0)
  const [projectedSalesByDate, setProjectedSalesByDate] = useState<Record<string, number>>({})
  const [projectedSalesTotal, setProjectedSalesTotal] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const dates = datesForWeekId(weekId)
      const [scheduleDoc, appSettings, roster, roleCatalog, weekShifts, weekTimeOff] =
        await Promise.all([
          getSchedule(weekId),
          getAppSettings(),
          listEmployees(),
          listShiftRoles(),
          listShifts(weekId),
          listTimeOff({ from: dates[0], to: dates[6] }),
        ])

      // schedules.ts's typed getSchedule() intentionally does not model
      // `projectedSales`/`projectedSalesTotal` yet (see scripts/seed.ts's
      // comment above seedSchedule(): "the labor footer that consumes it is a
      // Phase 2 view"). This IS that view. Rather than widen the shared
      // `Schedule` type (off-limits — src/lib/db/** is read-only for this
      // task) this reads the same already-permitted schedule document a
      // second time for the two extra fields the seed writes onto it. No new
      // collection, no new security surface — the firestore.rules read gate
      // is identical to the one getSchedule() already passed through.
      let salesByWeekday: Partial<Record<WeekdayKey, number>> = {}
      let salesTotal: number | null = null
      try {
        const raw = await getDoc(doc(db, COLLECTIONS.schedules, weekId))
        if (raw.exists()) {
          const data = raw.data()
          if (data.projectedSales && typeof data.projectedSales === 'object') {
            salesByWeekday = data.projectedSales as Partial<Record<WeekdayKey, number>>
          }
          if (typeof data.projectedSalesTotal === 'number') {
            salesTotal = data.projectedSalesTotal
          }
        }
      } catch {
        // Denied or missing — the footer degrades to hours/cost with no %.
      }
      const salesByDate: Record<string, number> = {}
      dates.forEach((date, index) => {
        const key = WEEKDAY_KEYS[index]
        const value = key ? salesByWeekday[key] : undefined
        if (typeof value === 'number') salesByDate[date] = value
      })

      const activeRoster = roster.filter((e) => e.status === 'active')

      const availabilityEntries = await Promise.all(
        activeRoster.map(async (e) => [e.id, await effectiveAvailabilityFor(e.id, weekId)] as const),
      )

      const assignedIds = [
        ...new Set(weekShifts.map((s) => s.employeeId).filter((id): id is string => id !== null)),
      ]
      const compensationEntries = await Promise.all(
        assignedIds.map(async (id) => [id, await getEmployeeCompensation(id)] as const),
      )

      setSchedule(scheduleDoc)
      setEmployees(roster)
      setRoles(roleCatalog)
      setShifts(weekShifts)
      setTimeOff(weekTimeOff)
      setAvailability(new Map(availabilityEntries))
      setCompensation(new Map(compensationEntries))
      setLaborTargetPct(scheduleDoc?.laborTargetPct ?? appSettings?.laborTargetPct ?? 0)
      setProjectedSalesByDate(salesByDate)
      setProjectedSalesTotal(salesTotal)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [weekId])

  useEffect(() => {
    void load()
  }, [load])

  const employeesById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])
  const rolesById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles])
  const canCoverRoleIds = useMemo(() => {
    const out: Record<string, string[]> = {}
    for (const role of roles) out[role.id] = role.canCoverRoleIds
    return out
  }, [roles])

  const timeOffByEmployee = useMemo(() => {
    const map = new Map<string, TimeOffRequest[]>()
    for (const request of timeOff) {
      const list = map.get(request.employeeId) ?? []
      list.push(request)
      map.set(request.employeeId, list)
    }
    return map
  }, [timeOff])

  const weekdayKeyFor = useCallback(
    (isoDate: string) => dateToWeekday.get(isoDate),
    [dateToWeekday],
  )

  const otherShiftsFor = useCallback(
    (employeeId: string, excludeShiftId?: string) =>
      shifts.filter((s) => s.employeeId === employeeId && s.id !== excludeShiftId),
    [shifts],
  )

  const conflictsFor = useCallback(
    (shift: ShiftLike, employeeId: string): Conflict[] => {
      const employee = employeesById.get(employeeId)
      if (!employee) return []

      const dayKey = weekdayKeyFor(shift.date)
      const effective = availability.get(employeeId)
      const availabilityDay = dayKey ? effective?.days[dayKey] : undefined

      const context: ConflictContext = {
        employee: {
          id: employee.id,
          status: employee.status,
          shiftRoles: employee.shiftRoles.map((r) => ({
            roleId: r.roleId,
            skillLevel: r.skillLevel,
          })),
        },
        availability: availabilityDay,
        timeOff: (timeOffByEmployee.get(employeeId) ?? []).map((t) => ({
          startDate: t.startDate,
          endDate: t.endDate,
          status: t.status,
        })),
        otherShifts: otherShiftsFor(employeeId, shift.id).map(toShiftLike),
        canCoverRoleIds,
        overtimeThreshold: 40,
      }

      return findConflicts(shift, context)
    },
    [employeesById, availability, timeOffByEmployee, otherShiftsFor, canCoverRoleIds, weekdayKeyFor],
  )

  const createShift = useCallback(
    async (input: NewShiftInput) => {
      const created = await dbCreateShift(weekId, input)
      await load()
      return created
    },
    [weekId, load],
  )

  const updateShift = useCallback(
    async (shiftId: string, patch: Partial<Omit<Shift, 'id' | 'weekId' | 'createdAt' | 'updatedAt'>>) => {
      await dbUpdateShift(weekId, shiftId, patch)
      await load()
    },
    [weekId, load],
  )

  const deleteShift = useCallback(
    async (shiftId: string) => {
      await dbDeleteShift(weekId, shiftId)
      await load()
    },
    [weekId, load],
  )

  const publish = useCallback(
    async (actor: Actor) => {
      const result = await dbPublishSchedule(weekId, actor)
      await load()
      return result
    },
    [weekId, load],
  )

  const republish = useCallback(
    async (actor: Actor) => {
      const result = await dbRepublishSchedule(weekId, actor)
      await load()
      return result
    },
    [weekId, load],
  )

  return {
    weekId,
    setWeekId,
    weekDates,
    loading,
    loadError,
    reload: load,
    schedule,
    employees,
    employeesById,
    roles,
    rolesById,
    canCoverRoleIds,
    shifts,
    compensationByEmployee: compensation,
    laborTargetPct,
    projectedSalesByDate,
    projectedSalesTotal,
    weekdayKeyFor,
    conflictsFor,
    otherShiftsFor,
    createShift,
    updateShift,
    deleteShift,
    publish,
    republish,
  }
}
