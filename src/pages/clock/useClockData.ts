import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  getOpenPunch,
  listEmployees,
  listPunchesForEmployeeOnDate,
  listPublishedShiftsForDepartment,
  listShiftRoles,
  subscribeAppSettings,
} from '@/lib/db'
import { addDaysToIsoDate } from '@/lib/deadlines'
import { weekIdFor } from '@/lib/format'
import { listQueuedPunches } from '@/lib/offlineQueue/punchQueue'
import type { AppSettings, Employee, Punch, Shift, ShiftRole } from '@/types/models'

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export interface RecentPunchRow {
  date: string
  inPunch: Punch
  outPunch: Punch
  hours: number
}

function punchMillis(p: Punch): number {
  const ts = p.timestamp
  return ts && typeof ts === 'object' && 'toMillis' in ts
    ? (ts as { toMillis(): number }).toMillis()
    : 0
}

/**
 * Loads everything the clock home screen (mockup 19) and the success screens
 * need: today's published shift + who else is on it, the shift-role catalog
 * (for the "Server · L2" chip), the live app settings (geofence — spec §8),
 * the currently-open punch, up to 3 recent closed shifts, and how many
 * punches are still waiting in the offline queue.
 */
export function useClockData(employee: Employee | null) {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [todaysShift, setTodaysShift] = useState<Shift | null>(null)
  const [coworkers, setCoworkers] = useState<Employee[]>([])
  const [rolesById, setRolesById] = useState<Map<string, ShiftRole>>(new Map())
  const [openPunch, setOpenPunch] = useState<Punch | null>(null)
  const [recentPunches, setRecentPunches] = useState<RecentPunchRow[]>([])
  const [queuedCount, setQueuedCount] = useState(0)
  const [loading, setLoading] = useState(true)

  // Live settings — an admin widening the geofence must take effect without a reload.
  useEffect(() => {
    return subscribeAppSettings(setSettings)
  }, [])

  const refreshOpenPunch = useCallback(async () => {
    if (!employee) return
    setOpenPunch(await getOpenPunch(employee.id))
  }, [employee])

  const refreshQueuedCount = useCallback(async () => {
    setQueuedCount((await listQueuedPunches()).length)
  }, [])

  const load = useCallback(async () => {
    if (!employee) return
    setLoading(true)
    try {
      const now = new Date()
      const weekId = weekIdFor(now)
      const today = isoOf(now)

      const [deptShifts, roles, people, open] = await Promise.all([
        listPublishedShiftsForDepartment(weekId, employee.department),
        listShiftRoles(),
        listEmployees({ status: 'active' }),
        getOpenPunch(employee.id),
      ])

      const mine = deptShifts.find((s) => s.date === today && s.employeeId === employee.id) ?? null
      setTodaysShift(mine)
      setRolesById(new Map(roles.map((r) => [r.id, r])))
      setOpenPunch(open)

      if (mine) {
        const peopleById = new Map(people.map((p) => [p.id, p]))
        const others = deptShifts
          .filter((s) => s.date === today && s.employeeId && s.employeeId !== employee.id)
          .map((s) => peopleById.get(s.employeeId as string))
          .filter((p): p is Employee => p !== undefined)
        setCoworkers(others)
      } else {
        setCoworkers([])
      }

      // "Recent punches" (mockup 19) has no dedicated history query — this
      // app's punches.ts deliberately keeps reads scoped to one employee on
      // one calendar date (spec §8/§9). Walk back a short window of recent
      // calendar dates and keep whichever came back as a complete in+out
      // pair, newest first, capped at 3 rows to match the mockup.
      const lookbackDates = Array.from({ length: 8 }, (_, i) => addDaysToIsoDate(today, -(i + 1)))
      const perDate = await Promise.all(
        lookbackDates.map((date) => listPunchesForEmployeeOnDate(employee.id, date)),
      )
      const rows: RecentPunchRow[] = []
      lookbackDates.forEach((date, i) => {
        const dayPunches = perDate[i] ?? []
        const inPunch = dayPunches.find((p) => p.type === 'in')
        const outPunch = dayPunches.find((p) => p.type === 'out')
        if (inPunch && outPunch) {
          const hours = (punchMillis(outPunch) - punchMillis(inPunch)) / 3_600_000
          rows.push({ date, inPunch, outPunch, hours })
        }
      })
      setRecentPunches(rows.slice(0, 3))

      setQueuedCount((await listQueuedPunches()).length)
    } finally {
      setLoading(false)
    }
  }, [employee])

  useEffect(() => {
    void load()
  }, [load])

  const coworkerNames = useMemo(() => coworkers, [coworkers])

  return {
    settings,
    todaysShift,
    coworkers: coworkerNames,
    rolesById,
    openPunch,
    recentPunches,
    queuedCount,
    loading,
    reload: load,
    refreshOpenPunch,
    refreshQueuedCount,
  }
}
