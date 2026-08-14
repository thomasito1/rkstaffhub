import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { EmptyState, Modal, Pill } from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import { useAuth } from '@/lib/auth/AuthProvider'
import { addDaysToIsoDate } from '@/lib/deadlines'
import { listEmployees, listPublishedShiftsForDepartment } from '@/lib/db'
import { formatDate, formatHours, weekIdFor } from '@/lib/format'
import { shiftHours } from '@/lib/scheduling/conflicts'
import type { Employee, Shift } from '@/types/models'

/**
 * Staff "My schedule" — mockup 14 (mobile) + 14b's detail sheet, rendered as
 * a Modal (no bottom-sheet primitive exists in the UI kit yet).
 *
 * WHY THIS EXISTS SEPARATELY FROM THE BUILDER: /schedule previously always
 * rendered the admin ScheduleBuilderScreen, for every role. A plain staff
 * viewer holds only `schedule.view` (self-service default), not
 * `schedule.create`/`schedule.edit`, so useScheduleData's admin-scoped reads
 * were denied by firestore.rules and the screen silently rendered empty —
 * not a security leak, just a broken screen. ScheduleEntryPage now decides
 * which of the two this route renders, per spec §6's own split: "Staff
 * view: 'My Shifts' list + week calendar" vs. the admin grid.
 *
 * DROPPED FROM MOCKUP 14B'S DETAIL SHEET: "Manager on duty" (would need a
 * cross-department shift read a BOH staff member's rules deny for an FOH
 * MOD), "Clock in opens" (Phase 2 time clock), and "Added by" (shifts don't
 * carry a createdBy field). Kept: date, hours, role, station, and who else
 * is working — the parts real data actually supports.
 */

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function dateFromIso(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`)
}

function displayName(e: Employee): string {
  const first = e.preferredName?.trim() ? e.preferredName : e.firstName
  return `${first} ${e.lastName}`.trim()
}

export function MySchedulePage(): JSX.Element {
  return (
    <RequirePermission permission="schedule.view">
      <MyScheduleScreen />
    </RequirePermission>
  )
}

function MyScheduleScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const { employee } = useAuth()

  const [now] = useState(() => new Date())
  const [weekId, setWeekId] = useState(() => weekIdFor(now))
  const [shifts, setShifts] = useState<Shift[]>([])
  const [employeesById, setEmployeesById] = useState<Map<string, Employee>>(new Map())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [selected, setSelected] = useState<Shift | null>(null)

  const load = useCallback(async () => {
    if (!employee) return
    setLoading(true)
    setLoadError(false)
    try {
      const [deptShifts, people] = await Promise.all([
        listPublishedShiftsForDepartment(weekId, employee.department),
        listEmployees({ status: 'active' }),
      ])
      setShifts(deptShifts)
      setEmployeesById(new Map(people.map((p) => [p.id, p])))
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [weekId, employee])

  useEffect(() => {
    void load()
  }, [load])

  const weekDates = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDaysToIsoDate(weekId, i)),
    [weekId],
  )

  const myShiftsByDate = useMemo(() => {
    const m = new Map<string, Shift>()
    if (!employee) return m
    for (const s of shifts) {
      if (s.employeeId === employee.id) m.set(s.date, s)
    }
    return m
  }, [shifts, employee])

  const coworkersFor = useCallback(
    (shift: Shift): Employee[] => {
      return shifts
        .filter((s) => s.date === shift.date && s.employeeId && s.employeeId !== shift.employeeId)
        .map((s) => employeesById.get(s.employeeId as string))
        .filter((e): e is Employee => e !== undefined)
    },
    [shifts, employeesById],
  )

  const weekTotalHours = useMemo(
    () => [...myShiftsByDate.values()].reduce((sum, s) => sum + shiftHours(s), 0),
    [myShiftsByDate],
  )

  const weekRangeLabel = useMemo(() => {
    const first = weekDates[0]
    const last = weekDates[6]
    if (first === undefined || last === undefined) return weekId
    return `${formatDate(dateFromIso(first), { month: 'short', day: 'numeric' }, lang)} – ${formatDate(
      dateFromIso(last),
      { month: 'short', day: 'numeric', year: 'numeric' },
      lang,
    )}`
  }, [weekDates, weekId, lang])

  const todayIso = isoOf(now)

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-title font-semibold tracking-tight text-ink">
            {t('mySchedule.title')}
          </h1>
          <p className="mt-0.5 text-meta text-ink-muted">{weekRangeLabel}</p>
        </div>
        <Link
          to="/schedule/whos-working"
          className="shrink-0 rounded-control border border-line px-3 py-1.5 text-chip font-medium text-ink-muted transition-colors duration-hover hover:text-ink"
        >
          {t('whosWorking.title')}
        </Link>
      </div>

      <div className="flex items-center justify-between rounded-card border border-line bg-page p-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t('availability.previousWeek')}
            onClick={() => setWeekId((w) => addDaysToIsoDate(w, -7))}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-app hover:text-ink"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => setWeekId(weekIdFor(now))}
            className="rounded-control px-2 py-1 text-chip font-medium text-ink-muted hover:text-ink"
          >
            {t('availability.thisWeek')}
          </button>
          <button
            type="button"
            aria-label={t('availability.nextWeek')}
            onClick={() => setWeekId((w) => addDaysToIsoDate(w, 7))}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-muted hover:bg-app hover:text-ink"
          >
            ›
          </button>
        </div>
        <span className="tabular text-chip font-semibold text-ink">
          {t('mySchedule.weekSummary', { hours: formatHours(weekTotalHours, lang), count: myShiftsByDate.size })}
        </span>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 animate-skeleton rounded-card bg-app" />
          ))}
        </div>
      ) : loadError ? (
        <EmptyState
          illustration="search"
          title={t('mySchedule.errorTitle')}
          body={t('mySchedule.errorBody')}
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {weekDates.map((date) => {
            const shift = myShiftsByDate.get(date)
            const isToday = date === todayIso
            return (
              <li
                key={date}
                className="rounded-card border border-line bg-page p-4"
                role={shift ? 'button' : undefined}
                tabIndex={shift ? 0 : undefined}
                onClick={shift ? () => setSelected(shift) : undefined}
                onKeyDown={
                  shift
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') setSelected(shift)
                      }
                    : undefined
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-micro font-semibold uppercase tracking-wide text-ink-muted">
                    {formatDate(dateFromIso(date), { weekday: 'short', month: 'short', day: 'numeric' }, lang)}
                  </span>
                  {isToday ? <Pill tone="published">{t('mySchedule.today')}</Pill> : null}
                </div>
                {shift ? (
                  <>
                    <p className="tabular mt-1 text-body font-semibold text-ink">
                      {shift.startTime}–{shift.endTime}
                    </p>
                    <p className="mt-0.5 text-chip text-ink-muted">{shift.station ?? '—'}</p>
                    {coworkersFor(shift).length > 0 ? (
                      <p className="mt-1 text-chip text-ink-muted">
                        {t('mySchedule.withCoworkers', {
                          names: coworkersFor(shift).map(displayName).join(', '),
                        })}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="mt-1 text-chip italic text-ink-muted">{t('mySchedule.dayOff')}</p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <ShiftDetailModal
        shift={selected}
        coworkers={selected ? coworkersFor(selected) : []}
        onClose={() => setSelected(null)}
      />
    </div>
  )
}

function ShiftDetailModal({
  shift,
  coworkers,
  onClose,
}: {
  shift: Shift | null
  coworkers: Employee[]
  onClose: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language

  return (
    <Modal
      open={shift !== null}
      onClose={onClose}
      title={shift ? formatDate(dateFromIso(shift.date), { weekday: 'long', month: 'long', day: 'numeric' }, lang) : ''}
    >
      {shift ? (
        <div className="space-y-3">
          <p className="tabular text-title font-semibold text-ink">
            {shift.startTime}–{shift.endTime}
          </p>
          <p className="text-meta text-ink-muted">
            {t('mySchedule.detail.hours', { hours: formatHours(shiftHours(shift), lang) })}
          </p>
          {shift.station ? (
            <div>
              <p className="text-chip font-medium text-ink-muted">{t('mySchedule.detail.station')}</p>
              <p className="text-meta text-ink">{shift.station}</p>
            </div>
          ) : null}
          {coworkers.length > 0 ? (
            <div>
              <p className="text-chip font-medium text-ink-muted">{t('mySchedule.detail.workingWithYou')}</p>
              <ul className="mt-1 space-y-1">
                {coworkers.map((c) => (
                  <li key={c.id} className="text-meta text-ink">
                    {displayName(c)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  )
}

export default MySchedulePage
