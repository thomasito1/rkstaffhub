import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Avatar, Button, EmptyState, Modal } from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import { listEmployees, listTimeOff } from '@/lib/db'
import { formatDate } from '@/lib/format'
import type { Employee, TimeOffRequest } from '@/types/models'

/**
 * Settings → Time off — mockup 36's Calendar tab.
 *
 * SIMPLER THAN THE MOCKUP ON PURPOSE. The mockup draws each request as a
 * rounded bar spanning its full date range across cells, with lane
 * assignment so overlapping bars don't collide — a real layout algorithm,
 * not a styling choice. Given the requests table (the other tab) is where
 * approve/decline actually happens, this view's job is just "who's off
 * when, at a glance" — a day-cell chip list gets there with far less code
 * and no risk of bars overlapping incorrectly. A day with more than a
 * handful of requests shows a "+N more" that opens the same day's list in a
 * modal rather than trying to cram more bars into 110px of cell height.
 */

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000)
}

/** Mon-first 6-week grid covering the month, including lead/trail days from neighbors. */
function monthGrid(year: number, month0: number): Date[] {
  const first = new Date(Date.UTC(year, month0, 1))
  const firstWeekday = (first.getUTCDay() + 6) % 7 // 0=Mon..6=Sun
  const gridStart = addDays(first, -firstWeekday)
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i))
}

function overlaps(request: TimeOffRequest, day: string): boolean {
  return request.startDate <= day && day <= request.endDate
}

function displayName(e: Employee): string {
  const first = e.preferredName?.trim() ? e.preferredName : e.firstName
  return `${first} ${e.lastName}`.trim()
}

export function TimeOffCalendarPage(): JSX.Element {
  return (
    <RequirePermission permission="timeoff.approve">
      <TimeOffCalendarScreen />
    </RequirePermission>
  )
}

const MAX_CHIPS_PER_DAY = 3

function TimeOffCalendarScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const navigate = useNavigate()

  const [now] = useState(() => new Date())
  const [year, setYear] = useState(now.getUTCFullYear())
  const [month0, setMonth0] = useState(now.getUTCMonth())

  const [employees, setEmployees] = useState<Employee[]>([])
  const [requests, setRequests] = useState<TimeOffRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [openDay, setOpenDay] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const [people, allRequests] = await Promise.all([
        listEmployees({ status: 'active' }),
        listTimeOff({ status: 'approved' }),
      ])
      setEmployees(people)
      setRequests(allRequests)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const employeesById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])
  const grid = useMemo(() => monthGrid(year, month0), [year, month0])
  const todayIso = useMemo(() => isoDate(now), [now])

  const requestsByDay = useMemo(() => {
    const m = new Map<string, TimeOffRequest[]>()
    for (const day of grid) {
      const iso = isoDate(day)
      m.set(iso, requests.filter((r) => overlaps(r, iso)))
    }
    return m
  }, [grid, requests])

  // Noon UTC, not midnight: formatDate always renders in RESTAURANT_TZ
  // (America/New_York, UTC-4/5), and midnight UTC on the 1st rolls back to
  // the last evening of the PREVIOUS month once converted — this is the
  // same reason every other date-from-string helper in this codebase
  // anchors at T12:00:00Z instead of midnight.
  const monthLabel = formatDate(new Date(Date.UTC(year, month0, 1, 12)), { month: 'long', year: 'numeric' }, lang)

  function changeMonth(delta: number): void {
    const next = new Date(Date.UTC(year, month0 + delta, 1))
    setYear(next.getUTCFullYear())
    setMonth0(next.getUTCMonth())
  }

  function goToday(): void {
    setYear(now.getUTCFullYear())
    setMonth0(now.getUTCMonth())
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">
            {t('timeOff.admin.title')}
          </h1>
          <p className="mt-0.5 text-meta text-ink-muted">{t('timeOff.admin.subtitle')}</p>
        </div>
        <Button onClick={() => navigate('/settings/time-off')}>{t('timeOff.admin.requestsTab')}</Button>
      </div>

      {loading ? (
        <div className="h-96 animate-skeleton rounded-card bg-app" />
      ) : loadError ? (
        <EmptyState
          illustration="search"
          title={t('timeOff.admin.errorTitle')}
          body={t('timeOff.admin.errorBody')}
          action={<Button onClick={() => void load()}>{t('common.retry')}</Button>}
        />
      ) : (
        <div className="rounded-card border border-line bg-page">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-label={t('availability.previousWeek')}
                onClick={() => changeMonth(-1)}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-page text-ink-muted hover:text-ink"
              >
                <Chevron dir="left" />
              </button>
              <span className="text-meta font-semibold text-ink">{monthLabel}</span>
              <button
                type="button"
                aria-label={t('availability.nextWeek')}
                onClick={() => changeMonth(1)}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-page text-ink-muted hover:text-ink"
              >
                <Chevron dir="right" />
              </button>
            </div>
            <button
              type="button"
              onClick={goToday}
              className="rounded-control border border-line px-3 py-1.5 text-chip font-medium text-ink-muted hover:text-ink"
            >
              {t('availability.thisWeek')}
            </button>
          </div>

          <div className="grid grid-cols-7 border-b border-line">
            {(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const).map((key) => (
              <div key={key} className="px-2 py-2 text-center text-micro font-semibold uppercase text-ink-muted">
                {t(`weekdays.short.${key}`)}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7">
            {grid.map((day) => {
              const iso = isoDate(day)
              const inMonth = day.getUTCMonth() === month0
              const dayRequests = requestsByDay.get(iso) ?? []
              const shown = dayRequests.slice(0, MAX_CHIPS_PER_DAY)
              const overflow = dayRequests.length - shown.length
              const isToday = iso === todayIso

              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => dayRequests.length > 0 && setOpenDay(iso)}
                  className={[
                    'flex min-h-[110px] flex-col items-stretch gap-1 border-b border-r border-line p-1.5 text-left',
                    inMonth ? '' : 'opacity-40',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'tabular self-start px-1.5 py-0.5 text-chip font-semibold',
                      isToday ? 'rounded-full bg-primary text-white' : 'text-ink',
                    ].join(' ')}
                  >
                    {day.getUTCDate()}
                  </span>
                  {shown.map((r) => {
                    const person = employeesById.get(r.employeeId)
                    return (
                      <span
                        key={r.id}
                        className="flex items-center gap-1 truncate rounded-full bg-success-tint px-1.5 py-0.5 text-micro font-medium text-success"
                      >
                        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                        <span className="truncate">{person ? person.firstName : r.employeeId}</span>
                      </span>
                    )
                  })}
                  {overflow > 0 ? (
                    <span className="text-micro font-medium text-ink-muted">
                      {t('timeOff.calendar.more', { count: overflow })}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-4 border-t border-line px-4 py-3 text-chip text-ink-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-success" aria-hidden="true" />
              {t('timeOff.calendar.legendApproved')}
            </span>
          </div>
        </div>
      )}

      <Modal
        open={openDay !== null}
        onClose={() => setOpenDay(null)}
        title={openDay ? formatDate(new Date(`${openDay}T12:00:00Z`), { weekday: 'long', month: 'long', day: 'numeric' }, lang) : ''}
      >
        <ul className="flex flex-col gap-2">
          {(openDay ? requestsByDay.get(openDay) ?? [] : []).map((r) => {
            const person = employeesById.get(r.employeeId)
            return (
              <li key={r.id} className="flex items-center gap-3">
                <Avatar
                  firstName={person?.firstName ?? '?'}
                  lastName={person?.lastName ?? ''}
                  photoUrl={person?.photoUrl}
                  size={28}
                />
                <span className="text-meta text-ink">{person ? displayName(person) : r.employeeId}</span>
              </li>
            )
          })}
        </ul>
      </Modal>
    </div>
  )
}

function Chevron({ dir }: { dir: 'left' | 'right' }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d={dir === 'left' ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'} />
    </svg>
  )
}

export default TimeOffCalendarPage
