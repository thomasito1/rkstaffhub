import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  getShift,
  listEmployees,
  listMyTrades,
  listOpenTradesForDepartment,
  listShiftRoles,
  listTradesAwaitingApproval,
} from '@/lib/db'
import { weekIdFor } from '@/lib/format'
import type { Department, Employee, Shift, ShiftRole, Trade } from '@/types/models'

/** A trade doc carries only `weekId`/`shiftId` plus a denormalized role/skill
 *  snapshot — never the shift's actual date/time/station. Every list here
 *  needs those for display, so this key looks them up in one shared cache. */
export function shiftKeyFor(trade: Pick<Trade, 'weekId' | 'shiftId'>): string {
  return `${trade.weekId}/${trade.shiftId}`
}

/**
 * Assembles everything the Shift Pool screens (mockups 16/17, spec §7) need:
 * the roster + role catalog (for eligibility scoring and display), the open
 * pool board across both staffed departments, the manager-only approval
 * queues, and the viewer's own trades. One load, shared by every tab — the
 * same shape `useScheduleData.ts` uses for the schedule builder.
 *
 * Admin is deliberately excluded from the pool board's department sweep —
 * spec §4/§7: trades are an FOH/BOH concern, "BOH effectively has no trades"
 * — mirroring WhosWorkingPage's own `DEPARTMENTS` list.
 */
const POOL_DEPARTMENTS: readonly Department[] = ['FOH', 'BOH'] as const

export interface ShiftPoolData {
  weekId: string
  loading: boolean
  loadError: boolean
  reload: () => Promise<void>

  employees: Employee[]
  employeesById: Map<string, Employee>
  roles: ShiftRole[]
  rolesById: Map<string, ShiftRole>
  canCoverRoleIds: Record<string, string[]>

  /** Every open pool trade across FOH + BOH — "Up for grabs" (mockup 16). */
  openPoolTrades: Trade[]
  /** type='pool', status='claimed' — "Shift pool requests". */
  poolClaims: Trade[]
  /** type='direct', status='pending-approval' — "Trade requests". */
  directPending: Trade[]
  /** Every trade the viewer is a party to — "My trades". */
  myTrades: Trade[]
  /** The underlying shift for every trade above, keyed by `shiftKeyFor()`. */
  shiftsByKey: Map<string, Shift>
}

export function useShiftPoolData(employeeId: string | undefined, canSeeApprovals: boolean): ShiftPoolData {
  const [weekId] = useState(() => weekIdFor(new Date()))
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const [employees, setEmployees] = useState<Employee[]>([])
  const [roles, setRoles] = useState<ShiftRole[]>([])
  const [openPoolTrades, setOpenPoolTrades] = useState<Trade[]>([])
  const [poolClaims, setPoolClaims] = useState<Trade[]>([])
  const [directPending, setDirectPending] = useState<Trade[]>([])
  const [myTrades, setMyTrades] = useState<Trade[]>([])
  const [shiftsByKey, setShiftsByKey] = useState<Map<string, Shift>>(new Map())

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const [roster, roleCatalog, poolByDept, approvals, mine] = await Promise.all([
        listEmployees({ status: 'active' }),
        listShiftRoles(),
        Promise.all(POOL_DEPARTMENTS.map((d) => listOpenTradesForDepartment(d))),
        canSeeApprovals ? listTradesAwaitingApproval() : Promise.resolve({ poolClaims: [], directPending: [] }),
        employeeId ? listMyTrades(employeeId) : Promise.resolve([]),
      ])

      const openPool = poolByDept.flat()
      const allTrades = [...openPool, ...approvals.poolClaims, ...approvals.directPending, ...mine]
      const uniqueByKey = new Map(allTrades.map((tr) => [shiftKeyFor(tr), tr]))
      const shiftEntries = await Promise.all(
        [...uniqueByKey.entries()].map(async ([key, tr]) => [key, await getShift(tr.weekId, tr.shiftId)] as const),
      )

      setEmployees(roster)
      setRoles(roleCatalog)
      setOpenPoolTrades(openPool)
      setPoolClaims(approvals.poolClaims)
      setDirectPending(approvals.directPending)
      setMyTrades(mine)
      setShiftsByKey(
        new Map(shiftEntries.filter((e): e is [string, Shift] => e[1] !== null)),
      )
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [employeeId, canSeeApprovals])

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

  return {
    weekId,
    loading,
    loadError,
    reload: load,
    employees,
    employeesById,
    roles,
    rolesById,
    canCoverRoleIds,
    openPoolTrades,
    poolClaims,
    directPending,
    myTrades,
    shiftsByKey,
  }
}
