import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Avatar, Button, EmptyState, FilterBar, FilterSelect, SearchInput } from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import {
  getRecurringAvailability,
  listAvailabilityForWeek,
  listEmployees,
  listShiftRoles,
  resolveEffectiveAvailability,
  type EffectiveAvailability,
} from '@/lib/db'
import { addDaysToIsoDate, datesForWeekId } from '@/lib/deadlines'
import { formatDate, weekIdFor } from '@/lib/format'
import { intlLocale } from '@/i18n'
import {
  WEEKDAY_KEYS,
  type Availability,
  type AvailabilityDay,
  type Department,
  type Employee,
  type ShiftRole,
} from '@/types/models'

/**
 * Glance view — mockup 10, desktop.
 *
 * The whole roster × seven days in one screen: teal "Available", red "Not
 * available", amber carrying the actual time range. Everything the schedule
 * builder needs to see before it starts assigning shifts.
 *
 * REAL TABLE SEMANTICS. The mockup lays the grid out with nested flexbox,
 * which reads to a screen reader as a wall of undifferentiated text. This is a
 * genuine data table: <th scope="col"> per day, <th scope="row"> per person, so
 * every cell announces "Val Sariol, Wednesday 12 — available 11:00 AM to 4:00
 * PM" instead of "11:00 AM". The visual result is identical; the left column is
 * pinned with `position: sticky` so it survives horizontal scrolling.
 *
 * READ COST. One indexed query for the week's temporary overrides plus one
 * document per employee for their rolling baseline (~36 reads for the whole
 * grid), then resolveEffectiveAvailability() — a pure function — resolves each
 * row locally. Calling effectiveAvailabilityFor() per employee would double
 * that by re-reading every baseline.
 *
 * PRINT. The Print button is window.print() against the print stylesheet
 * declared below, which hides the app chrome and the on-screen controls,
 * unclips the shell's scroll containers and forces colour printing so the
 * teal/red/amber survive onto paper.
 */

const ALL = 'all'
const DEPARTMENTS: readonly Department[] = ['FOH', 'BOH', 'Admin'] as const

const PRINT_ROOT_ID = 'availability-glance-print'

/**
 * Scoped to this screen rather than added to index.css, which is shared. The
 * visibility trick is what keeps the app shell — icon rail, top bar, tab bar —
 * off the page without this component knowing their markup.
 */
const PRINT_CSS = `
@page { size: landscape; margin: 10mm; }
@media print {
  html, body { height: auto !important; overflow: visible !important; background: white !important; }
  body * { visibility: hidden !important; }
  #${PRINT_ROOT_ID}, #${PRINT_ROOT_ID} * { visibility: visible !important; }
  #${PRINT_ROOT_ID} .no-print { display: none !important; }
  #${PRINT_ROOT_ID} {
    position: absolute; top: 0; left: 0; width: 100%;
    margin: 0; padding: 0; max-width: none;
  }
  #${PRINT_ROOT_ID} .glance-scroll { overflow: visible !important; }
  #${PRINT_ROOT_ID} * {
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  #${PRINT_ROOT_ID} tr { break-inside: avoid; page-break-inside: avoid; }
  #${PRINT_ROOT_ID} thead { display: table-header-group; }
}
`

