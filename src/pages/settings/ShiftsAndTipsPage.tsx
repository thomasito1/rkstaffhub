import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Papa from 'papaparse'

import {
  Avatar,
  Button,
  EmptyState,
  FilterBar,
  FilterSelect,
  KebabMenu,
  Pill,
  SearchInput,
  Table,
  TableCell,
  TableHead,
  TableRow,
  useToast,
} from '@/components/ui'
import { useAuth } from '@/lib/auth/AuthProvider'
import { addDaysToIsoDate } from '@/lib/deadlines'
import { getShiftRoleMap, listEmployees, listPunchesInRange, listTipReportsInRange, punchLocalDate } from '@/lib/db'
import { formatCurrency, formatDate, RESTAURANT_TZ } from '@/lib/format'
import type { Department, Employee, Punch, ShiftRole, TipReport } from '@/types/models'

import { ManualPunchModal } from './components/ManualPunchModal'
import { PunchEditModal } from './components/PunchEditModal'
import {
  buildPunchRows,
  dateFromIso,
  displayName,
  hoursBetween,
  roleLabel,
  toDate,
  type PunchRow,
} from './shiftsAndTipsShared'

const ALL = 'all'
const PAGE_SIZE = 20
const DEPARTMENTS: readonly Department[] = ['FOH', 'BOH', 'Admin'] as const

function todayIsoRestaurant(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: RESTAURANT_TZ }).format(new Date())
}

