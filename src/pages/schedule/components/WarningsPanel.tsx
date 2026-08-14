import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Avatar, Modal } from '@/components/ui'
import { formatDate } from '@/lib/format'
import type { Employee, Shift } from '@/types/models'
import type { ConflictCode } from '@/lib/scheduling/conflicts'

/**
 * One row = one (person, conflict TYPE) pair, not one shift.
 *
 * The header badge used to count per-shift, so a single ongoing condition
 * (Oli Fonseca projected over 40 hrs) showed once for EACH of his seven
 * shifts that week — a badge reading "8" when only two distinct situations
 * (Oli's overtime, Micah's availability) actually need a manager's attention.
 * `ScheduleBuilderPage` groups by `${employeeId}::${conflict.code}` before
 * this component ever sees the data; this component only renders the result.
 */
export interface WarningGroup {
  key: string
  employeeId: string
  code: ConflictCode
  messageKey: string
  params?: Record<string, string | number>
  shifts: Shift[]
}

export function WarningsPanel({
  open,
  onClose,
  groups,
  employeesById,
  lang,
}: {
  open: boolean
  onClose: () => void
  groups: WarningGroup[]
  employeesById: Map<string, Employee>
  lang: string
}): JSX.Element | null {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  if (!open) return null

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('scheduleBuilder.warnings.title')}
      subtitle={t('scheduleBuilder.warnings.subtitle', { count: groups.length })}
      width={560}
    >
      {groups.length === 0 ? (
        <p className="py-6 text-center text-meta text-ink-muted">
          {t('scheduleBuilder.warnings.empty')}
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {groups.map((group) => {
            const employee = employeesById.get(group.employeeId)
            const name = employee
              ? `${employee.preferredName?.trim() || employee.firstName} ${employee.lastName}`.trim()
              : group.employeeId
            const isOpen = expanded.has(group.key)

            return (
              <li key={group.key} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start gap-3">
                  {employee ? (
                    <Avatar
                      firstName={employee.firstName}
                      lastName={employee.lastName}
                      photoUrl={employee.photoUrl}
                      size={32}
                    />
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <p className="text-meta font-semibold text-ink">{name}</p>
                    <p className="mt-0.5 text-meta text-ink-muted">
                      {t(group.messageKey, group.params)}
                    </p>
                    <button
                      type="button"
                      onClick={() => toggle(group.key)}
                      aria-expanded={isOpen}
                      className="mt-2 text-chip font-semibold text-primary hover:underline"
                    >
                      {isOpen
                        ? t('scheduleBuilder.warnings.hideShifts')
                        : t('scheduleBuilder.warnings.showShifts', { count: group.shifts.length })}
                    </button>
                    {isOpen ? (
                      <ul className="mt-2 space-y-1.5 rounded-control border border-line bg-app p-3">
                        {group.shifts.map((shift) => (
                          <li key={shift.id} className="flex items-center justify-between gap-3 text-chip text-ink-muted">
                            <span className="tabular">
                              {formatDate(
                                new Date(`${shift.date}T12:00:00Z`),
                                { weekday: 'short', month: 'short', day: 'numeric' },
                                lang,
                              )}
                            </span>
                            <span className="tabular">
                              {shift.startTime}–{shift.endTime}
                            </span>
                            <span>{shift.station}</span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
