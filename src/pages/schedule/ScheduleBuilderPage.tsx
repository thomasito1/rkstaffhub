import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Button, EmptyState, FilterSelect } from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import { useAuth } from '@/lib/auth/AuthProvider'
import { addDaysToIsoDate } from '@/lib/deadlines'
import { formatDate, weekIdFor } from '@/lib/format'
import type { Department, Shift } from '@/types/models'

import { LaborFooter } from './components/LaborFooter'
import { PublishModal } from './components/PublishModal'
import { RoleBandRow } from './components/RoleBandRow'
import { ScheduleHeaderRow } from './components/ScheduleHeaderRow'
import { ShiftModal } from './components/ShiftModal'
import { WarningsPanel, type WarningGroup } from './components/WarningsPanel'
import { useScheduleData } from './useScheduleData'

/**
 * Schedule Builder — mockup 11's grid layout, wired to the real §6 conflicts
 * engine and the real seeded data (see PROGRESS.md: mockup 11's own numbers
 * are superseded by the seed, its LAYOUT is what survives here).
 */

const ALL = 'all'
const DEPARTMENTS: readonly Department[] = ['FOH', 'BOH', 'Admin'] as const

function dateFromIso(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`)
}

interface ModalTarget {
  shift: Shift | null
  date?: string
  roleId?: string
  employeeId?: string | null
}

export function ScheduleBuilderPage(): JSX.Element {
  return (
    <RequirePermission permission="schedule.view">
      <ScheduleBuilderScreen />
    </RequirePermission>
  )
}

function ScheduleBuilderScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const { can } = useAuth()

  const [now] = useState(() => new Date())
  const thisWeekId = useMemo(() => weekIdFor(now), [now])
  const data = useScheduleData(thisWeekId)

  const [department, setDepartment] = useState<string>(ALL)
  const [modal, setModal] = useState<ModalTarget | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)

  const canCreate = can('schedule.create')
  const canEditExisting = can('schedule.edit')
  const canPublish = can('schedule.publish')

  const weekRangeLabel = useMemo(() => {
    const first = data.weekDates[0]
    const last = data.weekDates[6]
    if (first === undefined || last === undefined) return data.weekId
    return `${formatDate(dateFromIso(first), { month: 'short', day: 'numeric' }, lang)} – ${formatDate(
      dateFromIso(last),
      { month: 'short', day: 'numeric', year: 'numeric' },
      lang,
    )}`
  }, [data.weekDates, data.weekId, lang])

  const visibleRoles = useMemo(
    () =>
      data.roles.filter(
        (r) =>
          (department === ALL || r.department === department) &&
          (r.active || data.shifts.some((s) => s.roleId === r.id)),
      ),
    [data.roles, department, data.shifts],
  )

  // Grouped by (person, conflict TYPE), not by shift. Per-shift corner flags
  // on ShiftCard are unchanged — this is only the header badge's count, which
  // used to increment once per AFFECTED SHIFT. That made one ongoing
  // condition (a person projected over 40 hrs all week) count once for every
  // shift they work, rather than once. See PROGRESS.md / DESIGN-HANDOFF.md.
  const warningGroups = useMemo<WarningGroup[]>(() => {
    const groups = new Map<string, WarningGroup>()
    for (const shift of data.shifts) {
      if (!shift.employeeId) continue
      const employeeId = shift.employeeId
      const conflicts = data.conflictsFor(shift, employeeId)
      for (const c of conflicts) {
        if (c.severity !== 'warn') continue
        const key = `${employeeId}::${c.code}`
        const existing = groups.get(key)
        if (existing) {
          existing.shifts.push(shift)
        } else {
          groups.set(key, {
            key,
            employeeId,
            code: c.code,
            messageKey: c.messageKey,
            params: c.params,
            shifts: [shift],
          })
        }
      }
    }
    return Array.from(groups.values())
  }, [data])

  const warningCount = warningGroups.length
  const [warningsOpen, setWarningsOpen] = useState(false)

  // §17: an audit entry that failed to write (after two attempts — see
  // functions/src/audit.ts) is flagged on the record it was ABOUT, not
  // invisibly dropped. This is a compliance gap, not a scheduling conflict,
  // so it gets its own banner rather than folding into warningGroups.
  const auditPendingCount =
    (data.schedule?.auditPending ? 1 : 0) + data.shifts.filter((s) => s.auditPending).length

  const modalCanEdit = modal?.shift ? canEditExisting : canCreate

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-line px-8 py-5">
        <div className="flex items-center gap-6">
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">
            {t('scheduleBuilder.title')}
          </h1>
          <FilterSelect
            label={t('filters.department')}
            value={department}
            onChange={setDepartment}
            options={[
              { value: ALL, label: t('filters.allDepartments') },
              ...DEPARTMENTS.map((d) => ({ value: d, label: t(`departments.${d}`) })),
            ]}
          />
        </div>

        <div className="flex items-center gap-3">
          <Link
            to="/schedule/whos-working"
            className="rounded-control border border-line px-4 py-2 text-meta font-medium text-ink-muted transition-colors hover:text-ink"
          >
            {t('whosWorking.title')}
          </Link>
          {warningCount > 0 ? (
            <button
              type="button"
              onClick={() => setWarningsOpen(true)}
              className="flex items-center gap-2 rounded-control border border-warning bg-warning-tint px-4 py-2 text-meta font-semibold text-warning transition-colors hover:bg-warning hover:text-white"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="h-4 w-4" aria-hidden="true">
                <path d="M10.3 3.4 2.6 17a1.5 1.5 0 0 0 1.3 2.2h16.2a1.5 1.5 0 0 0 1.3-2.2L13.7 3.4a1.5 1.5 0 0 0-3.4 0Z" />
                <path d="M12 9v4M12 16.3h.01" />
              </svg>
              {t('scheduleBuilder.warningCount', { count: warningCount })}
            </button>
          ) : null}
          {canPublish ? (
            <Button variant="primary" onClick={() => setPublishOpen(true)}>
              {t('scheduleBuilder.publishButton')}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between border-b border-line bg-app px-8 py-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t('availability.previousWeek')}
            onClick={() => data.setWeekId(addDaysToIsoDate(data.weekId, -7))}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-page text-ink-muted transition-colors duration-hover hover:text-ink"
          >
            <Chevron dir="left" />
          </button>
          <span className="tabular px-2 text-meta font-semibold text-ink">{weekRangeLabel}</span>
          <button
            type="button"
            aria-label={t('availability.nextWeek')}
            onClick={() => data.setWeekId(addDaysToIsoDate(data.weekId, 7))}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-page text-ink-muted transition-colors duration-hover hover:text-ink"
          >
            <Chevron dir="right" />
          </button>
          <button
            type="button"
            onClick={() => data.setWeekId(thisWeekId)}
            className="px-3 py-1.5 text-meta font-medium text-ink-muted transition-colors duration-hover hover:text-ink"
          >
            {t('availability.thisWeek')}
          </button>
        </div>
      </div>

      {auditPendingCount > 0 && canPublish ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-danger-tint px-8 py-2">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="h-4 w-4 shrink-0 text-danger" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4M12 15.8h.01" />
          </svg>
          <p className="text-chip font-medium text-danger">
            {t('scheduleBuilder.auditPending.banner', { count: auditPendingCount })}
          </p>
        </div>
      ) : null}

      {data.loading ? (
        <div className="flex-1 overflow-auto p-6">
          <p className="sr-only" role="status">
            {t('app.loading')}
          </p>
          <div className="flex flex-col gap-1 rounded-card border border-line bg-page p-1">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-[52px] animate-skeleton rounded-lg bg-app" />
            ))}
          </div>
        </div>
      ) : data.loadError ? (
        <div className="flex-1 overflow-auto p-6">
          <EmptyState
            illustration="search"
            title={t('scheduleBuilder.errorTitle')}
            body={t('scheduleBuilder.errorBody')}
            action={<Button onClick={() => void data.reload()}>{t('common.retry')}</Button>}
          />
        </div>
      ) : visibleRoles.length === 0 ? (
        <div className="flex-1 overflow-auto p-6">
          <EmptyState
            illustration="calendar"
            title={t('scheduleBuilder.emptyTitle')}
            body={t('scheduleBuilder.emptyBody')}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <ScheduleHeaderRow
            weekDates={data.weekDates}
            weekdayKeyFor={data.weekdayKeyFor}
            projectedSalesByDate={data.projectedSalesByDate}
          />
          {visibleRoles.map((role) => (
            <RoleBandRow
              key={role.id}
              role={role}
              weekDates={data.weekDates}
              shifts={data.shifts.filter((s) => s.roleId === role.id)}
              employeesById={data.employeesById}
              conflictsFor={data.conflictsFor}
              canCreate={canCreate}
              onCreateShift={({ date, employeeId }) =>
                setModal({ shift: null, date, roleId: role.id, employeeId })
              }
              onEditShift={(shift) => setModal({ shift })}
              onAddEmployee={() => setModal({ shift: null, roleId: role.id })}
            />
          ))}
        </div>
      )}

      {!data.loading && !data.loadError ? (
        <LaborFooter
          weekDates={data.weekDates}
          shifts={data.shifts}
          employeesById={data.employeesById}
          compensationByEmployee={data.compensationByEmployee}
          laborTargetPct={data.laborTargetPct}
          projectedSalesByDate={data.projectedSalesByDate}
          projectedSalesTotal={data.projectedSalesTotal}
        />
      ) : null}

      {modal ? (
        <ShiftModal
          open
          onClose={() => setModal(null)}
          data={data}
          shift={modal.shift}
          defaultDate={modal.date}
          defaultRoleId={modal.roleId}
          defaultEmployeeId={modal.employeeId}
          canEdit={modalCanEdit}
        />
      ) : null}

      <PublishModal
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        data={data}
        weekRangeLabel={weekRangeLabel}
      />

      <WarningsPanel
        open={warningsOpen}
        onClose={() => setWarningsOpen(false)}
        groups={warningGroups}
        employeesById={data.employeesById}
        lang={lang}
      />
    </div>
  )
}

function Chevron({ dir }: { dir: 'left' | 'right' }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d={dir === 'left' ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'} />
    </svg>
  )
}

export default ScheduleBuilderPage
