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
  approveTimeOff,
  declineTimeOff,
  listEmployees,
  listTimeOff,
  refreshTimeOffConflicts,
} from '@/lib/db'
import { formatDate } from '@/lib/format'
import type { Employee, TimeOffCategory, TimeOffRequest, TimeOffStatus } from '@/types/models'

/**
 * Settings → Time off — mockup 36's Requests tab.
 *
 * UNBOUNDED LIST, NOT MONTH-SCOPED. The mockup's filter row includes a
 * date-range control; this list shows every request instead of adding a
 * range picker, because — unlike availability, which really is one-week-at-
 * a-time — a manager reviewing time off cares about "what's pending right
 * now" across whatever weeks people asked for, and the seed data (and any
 * real one) is small enough that filtering client-side is not a performance
 * problem. The month CALENDAR (a separate tab) is where a date gets picked.
 *
 * CONFLICTS ARE RECOMPUTED ON OPEN for every pending row — the doc comment on
 * `refreshTimeOffConflicts` in db/timeOff.ts is explicit that the approver's
 * screen must not trust a stored conflicts array computed back when the
 * request was filed, since the schedule underneath it may have moved.
 */

const CATEGORIES: readonly TimeOffCategory[] = ['paid', 'unpaid'] as const
const STATUSES: readonly TimeOffStatus[] = ['pending', 'approved', 'declined'] as const
const ALL = 'all'

interface Row {
  request: TimeOffRequest
  employee: Employee
  name: string
}

function displayName(e: Employee): string {
  const first = e.preferredName?.trim() ? e.preferredName : e.firstName
  return `${first} ${e.lastName}`.trim()
}

