import { useTranslation } from 'react-i18next'

import { Avatar } from '@/components/ui'
import { formatHours } from '@/lib/format'
import { shiftHours } from '@/lib/scheduling/conflicts'
import type { ConflictsFor } from '../useScheduleData'
import type { Employee, Shift, ShiftRole } from '@/types/models'
import { hexToRgba, ShiftCard } from './ShiftCard'

/**
 * One full-width role band — mockup 11's grouping. A colored header (role
 * name + this band's total assigned hours), one row per employee who has at
 * least one shift under this role this week, a dashed "Open shifts" row for
 * unassigned shifts, and an "Add employee" affordance.
 *
 * Role colors are runtime Firestore values, applied as inline styles — never a
 * Tailwind class (tailwind.config.js's role.* palette is seed-default only).
 */

/** Shared with the sticky day header above the bands (ScheduleBuilderPage). */
export const GRID_COLS = '220px repeat(7, minmax(0, 1fr))'

export function RoleBandRow({
  role,
  weekDates,
  shifts,
  employeesById,
  conflictsFor,
  canCreate,
  onCreateShift,
  onEditShift,
  onAddEmployee,
}: {
  role: ShiftRole
  weekDates: string[]
  /** Every shift this week whose roleId matches this band. */
  shifts: Shift[]
  employeesById: Map<string, Employee>
  conflictsFor: ConflictsFor
  /** Governs both empty-cell click-to-create and the "Add employee" row —
   *  spec §6 gates shift CREATION on `schedule.create`. */
  canCreate: boolean
  onCreateShift: (opts: { date: string; employeeId: string | null }) => void
  onEditShift: (shift: Shift) => void
  onAddEmployee: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language

  const roleName = lang.startsWith('es') && role.nameEs ? role.nameEs : role.name

  const assignedIds = [
    ...new Set(shifts.filter((s) => s.employeeId !== null).map((s) => s.employeeId as string)),
  ].sort((a, b) => {
    const ea = employeesById.get(a)
    const eb = employeesById.get(b)
    return (ea?.lastName ?? '').localeCompare(eb?.lastName ?? '')
  })

  const openShifts = shifts.filter((s) => s.employeeId === null)

  const bandHours = shifts
    .filter((s) => s.employeeId !== null)
    .reduce((sum, s) => sum + shiftHours(s), 0)

  function shiftsFor(employeeId: string | null, date: string): Shift[] {
    return shifts.filter((s) => s.employeeId === employeeId && s.date === date)
  }

  function Cell({
    date,
    employeeId,
    cellShifts,
  }: {
    date: string
    employeeId: string | null
    cellShifts: Shift[]
  }) {
    if (cellShifts.length === 0) {
      return (
        <div
          role={canCreate ? 'button' : undefined}
          tabIndex={canCreate ? 0 : undefined}
          onClick={canCreate ? () => onCreateShift({ date, employeeId }) : undefined}
          onKeyDown={
            canCreate
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onCreateShift({ date, employeeId })
                  }
                }
              : undefined
          }
          className={canCreate ? 'h-[52px] w-full cursor-pointer rounded-md' : 'h-[52px] w-full'}
        />
      )
    }
    return (
      <div className="flex w-full flex-col gap-1">
        {cellShifts.map((shift) => (
          <ShiftCard
            key={shift.id}
            shift={shift}
            role={role}
            conflicts={shift.employeeId ? conflictsFor(shift, shift.employeeId) : []}
            onClick={() => onEditShift(shift)}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      <div
        className="flex h-8 w-full items-center justify-between border-b border-line px-4"
        style={{ backgroundColor: hexToRgba(role.color, 0.1) }}
      >
        <span
          className="text-micro font-bold uppercase tracking-widest"
          style={{ color: role.color }}
        >
          {roleName}
        </span>
        <span className="tabular text-micro font-medium text-ink-muted">
          {t('scheduleBuilder.band.total', { hours: formatHours(bandHours, lang) })}
        </span>
      </div>

      {assignedIds.map((employeeId) => {
        const employee = employeesById.get(employeeId)
        const rowHours = shifts
          .filter((s) => s.employeeId === employeeId)
          .reduce((sum, s) => sum + shiftHours(s), 0)
        return (
          <div
            key={employeeId}
            className="grid border-b border-line"
            style={{ gridTemplateColumns: GRID_COLS }}
          >
            <div className="flex items-center gap-3 border-r border-line p-3">
              <Avatar
                firstName={employee?.firstName ?? '?'}
                lastName={employee?.lastName ?? ''}
                photoUrl={employee?.photoUrl}
                size={28}
              />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-meta font-medium text-ink">
                  {employee ? `${employee.firstName} ${employee.lastName}` : employeeId}
                </span>
                <span className="tabular text-chip text-ink-muted">
                  {t('scheduleBuilder.band.rowHours', { hours: formatHours(rowHours, lang) })}
                </span>
              </div>
            </div>
            {weekDates.map((date, index) => (
              <div
                key={date}
                className={
                  index < weekDates.length - 1
                    ? 'flex items-center justify-center border-r border-line p-1'
                    : 'flex items-center justify-center p-1'
                }
              >
                <Cell date={date} employeeId={employeeId} cellShifts={shiftsFor(employeeId, date)} />
              </div>
            ))}
          </div>
        )
      })}

      <div className="grid border-b border-line border-dashed" style={{ gridTemplateColumns: GRID_COLS }}>
        <div className="flex items-center border-r border-line p-3">
          <span className="text-chip font-semibold italic text-ink-muted">
            {t('scheduleBuilder.band.openShifts')}
          </span>
        </div>
        {weekDates.map((date, index) => (
          <div
            key={date}
            className={
              index < weekDates.length - 1
                ? 'flex items-center justify-center border-r border-line p-1'
                : 'flex items-center justify-center p-1'
            }
          >
            <Cell date={date} employeeId={null} cellShifts={openShifts.filter((s) => s.date === date)} />
          </div>
        ))}
      </div>

      {canCreate ? (
        <div className="flex h-10 items-center border-b border-line border-dashed px-4">
          <button
            type="button"
            onClick={onAddEmployee}
            className="flex items-center gap-1.5 text-chip font-medium text-ink-muted transition-colors duration-hover hover:text-ink"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-3.5 w-3.5"
              aria-hidden="true"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            {t('scheduleBuilder.band.addEmployee')}
          </button>
        </div>
      ) : null}
    </div>
  )
}
