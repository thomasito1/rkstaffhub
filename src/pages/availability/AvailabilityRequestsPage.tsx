import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import {
  Avatar,
  Button,
  EmptyState,
  FilterBar,
  FilterSelect,
  KebabMenu,
  Modal,
  Pill,
  SearchInput,
  Table,
  TableCell,
  TableHead,
  TableRow,
  useToast,
} from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import { useAuth } from '@/lib/auth/AuthProvider'
import {
  approveAvailability,
  declineAvailability,
  getRecurringAvailability,
  listAvailabilityForWeek,
  listEmployees,
  listShiftRoles,
} from '@/lib/db'
import {
  addDaysToIsoDate,
  availabilityDeadlineFor,
  datesForWeekId,
  openAvailabilityWeekId,
} from '@/lib/deadlines'
import { formatDate } from '@/lib/format'
import type {
  Availability,
  AvailabilityStatus,
  AvailabilityType,
  Department,
  Employee,
  ShiftRole,
} from '@/types/models'

/**
 * Availability requests — mockup 09, desktop.
 *
 * Filter row over a bordered table: employee, type chip, effective dates,
 * submitted, status, inline Approve/Decline.
 *
 * DECLINES REQUIRE A REASON (§5). declineAvailability() rejects an empty or
 * whitespace-only reason outright, so Decline opens a modal and its confirm
 * button stays disabled until something is typed. The employee's only route to
 * fixing a refused submission is reading why it was refused.
 *
 * WEEK-SCOPED, NOT MIXED. The mockup lists submissions from four different
 * weeks at once. listAvailabilityForWeek() is indexed on `weekId` — a mixed
 * list would need either a composite index or one query per week — so the
 * table is scoped to one week with a stepper, defaulting to the open week.
 *
 * RECURRING ROWS. listAvailabilityForWeek() deliberately excludes recurring
 * baselines: they are not submissions "for" a week. The mockup shows them
 * anyway, and a manager does have to approve them, so they are fetched
 * per-employee (~35 document reads, the same order as the roster screen) and
 * merged in.
 */

const ALL = 'all'
const DEPARTMENTS: readonly Department[] = ['FOH', 'BOH', 'Admin'] as const
const TYPES: readonly AvailabilityType[] = ['recurring', 'temporary'] as const
const STATUSES: readonly AvailabilityStatus[] = ['pending', 'approved', 'declined'] as const

interface RequestRow {
  record: Availability
  employee: Employee
  name: string
  roleLabel: string
}