function dateFromIso(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`)
}

export function TimeOffAdminPage(): JSX.Element {
  return (
    <RequirePermission permission="timeoff.approve">
      <TimeOffAdminScreen />
    </RequirePermission>
  )
}

function TimeOffAdminScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()
  const navigate = useNavigate()
  const { employee: actor } = useAuth()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [requests, setRequests] = useState<TimeOffRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [declining, setDeclining] = useState<Row | null>(null)

  const [category, setCategory] = useState(ALL)
  const [status, setStatus] = useState('pending')
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const [people, allRequests] = await Promise.all([
        listEmployees({ status: 'active' }),
        listTimeOff(),
      ])

      // Recompute conflicts for pending requests before showing them — the
      // schedule may have changed since the request was filed.
      const refreshed = await Promise.all(
        allRequests.map(async (r) => {
          if (r.status !== 'pending') return r
          const conflicts = await refreshTimeOffConflicts(r.id)
          return { ...r, conflicts }
        }),
      )

      setEmployees(people)
      setRequests(refreshed)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const rows = useMemo<Row[]>(() => {
    const byId = new Map(employees.map((e) => [e.id, e]))
    const needle = search.trim().toLowerCase()

    return requests
      .flatMap((request) => {
        const person = byId.get(request.employeeId)
        if (!person) return []
        return [{ request, employee: person, name: displayName(person) }]
      })
      .filter(({ request, name }) => {
        if (category !== ALL && request.category !== category) return false
        if (status !== ALL && request.status !== status) return false
        if (needle !== '' && !name.toLowerCase().includes(needle)) return false
        return true
      })
      .sort((a, b) => a.request.startDate.localeCompare(b.request.startDate) || a.name.localeCompare(b.name))
  }, [requests, employees, category, status, search])

  const filtersApplied = category !== ALL || status !== 'pending' || search.trim() !== ''

  function clearFilters(): void {
    setCategory(ALL)
    setStatus('pending')
    setSearch('')
  }

  function dateRangeLabel(r: TimeOffRequest): string {
    if (r.startDate === r.endDate) {
      return formatDate(dateFromIso(r.startDate), { weekday: 'short', month: 'short', day: 'numeric' }, lang)
    }
    return `${formatDate(dateFromIso(r.startDate), { weekday: 'short', month: 'short', day: 'numeric' }, lang)} – ${formatDate(
      dateFromIso(r.endDate),
      { weekday: 'short', month: 'short', day: 'numeric' },
      lang,
    )}`
  }

  async function approve(row: Row): Promise<void> {
    if (!actor) return
    setBusyId(row.request.id)
    try {
      await approveTimeOff(row.request.id, actor.id)
      toast.show({ tone: 'success', message: t('timeOff.admin.toast.approved', { name: row.name }) })
      await load()
    } catch {
      toast.show({ tone: 'error', message: t('timeOff.admin.toast.approveFailed') })
    } finally {
      setBusyId(null)
    }
  }

  async function decline(row: Row, reason: string): Promise<void> {
    if (!actor) return
    setBusyId(row.request.id)
    try {
      await declineTimeOff(row.request.id, actor.id, reason)
      toast.show({ tone: 'success', message: t('timeOff.admin.toast.declined', { name: row.name }) })
      setDeclining(null)
      await load()
    } catch {
      toast.show({ tone: 'error', message: t('timeOff.admin.toast.declineFailed') })
    } finally {
      setBusyId(null)
    }
  }

  const pendingCount = useMemo(() => requests.filter((r) => r.status === 'pending').length, [requests])
  const approvedCount = useMemo(() => requests.filter((r) => r.status === 'approved').length, [requests])
  const declinedCount = useMemo(() => requests.filter((r) => r.status === 'declined').length, [requests])

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">
            {t('timeOff.admin.title')}
          </h1>
          <p className="mt-0.5 text-meta text-ink-muted">{t('timeOff.admin.subtitle')}</p>
        </div>
        <Button onClick={() => navigate('/settings/time-off/calendar')}>
          {t('timeOff.admin.calendarTab')}
        </Button>
      </div>

      <div className="mb-6 grid grid-cols-3 gap-3">
        <StatTile label={t('timeOff.admin.stats.pending')} value={pendingCount} />
        <StatTile label={t('timeOff.admin.stats.approved')} value={approvedCount} />
        <StatTile label={t('timeOff.admin.stats.declined')} value={declinedCount} />
      </div>

      <FilterBar className="mb-6">
        <FilterSelect
          label={t('filters.category')}
          value={category}
          onChange={setCategory}
          options={[
            { value: ALL, label: t('filters.allCategories') },
            ...CATEGORIES.map((c) => ({ value: c, label: t(`timeOff.category.${c}`) })),
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

      {loading ? (
        <>
          <p className="sr-only" role="status">
            {t('app.loading')}
          </p>
          <Table>
            <RequestsHeader />
            {[0, 1, 2].map((i) => (
              <TableRow key={i}>
                <TableCell className="w-[240px]">
                  <span className="h-7 w-7 animate-skeleton rounded-full bg-app" />
                  <span className="h-3 w-32 animate-skeleton rounded bg-app" />
                </TableCell>
                <TableCell className="w-[190px]">
                  <span className="h-3 w-28 animate-skeleton rounded bg-app" />
                </TableCell>
                <TableCell className="w-[110px]">
                  <span className="h-5 w-16 animate-skeleton rounded-full bg-app" />
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
          title={t('timeOff.admin.errorTitle')}
          body={t('timeOff.admin.errorBody')}
          action={<Button onClick={() => void load()}>{t('common.retry')}</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          illustration={filtersApplied ? 'search' : 'tasks'}
          title={filtersApplied ? t('empty.noResults') : t('timeOff.admin.emptyTitle')}
          body={filtersApplied ? t('empty.noResultsBody') : t('timeOff.admin.emptyBody')}
          action={filtersApplied ? <Button onClick={clearFilters}>{t('common.clearFilters')}</Button> : undefined}
        />
      ) : (
        <>
          <Table>
            <RequestsHeader />
            {rows.map((row) => {
              const busy = busyId === row.request.id
              const conflictCount = row.request.conflicts.length
              return (
                <TableRow key={row.request.id}>
                  <TableCell className="w-[240px]">
                    <Avatar
                      firstName={row.employee.firstName}
                      lastName={row.employee.lastName}
                      photoUrl={row.employee.photoUrl}
                      size={28}
                    />
                    <span className="truncate text-meta font-semibold text-ink">{row.name}</span>
                  </TableCell>

                  <TableCell className="w-[190px]">
                    <span className="tabular truncate text-meta text-ink">
                      {dateRangeLabel(row.request)}
                    </span>
                  </TableCell>

                  <TableCell className="w-[110px]">
                    <Pill tone={row.request.category === 'paid' ? 'approved' : 'draft'}>
                      {t(`timeOff.category.${row.request.category}`)}
                    </Pill>
                  </TableCell>

                  <TableCell className="w-[140px]">
                    {conflictCount > 0 ? (
                      <span className="flex items-center gap-1 text-chip font-medium text-warning">
                        <WarningIcon />
                        {t('timeOff.admin.conflictCount', { count: conflictCount })}
                      </span>
                    ) : (
                      <span className="text-chip text-ink-muted">—</span>
                    )}
                  </TableCell>

                  <TableCell className="flex-1">
                    {row.request.status === 'pending' ? (
                      <span className="flex flex-wrap items-center gap-3">
                        <Pill tone="pending">{t('status.pending')}</Pill>
                        <Button variant="success" disabled={busy} onClick={() => void approve(row)}>
                          {t('common.approve')}
                        </Button>
                        <Button disabled={busy} onClick={() => setDeclining(row)}>
                          {t('common.decline')}
                        </Button>
                      </span>
                    ) : (
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <Pill tone={row.request.status}>{t(`status.${row.request.status}`)}</Pill>
                        {row.request.status === 'declined' && row.request.declineReason ? (
                          <span className="truncate text-chip text-ink-muted">
                            {row.request.declineReason}
                          </span>
                        ) : null}
                      </span>
                    )}
                  </TableCell>

                  <TableCell className="w-10" align="right">
                    <KebabMenu
                      items={[
                        {
                          label: t('timeOff.admin.viewProfile'),
                          onClick: () => navigate(`/people/${row.employee.id}`),
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              )
            })}
          </Table>

          <p className="tabular mt-3 text-chip text-ink-muted">
            {t('timeOff.admin.count', { count: rows.length })}
          </p>
        </>
      )}

      <DeclineModal
        row={declining}
        busy={declining !== null && busyId === declining.request.id}
        onClose={() => setDeclining(null)}
        onConfirm={(reason) => {
          if (declining) void decline(declining, reason)
        }}
      />
    </div>
  )
}

function StatTile({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-card border border-line bg-page p-4">
      <p className="tabular text-title-lg font-semibold text-ink">{value}</p>
      <p className="text-chip text-ink-muted">{label}</p>
    </div>
  )
}

function RequestsHeader(): JSX.Element {
  const { t } = useTranslation()
  return (
    <TableHead>
      <TableCell className="w-[240px]">{t('timeOff.admin.columns.employee')}</TableCell>
      <TableCell className="w-[190px]">{t('timeOff.admin.columns.dates')}</TableCell>
      <TableCell className="w-[110px]">{t('timeOff.admin.columns.category')}</TableCell>
      <TableCell className="w-[140px]">{t('timeOff.admin.columns.conflict')}</TableCell>
      <TableCell className="flex-1">{t('filters.status')}</TableCell>
      <TableCell className="w-10" />
    </TableHead>
  )
}

/** Decline reason is OPTIONAL for time off (unlike availability, §5 vs §6) — declineTimeOff() accepts an empty one. */
function DeclineModal({
  row,
  busy,
  onClose,
  onConfirm,
}: {
  row: Row | null
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

  return (
    <Modal
      open={row !== null}
      onClose={onClose}
      title={t('timeOff.admin.declineTitle')}
      subtitle={row ? t('timeOff.admin.declineSubtitle', { name: row.name }) : undefined}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" disabled={busy} onClick={() => onConfirm(reason)}>
            {busy ? t('timeOff.admin.declining') : t('common.decline')}
          </Button>
        </>
      }
    >
      <label htmlFor={fieldId} className="mb-1 block text-chip font-medium text-ink-muted">
        {t('timeOff.admin.reasonLabel')}
      </label>
      <textarea
        id={fieldId}
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t('timeOff.admin.reasonPlaceholder')}
        className="w-full rounded-control border border-line bg-page p-3 text-meta text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </Modal>
  )
}

function WarningIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="h-3.5 w-3.5" aria-hidden="true">
      <path d="M10.3 3.4 2.6 17a1.5 1.5 0 0 0 1.3 2.2h16.2a1.5 1.5 0 0 0 1.3-2.2L13.7 3.4a1.5 1.5 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 16.3h.01" />
    </svg>
  )
}

export default TimeOffAdminPage
