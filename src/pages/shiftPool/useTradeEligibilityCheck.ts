import { useEffect, useState } from 'react'

import { getEmployee, getShift, listShifts, listTimeOff } from '@/lib/db'
import { datesForWeekId } from '@/lib/deadlines'
import {
  checkTradeEligibility,
  shiftHours,
  type ConflictContext,
  type ShiftLike,
  type TradeEligibilityResult,
} from '@/lib/scheduling/tradeEligibility'
import type { Employee, Shift, Trade } from '@/types/models'

/**
 * Live eligibility preview for a trade's would-be assignee — mockup 17's
 * checklist, computed the same way ShiftModal recomputes eligibility for the
 * schedule builder (spec §7: never trust the trade's own stale
 * `eligibilitySnapshot`). Re-reads the REAL current shift and the candidate's
 * REAL current timeOff/otherShifts every time the modal opens, then runs them
 * through the one shared `checkTradeEligibility()` the Cloud Function itself
 * uses — so a manager sees exactly the verdict the server will reach.
 */
export interface TradeEligibilityCheck {
  loading: boolean
  loadError: boolean
  shift: Shift | null
  assigneeId: string | null
  assignee: Employee | null
  result: TradeEligibilityResult | null
  /** Assignee's projected hours this week INCLUDING this shift, for display only — spec §7 does not gate on overtime. */
  projectedHours: number | null
}

export function useTradeEligibilityCheck(
  trade: Trade | null,
  canCoverRoleIds: Record<string, string[]>,
): TradeEligibilityCheck {
  const [state, setState] = useState<TradeEligibilityCheck>({
    loading: Boolean(trade),
    loadError: false,
    shift: null,
    assigneeId: null,
    assignee: null,
    result: null,
    projectedHours: null,
  })

  useEffect(() => {
    if (!trade) {
      setState({ loading: false, loadError: false, shift: null, assigneeId: null, assignee: null, result: null, projectedHours: null })
      return
    }

    let cancelled = false
    setState((s) => ({ ...s, loading: true, loadError: false }))

    void (async () => {
      try {
        const assigneeId = trade.type === 'direct' ? trade.toEmployeeId : trade.claimedBy
        const shift = await getShift(trade.weekId, trade.shiftId)

        if (!shift || !assigneeId) {
          if (!cancelled) {
            setState({ loading: false, loadError: false, shift, assigneeId, assignee: null, result: null, projectedHours: null })
          }
          return
        }

        const dates = datesForWeekId(trade.weekId)
        const [assignee, timeOff, weekShifts] = await Promise.all([
          getEmployee(assigneeId),
          listTimeOff({ employeeId: assigneeId, from: dates[0], to: dates[6] }),
          listShifts(trade.weekId, { employeeId: assigneeId }),
        ])

        if (cancelled) return

        if (!assignee) {
          setState({ loading: false, loadError: false, shift, assigneeId, assignee: null, result: null, projectedHours: null })
          return
        }

        const shiftLike: ShiftLike = {
          id: shift.id,
          date: shift.date,
          startTime: shift.startTime,
          endTime: shift.endTime,
          roleId: shift.roleId,
          requiredSkillLevel: shift.requiredSkillLevel,
          employeeId: shift.employeeId,
          department: shift.department,
        }

        const otherShifts: ShiftLike[] = weekShifts
          .filter((s) => s.id !== shift.id)
          .map((s) => ({
            id: s.id,
            date: s.date,
            startTime: s.startTime,
            endTime: s.endTime,
            roleId: s.roleId,
            requiredSkillLevel: s.requiredSkillLevel,
            employeeId: s.employeeId,
            department: s.department,
          }))

        const context: ConflictContext = {
          employee: {
            id: assignee.id,
            status: assignee.status,
            shiftRoles: assignee.shiftRoles.map((r) => ({ roleId: r.roleId, skillLevel: r.skillLevel })),
            department: assignee.department,
          },
          timeOff: timeOff.map((t) => ({ startDate: t.startDate, endDate: t.endDate, status: t.status })),
          otherShifts,
          canCoverRoleIds,
        }

        const result = checkTradeEligibility(shiftLike, context)
        const projectedHours = otherShifts.reduce((sum, s) => sum + shiftHours(s), shiftHours(shiftLike))

        setState({ loading: false, loadError: false, shift, assigneeId, assignee, result, projectedHours })
      } catch {
        if (!cancelled) {
          setState({ loading: false, loadError: true, shift: null, assigneeId: null, assignee: null, result: null, projectedHours: null })
        }
      }
    })()

    return () => {
      cancelled = true
    }
    // Re-run only when the trade being reviewed actually changes (by id) —
    // not on every reference-identity change from a parent list reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade?.id, canCoverRoleIds])

  return state
}