function timeLabel(date: Date | null, lang: string): string {
  if (!date) return '—'
  return new Intl.DateTimeFormat(lang.startsWith('es') ? 'es' : 'en-US', {
    timeZone: RESTAURANT_TZ,
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

interface RowFlag {
  kind:
    | 'no-scheduled-shift'
    | 'forgotten-clockout'
    | 'manual'
    | 'backdated'
    | 'offline-synced'
    | 'edited'
    | 'missing-tip-report'
  label: string
  tone: 'pending' | 'declined'
}

/** A manual punch whose own recorded time lands on a different restaurant-local day than when it was actually created — mockup 24's "add a shift the employee never punched at all" case, not a same-day correction. */
function isBackdatedManualPunch(punch: Punch | null): boolean {
  if (!punch?.manualBy) return false
  const at = toDate(punch.timestamp)
  const createdAt = toDate(punch.createdAt)
  if (!at || !createdAt) return false
  const localDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: RESTAURANT_TZ }).format(d)
  return localDate(at) !== localDate(createdAt)
}

function isEdited(punch: Punch | null): boolean {
  return Boolean(punch && (punch.editHistory.length > 0 || punch.editedBy))
}

function isOfflineSynced(punch: Punch | null): boolean {
  return Boolean(punch?.syncedFromOfflineQueue)
}

function rowHasFlag(row: PunchRow): boolean {
  const noScheduledShift = Boolean(row.inPunch?.flagged && row.inPunch.flagReason === 'no-scheduled-shift')
  const forgottenClockout = row.inPunch?.flagReason === 'forgotten-clockout' && !row.outPunch
  const manual = Boolean(row.inPunch?.manualBy || row.outPunch?.manualBy)
  const backdated = isBackdatedManualPunch(row.inPunch) || isBackdatedManualPunch(row.outPunch)
  const offlineSynced = isOfflineSynced(row.inPunch) || isOfflineSynced(row.outPunch)
  const edited =
    isEdited(row.inPunch) || isEdited(row.outPunch) || Boolean(row.tipReport?.editHistory.length)
  return Boolean(
    noScheduledShift ||
      forgottenClockout ||
      manual ||
      backdated ||
      offlineSynced ||
      edited ||
      row.missingTipReport,
  )
}

function rowFlagBadges(row: PunchRow, employeesById: Map<string, Employee>, t: TFunction): RowFlag[] {
  const flags: RowFlag[] = []
  if (row.inPunch?.flagged && row.inPunch.flagReason === 'no-scheduled-shift') {
    flags.push({ kind: 'no-scheduled-shift', label: t('shiftsAndTips.flags.noScheduledShift'), tone: 'pending' })
  }
  if (row.inPunch?.flagReason === 'forgotten-clockout' && !row.outPunch) {
    flags.push({ kind: 'forgotten-clockout', label: t('shiftsAndTips.flags.forgottenClockout'), tone: 'declined' })
  }
  const manualBy = row.inPunch?.manualBy ?? row.outPunch?.manualBy ?? null
  if (manualBy) {
    const manager = employeesById.get(manualBy)
    flags.push({
      kind: 'manual',
      label: t('shiftsAndTips.flags.manualBy', { name: manager ? displayName(manager) : manualBy }),
      tone: 'pending',
    })
  }
  if (isBackdatedManualPunch(row.inPunch) || isBackdatedManualPunch(row.outPunch)) {
    flags.push({ kind: 'backdated', label: t('shiftsAndTips.flags.backdated'), tone: 'pending' })
  }
  if (isOfflineSynced(row.inPunch) || isOfflineSynced(row.outPunch)) {
    flags.push({ kind: 'offline-synced', label: t('shiftsAndTips.flags.offlineSynced'), tone: 'pending' })
  }
  if (isEdited(row.inPunch) || isEdited(row.outPunch) || row.tipReport?.editHistory.length) {
    flags.push({ kind: 'edited', label: t('shiftsAndTips.flags.edited'), tone: 'pending' })
  }
  if (row.missingTipReport) {
    flags.push({ kind: 'missing-tip-report', label: t('shiftsAndTips.flags.missingTipReport'), tone: 'pending' })
  }
  return flags
}

function FullPageMessage({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <h1 className="text-section font-semibold text-ink">{title}</h1>
      {body ? <p className="mt-2 max-w-sm text-meta text-ink-muted">{body}</p> : null}
    </div>
  )
}

/**
 * Settings → Shifts & tips — mockup 25 (table) / 25b (edit modal) / 24
 * (manual punch modal), spec §9.
 *
 * Gates on `punches.viewAll` OR `tips.viewAll` rather than one fixed key —
 * the two are granted independently (a Supervisor's role defaults carry
 * `tips.viewAll` without `punches.viewAll` — permissions/defaults.ts). Every
 * row/field-level edit affordance is gated again, individually, on
 * `punches.edit` / `tips.edit` plus the below-level rule — CLAUDE.md's
 * "hide what a viewer can't use," not the real security boundary (the
 * Cloud Functions are).
 */
export function ShiftsAndTipsPage(): JSX.Element {
  const { status, can } = useAuth()
  const { t } = useTranslation()

  if (status === 'loading') return <FullPageMessage title={t('app.loading')} />
  if (!can('punches.viewAll') && !can('tips.viewAll')) {
    return <FullPageMessage title={t('auth.noPermissionTitle')} body={t('auth.noPermissionBody')} />
  }
  return <ShiftsAndTipsScreen />
}

function ShiftsAndTipsScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()
  const { employee: actor, can, canAccess } = useAuth()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [roleMap, setRoleMap] = useState<Map<string, ShiftRole>>(new Map())
  const [punches, setPunches] = useState<Punch[]>([])
  const [tipReports, setTipReports] = useState<TipReport[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const [startDate, setStartDate] = useState(() => addDaysToIsoDate(todayIsoRestaurant(), -13))
  const [endDate, setEndDate] = useState(() => todayIsoRestaurant())
  const [employeeFilter, setEmployeeFilter] = useState(ALL)
  const [departmentFilter, setDepartmentFilter] = useState(ALL)
  const [search, setSearch] = useState('')
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const [page, setPage] = useState(0)

  const [manualPunchOpen, setManualPunchOpen] = useState(false)
  const [manualPunchPrefill, setManualPunchPrefill] = useState<{ employeeId: string; date: string } | undefined>(
    undefined,
  )
  const [editingRow, setEditingRow] = useState<PunchRow | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const [people, roles, punchList, tipList] = await Promise.all([
        listEmployees(),
        getShiftRoleMap(),
        listPunchesInRange(startDate, endDate),
        listTipReportsInRange(startDate, endDate),
      ])
      setEmployees(people)
      setRoleMap(roles)
      setPunches(punchList)
      setTipReports(tipList)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [startDate, endDate])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setPage(0)
  }, [employeeFilter, departmentFilter, search, flaggedOnly, startDate, endDate])

  const employeesById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])
  const tipsRequiredIds = useMemo(
    () => new Set(employees.filter((e) => e.tipsRequired).map((e) => e.id)),
    [employees],
  )

  const allRows = useMemo(
    () => buildPunchRows(punches, tipReports, punchLocalDate, tipsRequiredIds),
    [punches, tipReports, tipsRequiredIds],
  )

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return allRows
      .filter((r) => {
        const emp = employeesById.get(r.employeeId)
        if (!emp) return false
        if (employeeFilter !== ALL && r.employeeId !== employeeFilter) return false
        if (departmentFilter !== ALL && emp.department !== departmentFilter) return false
        if (needle && !displayName(emp).toLowerCase().includes(needle)) return false
        if (flaggedOnly && !rowHasFlag(r)) return false
        return true
      })
      .sort((a, b) => {
        const byDate = a.date.localeCompare(b.date)
        if (byDate !== 0) return byDate
        const nameA = displayName(employeesById.get(a.employeeId)!)
        const nameB = displayName(employeesById.get(b.employeeId)!)
        return nameA.localeCompare(nameB)
      })
  }, [allRows, employeesById, employeeFilter, departmentFilter, search, flaggedOnly])

  const flaggedCountInRange = useMemo(() => allRows.filter(rowHasFlag).length, [allRows])

  const stats = useMemo(() => {
    let punchDocCount = 0
    let hours = 0
    let tips = 0
    let flaggedCount = 0
    for (const r of filteredRows) {
      if (r.inPunch) punchDocCount += 1
      if (r.outPunch) punchDocCount += 1
      if (r.inPunch && r.outPunch) {
        const inD = toDate(r.inPunch.timestamp)
        const outD = toDate(r.outPunch.timestamp)
        if (inD && outD) hours += hoursBetween(inD, outD)
      }
      if (r.tipReport) tips += r.tipReport.amount
      if (rowHasFlag(r)) flaggedCount += 1
    }
    return { punchDocCount, hours, tips, flaggedCount }
  }, [filteredRows])

  const pageRows = filteredRows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const hasNext = (page + 1) * PAGE_SIZE < filteredRows.length

  const eligibleEmployees = useMemo(
    () =>
      employees.filter(
        (e) => e.status === 'active' && canAccess({ id: e.id, accessRole: e.accessRole }),
      ),
    [employees, canAccess],
  )

  const actorName = actor ? displayName(actor) : ''
  const canEditPunches = can('punches.edit')
  const canEditTips = can('tips.edit')

  function clearFilters(): void {
    setEmployeeFilter(ALL)
    setDepartmentFilter(ALL)
    setSearch('')
    setFlaggedOnly(false)
  }
  const filtersApplied =
    employeeFilter !== ALL || departmentFilter !== ALL || search.trim() !== '' || flaggedOnly

  function openManualPunch(prefill?: { employeeId: string; date: string }): void {
    setManualPunchPrefill(prefill)
    setManualPunchOpen(true)
  }

  function handleExportCsv(): void {
    const csvRows = filteredRows.map((r) => {
      const emp = employeesById.get(r.employeeId)
      const inDate = r.inPunch ? toDate(r.inPunch.timestamp) : null
      const outDate = r.outPunch ? toDate(r.outPunch.timestamp) : null
      const hours = inDate && outDate ? hoursBetween(inDate, outDate) : null
      return {
        [t('shiftsAndTips.csv.employee')]: emp ? displayName(emp) : r.employeeId,
        [t('shiftsAndTips.csv.date')]: r.date,
        [t('shiftsAndTips.csv.clockIn')]: inDate ? timeLabel(inDate, lang) : '',
        [t('shiftsAndTips.csv.clockOut')]: outDate ? timeLabel(outDate, lang) : '',
        [t('shiftsAndTips.csv.hours')]: hours !== null ? hours.toFixed(2) : '',
        [t('shiftsAndTips.csv.tips')]: r.tipReport ? r.tipReport.amount.toFixed(2) : '',
        [t('shiftsAndTips.csv.flags')]: rowFlagBadges(r, employeesById, t)
          .map((f) => f.label)
          .join('; '),
      }
    })
    const csv = Papa.unparse(csvRows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `shifts-and-tips_${startDate}_${endDate}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">{t('shiftsAndTips.title')}</h1>
          <p className="mt-0.5 text-meta text-ink-muted">{t('shiftsAndTips.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={handleExportCsv}>{t('shiftsAndTips.exportCsv')}</Button>
          {canEditPunches ? (
            <Button variant="primary" onClick={() => openManualPunch()}>
              {t('shiftsAndTips.addManualPunch')}
            </Button>
          ) : null}
        </div>
      </div>

      <FilterBar className="mb-6">
        <FilterSelect
          label={t('filters.employee')}
          value={employeeFilter}
          onChange={setEmployeeFilter}
          options={[
            { value: ALL, label: t('shiftsAndTips.filters.employeeAll') },
            ...employees.map((e) => ({ value: e.id, label: displayName(e) })),
          ]}
        />
        <div className="flex items-center gap-2">
          <label className="text-chip font-medium text-ink-muted" htmlFor="shifts-and-tips-start">
            {t('shiftsAndTips.filters.from')}
          </label>
          <input
            id="shifts-and-tips-start"
            type="date"
            value={startDate}
            max={endDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="h-8 rounded-md border border-line bg-page px-2 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <label className="text-chip font-medium text-ink-muted" htmlFor="shifts-and-tips-end">
            {t('shiftsAndTips.filters.to')}
          </label>
          <input
            id="shifts-and-tips-end"
            type="date"
            value={endDate}
            min={startDate}
            max={todayIsoRestaurant()}
            onChange={(e) => setEndDate(e.target.value)}
            className="h-8 rounded-md border border-line bg-page px-2 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <FilterSelect
          label={t('filters.department')}
          value={departmentFilter}
          onChange={setDepartmentFilter}
          options={[
            { value: ALL, label: t('shiftsAndTips.filters.departmentAll') },
            ...DEPARTMENTS.map((d) => ({ value: d, label: t(`departments.${d}`) })),
          ]}
        />
        <SearchInput value={search} onChange={setSearch} placeholder={t('shiftsAndTips.filters.searchPlaceholder')} />

        <label className="ml-auto flex items-center gap-2 text-meta font-medium text-ink">
          {t('shiftsAndTips.filters.flaggedOnly')}
          {flaggedCountInRange > 0 ? (
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-warning-tint text-chip font-bold text-warning">
              {flaggedCountInRange}
            </span>
          ) : null}
          <input
            type="checkbox"
            checked={flaggedOnly}
            onChange={(e) => setFlaggedOnly(e.target.checked)}
            className="h-5 w-5 rounded border-line text-primary focus:ring-primary"
          />
        </label>
      </FilterBar>

      <div className="mb-6 grid grid-cols-4 gap-4">
        <StatTile label={t('shiftsAndTips.stats.punches')} value={String(stats.punchDocCount)} />
        <StatTile label={t('shiftsAndTips.stats.totalHours')} value={stats.hours.toFixed(1)} />
        <StatTile label={t('shiftsAndTips.stats.totalTips')} value={formatCurrency(stats.tips, lang)} />
        <StatTile label={t('shiftsAndTips.stats.flagged')} value={String(stats.flaggedCount)} warn={stats.flaggedCount > 0} />
      </div>

      {loading ? (
        <>
          <p className="sr-only" role="status">
            {t('app.loading')}
          </p>
          <Table>
            <RowsHeader t={t} />
            {[0, 1, 2].map((i) => (
              <TableRow key={i}>
                <TableCell className="w-[110px]">
                  <span className="h-3 w-20 animate-skeleton rounded bg-app" />
                </TableCell>
                <TableCell className="w-[220px]">
                  <span className="h-7 w-7 animate-skeleton rounded-full bg-app" />
                  <span className="h-3 w-32 animate-skeleton rounded bg-app" />
                </TableCell>
                <TableCell className="w-[110px]">
                  <span className="h-3 w-16 animate-skeleton rounded bg-app" />
                </TableCell>
                <TableCell className="w-[110px]">
                  <span className="h-3 w-16 animate-skeleton rounded bg-app" />
                </TableCell>
                <TableCell className="w-20">
                  <span className="h-3 w-12 animate-skeleton rounded bg-app" />
                </TableCell>
                <TableCell className="w-20">
                  <span className="h-3 w-12 animate-skeleton rounded bg-app" />
                </TableCell>
                <TableCell className="flex-1" />
                <TableCell className="w-10" />
              </TableRow>
            ))}
          </Table>
        </>
      ) : loadError ? (
        <EmptyState
          illustration="search"
          title={t('shiftsAndTips.errorTitle')}
          body={t('shiftsAndTips.errorBody')}
          action={<Button onClick={() => void load()}>{t('common.retry')}</Button>}
        />
      ) : filteredRows.length === 0 ? (
        <EmptyState
          illustration={filtersApplied ? 'search' : 'calendar'}
          title={filtersApplied ? t('empty.noResults') : t('shiftsAndTips.emptyTitle')}
          body={filtersApplied ? t('empty.noResultsBody') : t('shiftsAndTips.emptyBody')}
          action={filtersApplied ? <Button onClick={clearFilters}>{t('common.clearFilters')}</Button> : undefined}
        />
      ) : (
        <>
          <Table>
            <RowsHeader t={t} />
            {pageRows.map((row) => {
              const emp = employeesById.get(row.employeeId)
              if (!emp) return null
              const inDate = row.inPunch ? toDate(row.inPunch.timestamp) : null
              const outDate = row.outPunch ? toDate(row.outPunch.timestamp) : null
              const hours = inDate && outDate ? hoursBetween(inDate, outDate) : null
              const flags = rowFlagBadges(row, employeesById, t)
              const target = { id: emp.id, accessRole: emp.accessRole }
              const canEditThis = canAccess(target) && (canEditPunches || canEditTips)
              const canAddClockOut = !row.outPunch && canAccess(target) && canEditPunches

              const menuItems: { label: string; onClick: () => void }[] = []
              if (canEditThis) {
                menuItems.push({ label: t('shiftsAndTips.rowMenu.edit'), onClick: () => setEditingRow(row) })
              }
              if (canAddClockOut) {
                menuItems.push({
                  label: t('shiftsAndTips.rowMenu.addManualClockOut'),
                  onClick: () => openManualPunch({ employeeId: row.employeeId, date: row.date }),
                })
              }

              return (
                <TableRow key={row.key} className={flags.length > 0 ? 'bg-warning-tint/30' : ''}>
                  <TableCell className="w-[110px]">
                    <span className="text-meta text-ink">
                      {formatDate(dateFromIso(row.date), { weekday: 'short', month: 'short', day: 'numeric' }, lang)}
                    </span>
                  </TableCell>
                  <TableCell className="w-[220px]">
                    <Avatar firstName={emp.firstName} lastName={emp.lastName} photoUrl={emp.photoUrl} size={28} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-meta font-semibold text-ink">{displayName(emp)}</span>
                      <span className="truncate text-chip text-ink-muted">
                        {roleLabel(emp, roleMap, lang, (level) => t('people.levelShort', { level }))}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="w-[110px]">
                    <span className="tabular text-meta font-semibold text-ink">{timeLabel(inDate, lang)}</span>
                  </TableCell>
                  <TableCell className="w-[110px]">
                    <span className="tabular text-meta font-semibold text-ink">
                      {row.outPunch ? timeLabel(outDate, lang) : t('shiftsAndTips.stillClockedIn')}
                    </span>
                  </TableCell>
                  <TableCell className="w-20">
                    <span className="tabular text-meta text-ink">{hours !== null ? `${hours.toFixed(1)} hrs` : '—'}</span>
                  </TableCell>
                  <TableCell className="w-20">
                    <span className="tabular text-meta text-ink">
                      {row.tipReport ? formatCurrency(row.tipReport.amount, lang) : '—'}
                    </span>
                  </TableCell>
                  <TableCell className="flex-1">
                    <span className="flex flex-wrap gap-1">
                      {flags.map((f) => (
                        <Pill key={f.kind} tone={f.tone}>
                          {f.label}
                        </Pill>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell className="w-10" align="right">
                    {menuItems.length > 0 ? <KebabMenu items={menuItems} /> : null}
                  </TableCell>
                </TableRow>
              )
            })}
          </Table>

          <div className="mt-3 flex items-center justify-between">
            <p className="tabular text-chip text-ink-muted">
              {t('shiftsAndTips.count', { shown: pageRows.length, total: filteredRows.length })}
            </p>
            <div className="flex items-center gap-2">
              <Button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
                {t('shiftsAndTips.previous')}
              </Button>
              <Button onClick={() => setPage((p) => p + 1)} disabled={!hasNext}>
                {t('shiftsAndTips.next')}
              </Button>
            </div>
          </div>
        </>
      )}

      <ManualPunchModal
        open={manualPunchOpen}
        eligibleEmployees={eligibleEmployees}
        roleMap={roleMap}
        defaultDate={manualPunchPrefill?.date ?? todayIsoRestaurant()}
        initialEmployeeId={manualPunchPrefill?.employeeId}
        actorName={actorName}
        onClose={() => setManualPunchOpen(false)}
        onCreated={() => {
          toast.show({ tone: 'success', message: t('shiftsAndTips.toast.manualPunchAdded') })
          void load()
        }}
      />

      <PunchEditModal
        row={editingRow}
        employee={editingRow ? employeesById.get(editingRow.employeeId) ?? null : null}
        employeesById={employeesById}
        actorName={actorName}
        canEditTimes={canEditPunches}
        canEditTips={canEditTips}
        onClose={() => setEditingRow(null)}
        onSaved={() => {
          toast.show({ tone: 'success', message: t('shiftsAndTips.toast.punchUpdated') })
          void load()
        }}
      />
    </div>
  )
}

function StatTile({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-card border border-line bg-page p-4">
      <p className={`tabular text-title-lg font-semibold ${warn ? 'text-warning' : 'text-ink'}`}>{value}</p>
      <p className="text-chip text-ink-muted">{label}</p>
    </div>
  )
}

function RowsHeader({ t }: { t: TFunction }) {
  return (
    <TableHead>
      <TableCell className="w-[110px]">{t('shiftsAndTips.columns.date')}</TableCell>
      <TableCell className="w-[220px]">{t('shiftsAndTips.columns.employee')}</TableCell>
      <TableCell className="w-[110px]">{t('shiftsAndTips.columns.clockIn')}</TableCell>
      <TableCell className="w-[110px]">{t('shiftsAndTips.columns.clockOut')}</TableCell>
      <TableCell className="w-20">{t('shiftsAndTips.columns.hours')}</TableCell>
      <TableCell className="w-20">{t('shiftsAndTips.columns.tips')}</TableCell>
      <TableCell className="flex-1">{t('shiftsAndTips.columns.flags')}</TableCell>
      <TableCell className="w-10" />
    </TableHead>
  )
}

export default ShiftsAndTipsPage