function dateFromIso(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`)
}

/**
 * "HH:mm" is a wall-clock string with no instant attached, so it is formatted
 * against a UTC placeholder date — feeding it through the restaurant timezone
 * would shift 9:00 AM by the UTC offset.
 */
function formatClock(hhmm: string, lang: string): string {
  const [h, m] = hhmm.split(':')
  const hour = Number(h)
  const minute = Number(m)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return hhmm
  return new Intl.DateTimeFormat(intlLocale(lang), {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2000, 0, 1, hour, minute)))
}

function displayName(e: Employee): string {
  const first = e.preferredName?.trim() ? e.preferredName : e.firstName
  return `${first} ${e.lastName}`.trim()
}

interface GlanceRow {
  employee: Employee
  name: string
  roleLabel: string
  effective: EffectiveAvailability
}

export function GlanceViewPage({
  requestsPath = '/availability/requests',
}: {
  requestsPath?: string
} = {}): JSX.Element {
  return (
    <RequirePermission permission="availability.viewAll">
      <GlanceScreen requestsPath={requestsPath} />
    </RequirePermission>
  )
}

function GlanceScreen({ requestsPath }: { requestsPath: string }): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const navigate = useNavigate()

  const [now] = useState(() => new Date())
  const thisWeekId = useMemo(() => weekIdFor(now), [now])
  const [weekId, setWeekId] = useState(thisWeekId)

  const [employees, setEmployees] = useState<Employee[]>([])
  const [roles, setRoles] = useState<ShiftRole[]>([])
  const [temporaries, setTemporaries] = useState<Availability[]>([])
  const [recurring, setRecurring] = useState<Map<string, Availability>>(new Map())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const [department, setDepartment] = useState(ALL)
  const [role, setRole] = useState(ALL)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const [people, catalog, weekRecords] = await Promise.all([
        listEmployees({ status: 'active' }),
        listShiftRoles(),
        listAvailabilityForWeek(weekId),
      ])
      const baselines = await Promise.all(people.map((p) => getRecurringAvailability(p.id)))
      const map = new Map<string, Availability>()
      baselines.forEach((record, index) => {
        const person = people[index]
        if (record && person) map.set(person.id, record)
      })
      setEmployees(people)
      setRoles(catalog)
      setTemporaries(weekRecords)
      setRecurring(map)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [weekId])

  useEffect(() => {
    void load()
  }, [load])

  const roleName = useCallback(
    (id: string): string => {
      const found = roles.find((r) => r.id === id)
      if (!found) return id
      return lang.startsWith('es') && found.nameEs ? found.nameEs : found.name
    },
    [roles, lang],
  )

  const rows = useMemo<GlanceRow[]>(() => {
    const byEmployee = new Map(temporaries.map((r) => [r.employeeId, r]))
    const needle = search.trim().toLowerCase()

    return employees
      .filter((e) => {
        if (department !== ALL && e.department !== department) return false
        if (role !== ALL && !e.shiftRoles.some((r) => r.roleId === role)) return false
        if (needle !== '' && !displayName(e).toLowerCase().includes(needle)) return false
        return true
      })
      .map((employee) => {
        const primary = employee.shiftRoles.find((r) => r.isPrimary) ?? employee.shiftRoles[0]
        return {
          employee,
          name: displayName(employee),
          roleLabel: primary
            ? t('availability.glance.roleLabel', {
                role: roleName(primary.roleId),
                level: primary.skillLevel,
              })
            : t('people.list.noRoles'),
          effective: resolveEffectiveAvailability(
            employee.id,
            weekId,
            recurring.get(employee.id) ?? null,
            byEmployee.get(employee.id) ?? null,
          ),
        }
      })
  }, [employees, temporaries, recurring, weekId, department, role, search, roleName, t])

  const filtersApplied = department !== ALL || role !== ALL || search.trim() !== ''

  const weekDates = useMemo(() => datesForWeekId(weekId), [weekId])

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

  const stats = useMemo(() => {
    let fully = 0
    let partial = 0
    let submitted = 0
    for (const row of rows) {
      const days = WEEKDAY_KEYS.map((key) => row.effective.days[key])
      if (days.every((d) => d.status === 'available')) fully += 1
      if (days.some((d) => d.status === 'partial')) partial += 1
      if (row.effective.source !== 'none') submitted += 1
    }
    return { fully, partial, submitted, total: rows.length }
  }, [rows])

  return (
    <div id={PRINT_ROOT_ID} className="mx-auto max-w-[1360px]">
      <style>{PRINT_CSS}</style>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">
            {t('availability.title')}
          </h1>
          <p className="tabular mt-0.5 text-meta font-medium text-ink-muted">
            {t('availability.glance.weekOf', { week: weekRangeLabel })}
          </p>
        </div>
        <Button
          className="no-print"
          onClick={() => window.print()}
          icon={
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
            >
              <path d="M6 9V3h12v6" />
              <rect x="4" y="9" width="16" height="7" rx="2" />
              <path d="M8 16h8v5H8z" />
            </svg>
          }
        >
          {t('availability.glance.print')}
        </Button>
      </div>

      <nav
        aria-label={t('availability.sectionsLabel')}
        className="no-print mb-6 flex items-center gap-8 border-b border-line"
      >
        <span
          aria-current="page"
          className="border-b-2 border-primary pb-3 text-meta font-semibold text-ink"
        >
          {t('availability.glance.tab')}
        </span>
        <button
          type="button"
          onClick={() => navigate(requestsPath)}
          className="border-b-2 border-transparent pb-3 text-meta font-medium text-ink-muted transition-colors duration-hover hover:text-ink"
        >
          {t('availability.requests.tab')}
        </button>
      </nav>

      <FilterBar className="no-print mb-6">
        <div className="flex items-center gap-1 rounded-control border border-line bg-page p-1">
          <button
            type="button"
            aria-label={t('availability.previousWeek')}
            onClick={() => setWeekId((w) => addDaysToIsoDate(w, -7))}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors duration-hover hover:bg-app hover:text-ink"
          >
            <Chevron dir="left" />
          </button>
          <span className="tabular px-2 text-meta font-semibold text-ink">{weekRangeLabel}</span>
          <button
            type="button"
            aria-label={t('availability.nextWeek')}
            onClick={() => setWeekId((w) => addDaysToIsoDate(w, 7))}
            className="flex h-7 w-7 items-center justify-center rounded text-ink-muted transition-colors duration-hover hover:bg-app hover:text-ink"
          >
            <Chevron dir="right" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setWeekId(thisWeekId)}
          className="rounded-control px-3 py-1.5 text-meta font-medium text-ink-muted transition-colors duration-hover hover:bg-page hover:text-ink"
        >
          {t('availability.thisWeek')}
        </button>

        <FilterSelect
          label={t('filters.department')}
          value={department}
          onChange={setDepartment}
          options={[
            { value: ALL, label: t('filters.allDepartments') },
            ...DEPARTMENTS.map((d) => ({ value: d, label: t(`departments.${d}`) })),
          ]}
        />
        <FilterSelect
          label={t('filters.role')}
          value={role}
          onChange={setRole}
          options={[
            { value: ALL, label: t('filters.allRoles') },
            ...roles.map((r) => ({ value: r.id, label: roleName(r.id) })),
          ]}
        />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t('availability.searchEmployees')}
        />

        <div className="ml-auto flex items-center gap-4 text-meta font-medium">
          <Legend className="bg-success" label={t('availability.dayStatus.available')} />
          <Legend className="bg-danger" label={t('availability.dayStatus.unavailable')} />
          <Legend className="bg-warning" label={t('availability.dayStatus.partial')} />
        </div>
      </FilterBar>

      {loading ? (
        <>
          <p className="sr-only" role="status">
            {t('app.loading')}
          </p>
          <div className="flex flex-col gap-1 rounded-card border border-line bg-page p-1">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-[60px] animate-skeleton rounded-lg bg-app" />
            ))}
          </div>
        </>
      ) : loadError ? (
        <EmptyState
          illustration="search"
          title={t('availability.glance.errorTitle')}
          body={t('availability.glance.errorBody')}
          action={<Button onClick={() => void load()}>{t('common.retry')}</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          illustration={filtersApplied ? 'search' : 'calendar'}
          title={filtersApplied ? t('empty.noResults') : t('availability.glance.emptyTitle')}
          body={filtersApplied ? t('empty.noResultsBody') : t('availability.glance.emptyBody')}
          action={
            filtersApplied ? (
              <Button
                onClick={() => {
                  setDepartment(ALL)
                  setRole(ALL)
                  setSearch('')
                }}
              >
                {t('common.clearFilters')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="overflow-hidden rounded-card border border-line bg-page">
            <div className="glance-scroll overflow-x-auto">
              <table className="w-full min-w-[980px] border-collapse text-left">
                <caption className="sr-only">
                  {t('availability.glance.tableCaption', { week: weekRangeLabel })}
                </caption>
                <thead>
                  <tr className="border-b border-line bg-app">
                    <th
                      scope="col"
                      className="sticky left-0 z-10 w-[260px] bg-app p-4 text-micro font-bold uppercase tracking-wider text-ink-muted"
                    >
                      {t('availability.requests.columns.employee')}
                    </th>
                    {WEEKDAY_KEYS.map((key, index) => {
                      const isoDate = weekDates[index]
                      return (
                        <th
                          key={key}
                          scope="col"
                          className="border-l border-line p-3 text-center"
                        >
                          <span className="block text-micro font-bold uppercase text-ink-muted">
                            {t(`weekdays.short.${key}`)}
                          </span>
                          <span className="tabular block text-body font-bold text-ink">
                            {isoDate === undefined
                              ? '—'
                              : formatDate(dateFromIso(isoDate), { day: 'numeric' }, lang)}
                          </span>
                        </th>
                      )
                    })}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.employee.id} className="h-[60px] border-b border-line last:border-b-0">
                      <th
                        scope="row"
                        className="sticky left-0 z-10 w-[260px] bg-page px-4 text-left font-normal"
                      >
                        <span className="flex items-center gap-3">
                          <Avatar
                            firstName={row.employee.firstName}
                            lastName={row.employee.lastName}
                            photoUrl={row.employee.photoUrl}
                            size={32}
                          />
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-meta font-medium text-ink">
                              {row.name}
                            </span>
                            <span className="flex items-center gap-1.5">
                              <span className="truncate text-chip text-ink-muted">
                                {row.roleLabel}
                              </span>
                              <SourceChip source={row.effective.source} />
                              {row.effective.isPending ? (
                                <span className="rounded bg-warning-tint px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                                  {t('availability.glance.pendingChip')}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </span>
                      </th>

                      {WEEKDAY_KEYS.map((key) => (
                        <DayCell key={key} day={row.effective.days[key]} lang={lang} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-4">
            <Stat
              label={t('availability.glance.statFully')}
              value={t('availability.glance.ofTotal', {
                done: stats.fully,
                total: stats.total,
              })}
            />
            <Stat label={t('availability.glance.statPartial')} value={String(stats.partial)} />
            <Stat
              label={t('availability.glance.statSubmitted')}
              value={t('availability.glance.ofTotal', {
                done: stats.submitted,
                total: stats.total,
              })}
            />
          </div>
        </>
      )}
    </div>
  )
}

function DayCell({
  day,
  lang,
}: {
  day: AvailabilityDay
  lang: string
}): JSX.Element {
  const { t } = useTranslation()

  if (day.status === 'unavailable') {
    return (
      <td className="p-1 align-middle">
        <div className="flex h-[52px] items-center justify-center rounded-lg bg-danger-tint">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.75}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-5 w-5 text-danger"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="m15 9-6 6M9 9l6 6" />
          </svg>
          <span className="sr-only">{t('availability.dayStatus.unavailable')}</span>
        </div>
      </td>
    )
  }

  if (day.status === 'partial') {
    const from = day.from ?? ''
    const to = day.to ?? ''
    const range =
      from !== '' && to !== ''
        ? `${formatClock(from, lang)} – ${formatClock(to, lang)}`
        : t('availability.dayStatus.partial')
    return (
      <td className="p-1 align-middle">
        <div className="flex h-[52px] items-center justify-center rounded-lg bg-warning-tint p-1 text-center">
          <span className="tabular text-chip font-semibold text-warning">
            <span className="sr-only">{t('availability.glance.availableBetween')} </span>
            {range}
          </span>
        </div>
      </td>
    )
  }

  return (
    <td className="p-1 align-middle">
      <div className="flex h-[52px] items-center justify-center rounded-lg bg-success-tint">
        <span className="text-meta font-semibold text-success">
          {t('availability.dayStatus.available')}
        </span>
      </div>
    </td>
  )
}

function SourceChip({ source }: { source: 'temporary' | 'recurring' | 'none' }): JSX.Element | null {
  const { t } = useTranslation()
  if (source === 'none') return null
  const temporary = source === 'temporary'
  return (
    <span
      className={[
        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold',
        temporary ? 'bg-primary-tint text-primary' : 'bg-app text-ink-muted',
      ].join(' ')}
    >
      {t(`availability.type.${source}`)}
    </span>
  )
}

function Legend({ className, label }: { className: string; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden="true" className={`h-3 w-3 rounded-full ${className}`} />
      <span className="text-ink-muted">{label}</span>
    </span>
  )
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col rounded-control border border-line bg-page px-4 py-3">
      <span className="text-micro font-bold uppercase tracking-wider text-ink-muted">
        {label}
      </span>
      <span className="tabular text-section font-bold text-ink">{value}</span>
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

export default GlanceViewPage