function dateFromIso(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`)
}

/** Firestore Timestamp | Date | null → Date | null, without importing the SDK. */
function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value
  if (
    typeof value === 'object' &&
    value !== null &&
    'toDate' in value &&
    typeof (value as { toDate: unknown }).toDate === 'function'
  ) {
    const d = (value as { toDate: () => Date }).toDate()
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

function displayName(e: Employee): string {
  const first = e.preferredName?.trim() ? e.preferredName : e.firstName
  return `${first} ${e.lastName}`.trim()
}

export function AvailabilityRequestsPage({
  glancePath = '/availability/glance',
  peoplePath = '/people',
}: {
  glancePath?: string
  peoplePath?: string
} = {}): JSX.Element {
  return (
    <RequirePermission permission="availability.approve">
      <RequestsScreen glancePath={glancePath} peoplePath={peoplePath} />
    </RequirePermission>
  )
}

function RequestsScreen({
  glancePath,
  peoplePath,
}: {
  glancePath: string
  peoplePath: string
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()
  const navigate = useNavigate()
  const { employee } = useAuth()

  const [now] = useState(() => new Date())
  const [weekId, setWeekId] = useState(() => openAvailabilityWeekId(now))

  const [employees, setEmployees] = useState<Employee[]>([])
  const [roles, setRoles] = useState<ShiftRole[]>([])
  const [records, setRecords] = useState<Availability[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [declining, setDeclining] = useState<RequestRow | null>(null)

  const [department, setDepartment] = useState(ALL)
  const [role, setRole] = useState(ALL)
  const [type, setType] = useState(ALL)
  const [status, setStatus] = useState<string>('pending')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const [people, catalog, temporaries] = await Promise.all([
        listEmployees({ status: 'active' }),
        listShiftRoles(),
        listAvailabilityForWeek(weekId),
      ])
      const recurring = await Promise.all(
        people.map((p) => getRecurringAvailability(p.id)),
      )
      setEmployees(people)
      setRoles(catalog)
      setRecords([
        ...temporaries,
        ...recurring.filter((r): r is Availability => r !== null),
      ])
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

  const rows = useMemo<RequestRow[]>(() => {
    const byId = new Map(employees.map((e) => [e.id, e]))
    const needle = search.trim().toLowerCase()

    return records
      .flatMap((record) => {
        const person = byId.get(record.employeeId)
        if (!person) return []
        const primary = person.shiftRoles.find((r) => r.isPrimary) ?? person.shiftRoles[0]
        const label = primary
          ? t('availability.requests.roleLabel', {
              role: roleName(primary.roleId),
              level: primary.skillLevel,
            })
          : t('people.list.noRoles')
        return [{ record, employee: person, name: displayName(person), roleLabel: label }]
      })
      .filter(({ record, employee: person, name }) => {
        if (department !== ALL && person.department !== department) return false
        if (role !== ALL && !person.shiftRoles.some((r) => r.roleId === role)) return false
        if (type !== ALL && record.type !== type) return false
        if (status !== ALL && record.status !== status) return false
        if (needle !== '' && !name.toLowerCase().includes(needle)) return false
        return true
      })
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [records, employees, department, role, type, status, search, roleName, t])

  const filtersApplied =
    department !== ALL || role !== ALL || type !== ALL || status !== 'pending' || search.trim() !== ''

  function clearFilters(): void {
    setDepartment(ALL)
    setRole(ALL)
    setType(ALL)
    setStatus('pending')
    setSearch('')
  }

  const weekDates = useMemo(() => datesForWeekId(weekId), [weekId])
  const weekRangeLabel = useMemo(() => {
    const first = weekDates[0]
    const last = weekDates[6]
    if (first === undefined || last === undefined) return weekId
    return `${formatDate(dateFromIso(first), { month: 'short', day: 'numeric' }, lang)} – ${formatDate(
      dateFromIso(last),
      { month: 'short', day: 'numeric' },
      lang,
    )}`
  }, [weekDates, weekId, lang])

  const deadlineLabel = useMemo(
    () =>
      formatDate(
        availabilityDeadlineFor(weekId),
        { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
        lang,
      ),
    [weekId, lang],
  )

  const submittedCount = useMemo(() => {
    const ids = new Set(records.map((r) => r.employeeId))
    return employees.filter((e) => ids.has(e.id)).length
  }, [records, employees])

  const pendingCount = useMemo(
    () => records.filter((r) => r.status === 'pending').length,
    [records],
  )

  async function approve(row: RequestRow): Promise<void> {
    if (!employee) return
    setBusyId(row.record.id)
    try {
      await approveAvailability(row.record.id, employee.id)
      toast.show({
        tone: 'success',
        message: t('availability.requests.toast.approved', { name: row.name }),
      })
      await load()
    } catch {
      toast.show({ tone: 'error', message: t('availability.requests.toast.approveFailed') })
    } finally {
      setBusyId(null)
    }
  }

  async function decline(row: RequestRow, reason: string): Promise<void> {
    setBusyId(row.record.id)
    try {
      await declineAvailability(row.record.id, reason, employee?.id)
      toast.show({
        tone: 'success',
        message: t('availability.requests.toast.declined', { name: row.name }),
      })
      setDeclining(null)
      await load()
    } catch {
      toast.show({ tone: 'error', message: t('availability.requests.toast.declineFailed') })
    } finally {
      setBusyId(null)
    }
  }

  function effectiveDates(record: Availability): string {
    if (record.type === 'temporary') return weekRangeLabel
    const submitted = toDate(record.submittedAt)
    if (!submitted) return t('availability.requests.ongoing')
    return t('availability.requests.fromOngoing', {
      date: formatDate(submitted, { month: 'short', day: 'numeric' }, lang),
    })
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">
            {t('availability.title')}
          </h1>
          <p className="mt-0.5 text-meta text-ink-muted">
            {t('availability.requests.subtitle')}
          </p>
        </div>
        <Button onClick={() => navigate(glancePath)}>{t('availability.glance.tab')}</Button>
      </div>

      <nav
        aria-label={t('availability.sectionsLabel')}
        className="mb-6 flex items-center gap-8 border-b border-line"
      >
        <span
          aria-current="page"
          className="flex items-center gap-2 border-b-2 border-primary pb-3 text-meta font-semibold text-ink"
        >
          {t('availability.requests.tab')}
          {pendingCount > 0 ? (
            <span className="tabular rounded-full bg-warning-tint px-1.5 py-0.5 text-micro font-bold text-warning">
              {pendingCount}
            </span>
          ) : null}
        </span>
        <button
          type="button"
          onClick={() => navigate(glancePath)}
          className="border-b-2 border-transparent pb-3 text-meta font-medium text-ink-muted transition-colors duration-hover hover:text-ink"
        >
          {t('availability.glance.tab')}
        </button>
      </nav>

      <FilterBar className="mb-6">
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
        <FilterSelect
          label={t('filters.type')}
          value={type}
          onChange={setType}
          options={[
            { value: ALL, label: t('filters.allTypes') },
            ...TYPES.map((v) => ({ value: v, label: t(`availability.type.${v}`) })),
          ]}
        />
        <FilterSelect
          label={t('filters.status')}
          value={status}
          onChange={setStatus}
          options={[
            { value: ALL, label: t('filters.allStatuses') },
            ...STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })),
          ]}
        />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t('availability.searchEmployees')}
        />
        <button
          type="button"
          onClick={clearFilters}
          className="ml-auto text-meta font-medium text-ink-muted transition-colors duration-hover hover:text-ink"
        >
          {t('common.clearFilters')}
        </button>
      </FilterBar>

      {/* Week stepper + deadline banner. */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-card border border-warning/20 bg-warning-tint px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warning/10 text-warning">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-5 w-5"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
          </span>
          <div className="min-w-0">
            <p className="tabular text-meta font-semibold text-ink">
              {t('availability.requests.deadlineBanner', {
                week: weekRangeLabel,
                deadline: deadlineLabel,
              })}
            </p>
            <p className="tabular text-meta text-ink-muted">
              {t('availability.requests.submittedCount', {
                submitted: submittedCount,
                total: employees.length,
              })}
            </p>
          </div>
        </div>

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
          <button
            type="button"
            onClick={() => setWeekId(openAvailabilityWeekId(now))}
            className="ml-1 rounded px-2 py-1 text-meta font-medium text-ink-muted transition-colors duration-hover hover:bg-app hover:text-ink"
          >
            {t('availability.openWeek')}
          </button>
        </div>
      </div>

      {loading ? (
        <>
          <p className="sr-only" role="status">
            {t('app.loading')}
          </p>
          <Table>
            <RequestsHeader />
            {[0, 1, 2, 3, 4].map((i) => (
              <TableRow key={i}>
                <TableCell className="w-[260px]">
                  <span className="h-7 w-7 animate-skeleton rounded-full bg-app" />
                  <span className="h-3 w-32 animate-skeleton rounded bg-app" />
                </TableCell>
                <TableCell className="w-[130px]">
                  <span className="h-5 w-20 animate-skeleton rounded-full bg-app" />
                </TableCell>
                <TableCell className="w-[190px]">
                  <span className="h-3 w-28 animate-skeleton rounded bg-app" />
                </TableCell>
                <TableCell className="w-[160px]">
                  <span className="h-3 w-24 animate-skeleton rounded bg-app" />
                </TableCell>
                <TableCell className="flex-1">
                  <span className="h-5 w-24 animate-skeleton rounded-full bg-app" />
                </TableCell>
                <TableCell className="w-10" />
              </TableRow>
            ))}
          </Table>
        </>
      ) : loadError ? (
        <EmptyState
          illustration="search"
          title={t('availability.requests.errorTitle')}
          body={t('availability.requests.errorBody')}
          action={<Button onClick={() => void load()}>{t('common.retry')}</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          illustration={filtersApplied ? 'search' : 'tasks'}
          title={filtersApplied ? t('empty.noResults') : t('availability.requests.emptyTitle')}
          body={filtersApplied ? t('empty.noResultsBody') : t('availability.requests.emptyBody')}
          action={
            filtersApplied ? (
              <Button onClick={clearFilters}>{t('common.clearFilters')}</Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table>
            <RequestsHeader />
            {rows.map((row) => {
              const submitted = toDate(row.record.submittedAt)
              const busy = busyId === row.record.id
              return (
                <TableRow key={row.record.id}>
                  <TableCell className="w-[260px]">
                    <Avatar
                      firstName={row.employee.firstName}
                      lastName={row.employee.lastName}
                      photoUrl={row.employee.photoUrl}
                      size={28}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-meta font-semibold text-ink">
                        {row.name}
                      </span>
                      <span className="truncate text-chip text-ink-muted">
                        {row.roleLabel}
                      </span>
                    </span>
                  </TableCell>

                  <TableCell className="w-[130px]">
                    <Pill tone={row.record.type === 'temporary' ? 'published' : 'draft'}>
                      {t(`availability.type.${row.record.type}`)}
                    </Pill>
                  </TableCell>

                  <TableCell className="w-[190px]">
                    <span className="tabular truncate text-meta text-ink">
                      {effectiveDates(row.record)}
                    </span>
                  </TableCell>

                  <TableCell className="w-[160px]">
                    <span className="tabular truncate text-meta text-ink-muted">
                      {submitted
                        ? formatDate(
                            submitted,
                            {
                              month: 'short',
                              day: 'numeric',
                              hour: 'numeric',
                              minute: '2-digit',
                            },
                            lang,
                          )
                        : '—'}
                    </span>
                  </TableCell>

                  <TableCell className="flex-1">
                    {row.record.status === 'pending' ? (
                      <span className="flex flex-wrap items-center gap-3">
                        <Pill tone="pending">{t('status.pending')}</Pill>
                        <Button
                          variant="success"
                          disabled={busy}
                          onClick={() => void approve(row)}
                        >
                          {t('common.approve')}
                        </Button>
                        <Button disabled={busy} onClick={() => setDeclining(row)}>
                          {t('common.decline')}
                        </Button>
                      </span>
                    ) : (
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <Pill tone={row.record.status}>{t(`status.${row.record.status}`)}</Pill>
                        {row.record.status === 'declined' && row.record.declineReason ? (
                          <span className="truncate text-chip text-ink-muted">
                            {row.record.declineReason}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </TableCell>

                  <TableCell className="w-10" align="right">
                    <KebabMenu
                      items={[
                        {
                          label: t('availability.requests.viewProfile'),
                          onClick: () => navigate(`${peoplePath}/${row.employee.id}`),
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              )
            })}
          </Table>

          <p className="tabular mt-3 text-chip text-ink-muted">
            {t('availability.requests.count', { count: rows.length })}
          </p>
        </>
      )}

      <DeclineModal
        row={declining}
        busy={declining !== null && busyId === declining.record.id}
        onClose={() => setDeclining(null)}
        onConfirm={(reason) => {
          if (declining) void decline(declining, reason)
        }}
      />
    </div>
  )
}

function RequestsHeader(): JSX.Element {
  const { t } = useTranslation()
  return (
    <TableHead>
      <TableCell className="w-[260px]">{t('availability.requests.columns.employee')}</TableCell>
      <TableCell className="w-[130px]">{t('filters.type')}</TableCell>
      <TableCell className="w-[190px]">
        {t('availability.requests.columns.effectiveDates')}
      </TableCell>
      <TableCell className="w-[160px]">
        {t('availability.requests.columns.submitted')}
      </TableCell>
      <TableCell className="flex-1">{t('filters.status')}</TableCell>
      <TableCell className="w-10" />
    </TableHead>
  )
}

/**
 * Decline requires a reason (§5). The confirm button is disabled until the
 * textarea holds non-whitespace, because declineAvailability() throws on an
 * empty one and the employee is shown this text verbatim.
 */
function DeclineModal({
  row,
  busy,
  onClose,
  onConfirm,
}: {
  row: RequestRow | null
  busy: boolean
  onClose: () => void
  onConfirm: (reason: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const fieldId = useId()
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (row) setReason('')
  }, [row])

  const valid = reason.trim() !== ''

  return (
    <Modal
      open={row !== null}
      onClose={onClose}
      title={t('availability.requests.declineTitle')}
      subtitle={
        row ? t('availability.requests.declineSubtitle', { name: row.name }) : undefined
      }
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={!valid || busy}
            onClick={() => onConfirm(reason)}
          >
            {busy ? t('availability.requests.declining') : t('common.decline')}
          </Button>
        </>
      }
    >
      <label htmlFor={fieldId} className="mb-1 block text-chip font-medium text-ink-muted">
        {t('availability.requests.reasonLabel')}
      </label>
      <textarea
        id={fieldId}
        rows={4}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        aria-required="true"
        aria-invalid={!valid}
        aria-describedby={`${fieldId}-help`}
        placeholder={t('availability.requests.reasonPlaceholder')}
        className="w-full rounded-control border border-line bg-page p-3 text-meta text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <p id={`${fieldId}-help`} className="mt-1 text-chip text-ink-muted">
        {t('availability.requests.reasonHelp')}
      </p>
    </Modal>
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

export default AvailabilityRequestsPage
