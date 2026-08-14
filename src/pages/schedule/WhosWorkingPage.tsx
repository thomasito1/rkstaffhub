import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Avatar, EmptyState } from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import { useAuth } from '@/lib/auth/AuthProvider'
import { addDaysToIsoDate } from '@/lib/deadlines'
import {
  listEmployees,
  listPublishedShiftsForDepartment,
  listShiftRoles,
  listShifts,
} from '@/lib/db'
import { RESTAURANT_TZ, formatDate, weekIdFor } from '@/lib/format'
import { hexToRgba } from './components/ShiftCard'
import type { Department, Employee, Shift, ShiftRole } from '@/types/models'

/**
 * Who's Working — mockup 06's day gantt, WITHOUT the dashboard shell it sits
 * inside there. Mockup 06 draws this as a tab on the Home dashboard
 * ("Overview" / "Who's Working"), but Home is Phase 6 (spec §19) and
 * CLAUDE.md's rule against building later-phase scaffolding applies to a
 * dashboard tab the same as a top-level screen. Spec §6 itself scopes the
 * gantt to Phase 1 independently of that dashboard ("day view gantt
 * ('Who's Working') visible to all staff for their department"), so it gets
 * its own route here instead of waiting on Home.
 *
 * Also dropped: the all-day announcement banner ("Bailey's birthday") —
 * that's Phase 6's "announcements-lite" — and the labor $/% stat tile.
 * Computing it needs every scheduled employee's hourly rate, which
 * `private/compensation` denies to anyone but that employee (or a manager
 * with `employees.editPay` AND below-level access, spec §17) — showing it
 * on a screen "visible to all staff" would mean either partial-and-wrong
 * numbers for most viewers or a real compensation leak. "On now" and
 * "Scheduled today" don't have that problem.
 */

const WINDOW_START_MIN = 9 * 60
const WINDOW_END_MIN = 24 * 60
const WINDOW_SPAN_MIN = WINDOW_END_MIN - WINDOW_START_MIN
const HOUR_LABELS = [9, 11, 13, 15, 17, 19, 21, 23]

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

function pct(min: number): number {
  return Math.max(0, Math.min(100, ((min - WINDOW_START_MIN) / WINDOW_SPAN_MIN) * 100))
}

/**
 * hour24 is a plain "hour of the ruler," not a real instant — must format in
 * UTC explicitly, or Intl silently reinterprets it in the browser's local
 * zone and every label drifts by that zone's offset from UTC (caught live:
 * "9 AM" rendered as "4 AM" in a UTC-5 environment).
 */
function hourLabel(hour24: number, lang: string): string {
  const d = new Date(Date.UTC(2000, 0, 1, hour24))
  return new Intl.DateTimeFormat(lang.startsWith('es') ? 'es' : 'en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    hour12: true,
  }).format(d)
}

/** "Now" in the restaurant's own timezone, not the viewer's device — the gantt's now-line describes the floor, not the browser. */
function nowInRestaurantTz(): { isoDate: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: RESTAURANT_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date())
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const isoDate = `${get('year')}-${String(get('month')).padStart(2, '0')}-${String(get('day')).padStart(2, '0')}`
  return { isoDate, minutes: get('hour') * 60 + get('minute') }
}

function displayName(e: Employee): string {
  const first = e.preferredName?.trim() ? e.preferredName : e.firstName
  return `${first} ${e.lastName}`.trim()
}

const ALL = 'all'
const DEPARTMENTS: readonly Department[] = ['FOH', 'BOH'] as const

export function WhosWorkingPage(): JSX.Element {
  return (
    <RequirePermission permission="schedule.view">
      <WhosWorkingScreen />
    </RequirePermission>
  )
}

function WhosWorkingScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const { employee, can } = useAuth()

  const seesAllDepartments = can('employees.view') || can('schedule.create')

  const [date, setDate] = useState(() => nowInRestaurantTz().isoDate)
  // Defaults to the viewer's own department — UNLESS that's not one that
  // ever staffs a shift (Admin, for owners/GMs/office roles) or the viewer
  // is elevated enough to see everything, in which case "All" is the only
  // default that isn't quietly wrong.
  const [department, setDepartment] = useState<string>(() => {
    const own = employee?.department
    if (seesAllDepartments || own === undefined || !DEPARTMENTS.includes(own as Department)) {
      return ALL
    }
    return own
  })

  const [shifts, setShifts] = useState<Shift[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [roles, setRoles] = useState<ShiftRole[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const weekId = weekIdFor(new Date(`${date}T12:00:00Z`))
      const deptsToQuery: Department[] =
        department === ALL ? [...DEPARTMENTS] : [department as Department]

      const [shiftLists, catalog, people] = await Promise.all([
        Promise.all(
          deptsToQuery.map((dept) =>
            seesAllDepartments
              ? listShifts(weekId, { department: dept, status: 'published', date })
              : listPublishedShiftsForDepartment(weekId, dept),
          ),
        ),
        listShiftRoles(),
        listEmployees({ status: 'active' }),
      ])

      setShifts(shiftLists.flat().filter((s) => s.date === date))
      setRoles(catalog)
      setEmployees(people)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [date, department, seesAllDepartments])

  useEffect(() => {
    void load()
  }, [load])

  const employeesById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])
  const rolesById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles])

  const rows = useMemo(() => {
    const byEmployee = new Map<string, Shift[]>()
    for (const s of shifts) {
      if (!s.employeeId) continue
      const list = byEmployee.get(s.employeeId) ?? []
      list.push(s)
      byEmployee.set(s.employeeId, list)
    }
    return [...byEmployee.entries()]
      .map(([employeeId, empShifts]) => ({
        employee: employeesById.get(employeeId),
        shifts: empShifts.sort((a, b) => a.startTime.localeCompare(b.startTime)),
      }))
      .filter((r): r is { employee: Employee; shifts: Shift[] } => r.employee !== undefined)
      .sort((a, b) => a.shifts[0]!.startTime.localeCompare(b.shifts[0]!.startTime))
  }, [shifts, employeesById])

  const { isoDate: todayIso, minutes: nowMinutes } = nowInRestaurantTz()
  const isToday = date === todayIso
  const nowPct = isToday ? pct(nowMinutes) : null

  const onNowCount = useMemo(() => {
    if (!isToday) return 0
    return rows.filter((r) => r.shifts.some((s) => nowMinutes >= minutesOf(s.startTime) && nowMinutes < minutesOf(s.endTime))).length
  }, [rows, isToday, nowMinutes])

  const legendRoles = useMemo(
    () => roles.filter((r) => shifts.some((s) => s.roleId === r.id)),
    [roles, shifts],
  )

  function roleName(r: ShiftRole): string {
    return lang.startsWith('es') && r.nameEs ? r.nameEs : r.name
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">
            {t('whosWorking.title')}
          </h1>
          <p className="mt-0.5 text-meta text-ink-muted">
            {formatDate(new Date(`${date}T12:00:00Z`), { weekday: 'long', month: 'long', day: 'numeric' }, lang)}
          </p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t('availability.previousWeek')}
            onClick={() => setDate((d) => addDaysToIsoDate(d, -1))}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-page text-ink-muted hover:text-ink"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={() => setDate(nowInRestaurantTz().isoDate)}
            className="rounded-control border border-line bg-page px-3 py-1.5 text-chip font-medium text-ink-muted hover:text-ink"
          >
            {t('mySchedule.today')}
          </button>
          <button
            type="button"
            aria-label={t('availability.nextWeek')}
            onClick={() => setDate((d) => addDaysToIsoDate(d, 1))}
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-line bg-page text-ink-muted hover:text-ink"
          >
            ›
          </button>

          {seesAllDepartments ? (
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="ml-2 rounded-control border border-line bg-page px-3 py-1.5 text-chip font-medium text-ink"
            >
              <option value={ALL}>{t('filters.allDepartments')}</option>
              {DEPARTMENTS.map((d) => (
                <option key={d} value={d}>
                  {t(`departments.${d}`)}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        {legendRoles.length > 0 ? (
          <div className="flex flex-wrap items-center gap-3">
            {legendRoles.map((r) => (
              <span key={r.id} className="flex items-center gap-1.5 text-chip text-ink-muted">
                <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: r.color }} />
                {roleName(r)}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {!loading && !loadError ? (
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div className="rounded-card border border-line bg-page p-4">
            <p className="tabular text-title-lg font-semibold text-ink">{onNowCount}</p>
            <p className="text-chip text-ink-muted">{t('whosWorking.stats.onNow')}</p>
          </div>
          <div className="rounded-card border border-line bg-page p-4">
            <p className="tabular text-title-lg font-semibold text-ink">{rows.length}</p>
            <p className="text-chip text-ink-muted">{t('whosWorking.stats.scheduled')}</p>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="h-96 animate-skeleton rounded-card bg-app" />
      ) : loadError ? (
        <EmptyState illustration="search" title={t('whosWorking.errorTitle')} body={t('whosWorking.errorBody')} />
      ) : rows.length === 0 ? (
        <EmptyState illustration="calendar" title={t('whosWorking.emptyTitle')} body={t('whosWorking.emptyBody')} />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-page">
          <div className="relative grid" style={{ gridTemplateColumns: '220px 1fr' }}>
            <div className="border-b border-r border-line p-3 text-micro font-semibold uppercase text-ink-muted">
              {t('whosWorking.employee')}
            </div>
            <div className="relative border-b border-line">
              {HOUR_LABELS.map((h) => (
                <span
                  key={h}
                  className="absolute top-0 -translate-x-1/2 py-3 text-micro text-ink-muted"
                  style={{ left: `${pct(h * 60)}%` }}
                >
                  {hourLabel(h, lang)}
                </span>
              ))}
            </div>

            {rows.map(({ employee: person, shifts: personShifts }) => {
              const isOnNow = isToday && personShifts.some((s) => nowMinutes >= minutesOf(s.startTime) && nowMinutes < minutesOf(s.endTime))
              const isDone = isToday && personShifts.every((s) => nowMinutes >= minutesOf(s.endTime))
              return (
                <Fragment key={person.id}>
                  <div className="flex items-center gap-2 border-r border-b border-line p-2">
                    <Avatar firstName={person.firstName} lastName={person.lastName} photoUrl={person.photoUrl} size={28} />
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-chip font-semibold text-ink">{displayName(person)}</span>
                      {isOnNow ? (
                        <span className="text-micro font-semibold text-success">{t('whosWorking.onNow')}</span>
                      ) : isDone ? (
                        <span className="text-micro text-ink-muted">{t('whosWorking.done')}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="relative h-[52px] border-b border-line">
                    {personShifts.map((s) => {
                      const left = pct(minutesOf(s.startTime))
                      const width = Math.max(pct(minutesOf(s.endTime)) - left, 2)
                      const shiftRole = rolesById.get(s.roleId)
                      return (
                        <div
                          key={s.id}
                          className="absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full px-2 py-1 text-micro font-semibold"
                          style={{
                            left: `${left}%`,
                            width: `${width}%`,
                            backgroundColor: shiftRole ? hexToRgba(shiftRole.color, 0.2) : undefined,
                            borderLeft: shiftRole ? `3px solid ${shiftRole.color}` : undefined,
                            color: shiftRole?.color,
                          }}
                        >
                          {s.startTime}–{s.endTime}
                        </div>
                      )
                    })}
                  </div>
                </Fragment>
              )
            })}

            {nowPct !== null ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute top-[52px] bottom-0 z-10 w-px bg-primary"
                style={{ left: `calc(220px + (100% - 220px) * ${nowPct} / 100)` }}
              />
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}

export default WhosWorkingPage
