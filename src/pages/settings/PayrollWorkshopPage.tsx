import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { Avatar, Button, EmptyState, Modal, Pill, Table, TableCell, TableHead, TableRow, useToast } from '@/components/ui'
import type { PillTone } from '@/components/ui'
import { useAuth } from '@/lib/auth/AuthProvider'
import { listPayPeriods } from '@/lib/db'
import { formatCurrency, formatDate, formatHours } from '@/lib/format'
import { centsToDollars } from '@/lib/money'
import {
  downloadCsv,
  exportPayPeriodCsv,
  lockPayPeriod,
  unlockPayPeriod,
  PayrollActionRejected,
  type CsvVariant,
} from '@/lib/payroll/payrollActions'
import type { PayPeriod, PayPeriodStatus } from '@/types/models'

import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, LockIcon } from './payrollIcons'
import { displayName, dateFromIso } from './shiftsAndTipsShared'
import { payrollActionErrorMessage, payrollExportErrorMessage } from './payrollWorkshopErrors'
import { usePayrollWorkshopData, type PayrollWorkshopRow } from './usePayrollWorkshopData'

type WorkshopView = 'period' | 'workweek'

const CSV_VARIANTS: readonly CsvVariant[] = ['generic', 'gusto', 'adp']

const STATUS_TONE: Record<PayPeriodStatus, PillTone> = {
  open: 'neutral',
  review: 'pending',
  locked: 'published',
  exported: 'approved',
}

function FullPageMessage({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <h1 className="text-section font-semibold text-ink">{title}</h1>
      {body ? <p className="mt-2 max-w-sm text-meta text-ink-muted">{body}</p> : null}
    </div>
  )
}

function employmentTypeTone(type: PayrollWorkshopRow['row']['employmentType']): PillTone {
  return type === 'salaried-weekly' || type === 'salaried-monthly' ? 'published' : 'draft'
}

/**
 * Settings → Payroll workshop — spec §11, mockup 26. Gated on `payroll.view`
 * (Owner/GM only per the matrix, Rafa's ruling tightened Manager off this
 * key) — same self-guard shape `ShiftsAndTipsPage` already uses rather than
 * a route-level `RequirePermission` wrapper, since this page's guard needs
 * `status === 'loading'` handled specially too.
 *
 * Mockup 26 draws a "Week N labor is $X at Y% of $Z in sales" line under the
 * stat tiles — omitted here on purpose: sales figures come from a POS, and
 * spec §20 makes POS integration a v1 non-goal. Building that line would mean
 * fabricating a number this app has no real source for; PROGRESS.md's own
 * "accepted spec deviations" note already covers mockup 26's dollar figures
 * as illustrative rather than binding, and this is the same class of gap.
 */
export function PayrollWorkshopPage(): JSX.Element {
  const { status, can } = useAuth()
  const { t } = useTranslation()

  if (status === 'loading') return <FullPageMessage title={t('app.loading')} />
  if (!can('payroll.view')) {
    return <FullPageMessage title={t('auth.noPermissionTitle')} body={t('auth.noPermissionBody')} />
  }
  return <PayrollWorkshopScreen />
}

function PayrollWorkshopScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()
  const { employee: actor, can } = useAuth()

  const [periods, setPeriods] = useState<PayPeriod[]>([])
  const [periodsLoading, setPeriodsLoading] = useState(true)
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null)
  const [view, setView] = useState<WorkshopView>('period')
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [lockBusy, setLockBusy] = useState(false)
  const [unlockModalOpen, setUnlockModalOpen] = useState(false)
  const [unlockReason, setUnlockReason] = useState('')
  const [unlockBusy, setUnlockBusy] = useState(false)
  const [draftConfirm, setDraftConfirm] = useState<{ csv: string; fileName: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    setPeriodsLoading(true)
    void listPayPeriods().then((list) => {
      if (cancelled) return
      setPeriods(list)
      setPeriodsLoading(false)
      setSelectedPeriodId((current) => current ?? list[0]?.id ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const { loading, loadError, period, payPeriodFrequency, rows, reload } = usePayrollWorkshopData(selectedPeriodId, actor)

  const selectedIndex = useMemo(
    () => periods.findIndex((p) => p.id === selectedPeriodId),
    [periods, selectedPeriodId],
  )
  const periodOrdinal = useMemo(() => {
    const ascending = [...periods].sort((a, b) => a.startDate.localeCompare(b.startDate))
    const index = ascending.findIndex((p) => p.id === selectedPeriodId)
    return { index: index + 1, total: ascending.length }
  }, [periods, selectedPeriodId])

  const canLock = can('payroll.lockPeriod')
  const canExport = can('payroll.export')
  const canUnlock = canLock && (actor?.accessRole === 'owner' || actor?.accessRole === 'gm')

  const totals = useMemo(() => {
    let regularHours = 0
    let otHours = 0
    let hourlyGrossCents = 0
    let tipsCents = 0
    let salaryCents = 0
    let grossCents = 0
    for (const r of rows) {
      regularHours += r.row.regularHours
      otHours += r.row.otHours
      hourlyGrossCents += r.row.hourlyGrossCents
      tipsCents += r.row.tipsCents
      salaryCents += r.row.salaryAmountCents ?? 0
      grossCents += r.row.grossCents
    }
    return { regularHours, otHours, hourlyGrossCents, tipsCents, salaryCents, grossCents }
  }, [rows])

  function stepPeriod(delta: number): void {
    const next = periods[selectedIndex + delta]
    if (next) setSelectedPeriodId(next.id)
  }

  async function handleLock(): Promise<void> {
    if (!period) return
    setLockBusy(true)
    try {
      await lockPayPeriod(period.id)
      toast.show({ tone: 'success', message: t('settings.payroll.toast.locked') })
      await reload()
    } catch (err) {
      toast.show({ tone: 'error', message: payrollActionErrorMessage(t, err, 'lock') })
    } finally {
      setLockBusy(false)
    }
  }

  function openUnlockModal(): void {
    setUnlockReason('')
    setUnlockModalOpen(true)
  }

  async function handleUnlock(): Promise<void> {
    if (!period) return
    const reason = unlockReason.trim()
    if (!reason) return
    setUnlockBusy(true)
    try {
      await unlockPayPeriod(period.id, reason)
      toast.show({ tone: 'success', message: t('settings.payroll.toast.unlocked') })
      setUnlockModalOpen(false)
      await reload()
    } catch (err) {
      toast.show({ tone: 'error', message: payrollActionErrorMessage(t, err, 'unlock') })
    } finally {
      setUnlockBusy(false)
    }
  }

  async function handleExport(variant: CsvVariant): Promise<void> {
    if (!period) return
    setExportMenuOpen(false)
    setExportBusy(true)
    try {
      const result = await exportPayPeriodCsv(period.id, variant)
      if (result.isDraft) {
        setDraftConfirm({ csv: result.csv, fileName: result.fileName })
      } else {
        downloadCsv(result.fileName, result.csv)
        toast.show({ tone: 'success', message: t('settings.payroll.toast.exported') })
      }
      await reload()
    } catch (err) {
      const message =
        err instanceof PayrollActionRejected ? payrollExportErrorMessage(t, err) : t('settings.payroll.errors.generic')
      toast.show({ tone: 'error', message })
    } finally {
      setExportBusy(false)
    }
  }

  function confirmDraftDownload(): void {
    if (!draftConfirm) return
    downloadCsv(draftConfirm.fileName, draftConfirm.csv)
    toast.show({ tone: 'success', message: t('settings.payroll.toast.exported') })
    setDraftConfirm(null)
  }

  const weekLabel = (start: string, end: string): string =>
    `${formatDate(dateFromIso(start), { month: 'short', day: 'numeric' }, lang)} – ${formatDate(dateFromIso(end), { month: 'short', day: 'numeric' }, lang)}`

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6">
        <h1 className="text-title-lg font-semibold tracking-tight text-ink">{t('settings.payroll.title')}</h1>
        <p className="mt-0.5 text-meta text-ink-muted">{t('settings.payroll.subtitle')}</p>
      </div>

      {periodsLoading ? (
        <p className="sr-only" role="status">
          {t('app.loading')}
        </p>
      ) : periods.length === 0 ? (
        <EmptyState illustration="calendar" title={t('settings.payroll.noPeriodsTitle')} body={t('settings.payroll.noPeriodsBody')} />
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-card border border-line bg-page p-4">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-3 rounded-card-lg border border-line px-4 py-2">
                <button
                  type="button"
                  onClick={() => stepPeriod(1)}
                  disabled={selectedIndex < 0 || selectedIndex >= periods.length - 1}
                  aria-label={t('settings.payroll.previousPeriod')}
                  className="text-ink-muted hover:text-ink disabled:opacity-30"
                >
                  <ChevronLeftIcon className="h-4 w-4" />
                </button>
                <div className="flex flex-col items-center">
                  {period ? (
                    <>
                      <span className="text-meta font-semibold text-ink">
                        {formatDate(dateFromIso(period.startDate), { month: 'short', day: 'numeric' }, lang)}
                        {' – '}
                        {formatDate(dateFromIso(period.endDate), { month: 'short', day: 'numeric', year: 'numeric' }, lang)}
                      </span>
                      <span className="text-chip text-ink-muted">
                        {t('settings.payroll.periodOrdinal', {
                          frequency: t(`settings.payroll.frequency.${payPeriodFrequency}`),
                          index: periodOrdinal.index,
                          total: periodOrdinal.total,
                        })}
                      </span>
                    </>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => stepPeriod(-1)}
                  disabled={selectedIndex <= 0}
                  aria-label={t('settings.payroll.nextPeriod')}
                  className="text-ink-muted hover:text-ink disabled:opacity-30"
                >
                  <ChevronRightIcon className="h-4 w-4" />
                </button>
              </div>
              <select
                aria-label={t('settings.payroll.selectPeriod')}
                value={selectedPeriodId ?? ''}
                onChange={(e) => setSelectedPeriodId(e.target.value)}
                className="h-9 rounded-md border border-line bg-page px-2 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {periods.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.startDate} – {p.endDate} ({t(`settings.payroll.status.${p.status}`)})
                  </option>
                ))}
              </select>
              {period ? <Pill tone={STATUS_TONE[period.status]}>{t(`settings.payroll.status.${period.status}`)}</Pill> : null}
            </div>

            <div className="flex items-center gap-2">
              {canLock && period && (period.status === 'open' || period.status === 'review') ? (
                <Button onClick={() => void handleLock()} disabled={lockBusy} icon={<LockIcon className="h-4 w-4 text-ink-muted" />}>
                  {t('settings.payroll.lockPeriod')}
                </Button>
              ) : null}
              {canUnlock && period && period.status === 'locked' ? (
                <Button onClick={openUnlockModal}>{t('settings.payroll.unlockPeriod')}</Button>
              ) : null}
              {canExport && period ? (
                <div className="relative">
                  <div className="flex items-center">
                    <Button
                      className="rounded-r-none border-r-0"
                      disabled={exportBusy}
                      onClick={() => void handleExport('generic')}
                    >
                      {t('settings.payroll.exportCsv')}
                    </Button>
                    <Button
                      className="rounded-l-none px-2"
                      disabled={exportBusy}
                      aria-label={t('settings.payroll.exportOptions')}
                      onClick={() => setExportMenuOpen((v) => !v)}
                    >
                      <ChevronDownIcon className="h-4 w-4" />
                    </Button>
                  </div>
                  {exportMenuOpen ? (
                    <div className="absolute right-0 top-11 z-20 flex w-60 flex-col gap-0.5 rounded-card border border-line bg-page p-1.5 shadow-elevated">
                      {CSV_VARIANTS.map((variant) => (
                        <button
                          key={variant}
                          type="button"
                          disabled={exportBusy}
                          onClick={() => void handleExport(variant)}
                          className="rounded-control px-3 py-2 text-left transition-colors duration-hover hover:bg-app"
                        >
                          <div className="text-meta font-semibold text-ink">{t(`settings.payroll.exportVariant.${variant}.title`)}</div>
                          <div className="text-chip text-ink-muted">{t(`settings.payroll.exportVariant.${variant}.subtitle`)}</div>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="mb-6 grid grid-cols-5 gap-4">
            <StatTile label={t('settings.payroll.stats.employees')} value={String(rows.length)} />
            <StatTile label={t('settings.payroll.stats.regularHours')} value={formatHours(totals.regularHours, lang)} />
            <StatTile label={t('settings.payroll.stats.overtimeHours')} value={formatHours(totals.otHours, lang)} />
            <StatTile label={t('settings.payroll.stats.tips')} value={formatCurrency(centsToDollars(totals.tipsCents), lang)} />
            <StatTile
              label={t('settings.payroll.stats.totalGross')}
              value={formatCurrency(centsToDollars(totals.grossCents), lang)}
            />
          </div>

          <div className="mb-4 inline-flex rounded-control border border-line bg-page p-1">
            <button
              type="button"
              onClick={() => setView('period')}
              className={[
                'rounded-control px-3 py-1.5 text-meta font-medium transition-colors duration-hover',
                view === 'period' ? 'bg-primary text-white' : 'text-ink-muted hover:text-ink',
              ].join(' ')}
            >
              {t('settings.payroll.view.perPeriod')}
            </button>
            <button
              type="button"
              onClick={() => setView('workweek')}
              className={[
                'rounded-control px-3 py-1.5 text-meta font-medium transition-colors duration-hover',
                view === 'workweek' ? 'bg-primary text-white' : 'text-ink-muted hover:text-ink',
              ].join(' ')}
            >
              {t('settings.payroll.view.perWorkweek')}
            </button>
          </div>

          {loading ? (
            <p className="sr-only" role="status">
              {t('app.loading')}
            </p>
          ) : loadError ? (
            <EmptyState
              illustration="search"
              title={t('settings.payroll.errorTitle')}
              body={t('settings.payroll.errorBody')}
              action={<Button onClick={() => void reload()}>{t('common.retry')}</Button>}
            />
          ) : rows.length === 0 ? (
            <EmptyState illustration="calendar" title={t('settings.payroll.emptyTitle')} body={t('settings.payroll.emptyBody')} />
          ) : view === 'period' ? (
            <PeriodTable rows={rows} totals={totals} t={t} lang={lang} />
          ) : (
            <WorkweekTable rows={rows} t={t} lang={lang} weekLabel={weekLabel} />
          )}
        </>
      )}

      <Modal
        open={unlockModalOpen}
        onClose={() => setUnlockModalOpen(false)}
        title={t('settings.payroll.unlockModal.title')}
        subtitle={t('settings.payroll.unlockModal.subtitle')}
        footer={
          <>
            <Button onClick={() => setUnlockModalOpen(false)}>{t('settings.payroll.unlockModal.cancel')}</Button>
            <Button
              variant="primary"
              disabled={unlockBusy || unlockReason.trim() === ''}
              onClick={() => void handleUnlock()}
            >
              {t('settings.payroll.unlockModal.confirm')}
            </Button>
          </>
        }
      >
        <label className="mb-1 block text-meta font-medium text-ink" htmlFor="payroll-unlock-reason">
          {t('settings.payroll.unlockModal.reasonLabel')}
        </label>
        <textarea
          id="payroll-unlock-reason"
          value={unlockReason}
          onChange={(e) => setUnlockReason(e.target.value)}
          rows={3}
          placeholder={t('settings.payroll.unlockModal.reasonPlaceholder')}
          className="w-full rounded-md border border-line bg-page p-2 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </Modal>

      <Modal
        open={draftConfirm !== null}
        onClose={() => setDraftConfirm(null)}
        title={t('settings.payroll.draftExportConfirm.title')}
        footer={
          <>
            <Button onClick={() => setDraftConfirm(null)}>{t('settings.payroll.draftExportConfirm.cancel')}</Button>
            <Button variant="primary" onClick={confirmDraftDownload}>
              {t('settings.payroll.draftExportConfirm.continue')}
            </Button>
          </>
        }
      >
        <p>{t('settings.payroll.draftExportConfirm.body')}</p>
      </Modal>
    </div>
  )
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-line bg-page p-4">
      <p className="tabular text-title-lg font-semibold text-ink">{value}</p>
      <p className="text-chip text-ink-muted">{label}</p>
    </div>
  )
}

function HoursCell({
  hours,
  isOt,
  accountabilityOnly,
  doesNotClock,
  t,
  lang,
}: {
  hours: number
  isOt: boolean
  accountabilityOnly: boolean
  doesNotClock: boolean
  t: TFunction
  lang: string
}) {
  if (doesNotClock) {
    return (
      <span className="flex flex-col items-end">
        <span className="text-ink-muted/40">{'—'}</span>
        <span className="text-chip leading-none text-ink-muted">{t('settings.payroll.doesNotClock')}</span>
      </span>
    )
  }
  if (accountabilityOnly) {
    return (
      <span className="flex flex-col items-end opacity-45">
        <span className="tabular text-meta">{formatHours(hours, lang)}</span>
        <span className="text-chip italic leading-none text-ink-muted">{t('settings.payroll.accountabilityOnly')}</span>
      </span>
    )
  }
  return (
    <span
      className={[
        'tabular text-meta',
        isOt && hours > 0 ? 'rounded bg-warning-tint px-1 font-bold text-warning' : hours === 0 ? 'text-ink-muted' : 'text-ink',
      ].join(' ')}
    >
      {formatHours(hours, lang)}
    </span>
  )
}

function PeriodTable({
  rows,
  totals,
  t,
  lang,
}: {
  rows: PayrollWorkshopRow[]
  totals: { regularHours: number; otHours: number; hourlyGrossCents: number; tipsCents: number; salaryCents: number; grossCents: number }
  t: TFunction
  lang: string
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHead>
          <TableCell className="w-[80px]">{t('settings.payroll.columns.empNumber')}</TableCell>
          <TableCell className="w-[220px]">{t('settings.payroll.columns.name')}</TableCell>
          <TableCell className="w-[140px]">{t('settings.payroll.columns.type')}</TableCell>
          <TableCell className="w-24" align="right">{t('settings.payroll.columns.regHours')}</TableCell>
          <TableCell className="w-24" align="right">{t('settings.payroll.columns.otHours')}</TableCell>
          <TableCell className="w-24" align="right">{t('settings.payroll.columns.rate')}</TableCell>
          <TableCell className="w-28" align="right">{t('settings.payroll.columns.hourlyGross')}</TableCell>
          <TableCell className="w-24" align="right">{t('settings.payroll.columns.tips')}</TableCell>
          <TableCell className="w-24" align="right">{t('settings.payroll.columns.salary')}</TableCell>
          <TableCell className="w-28" align="right">{t('settings.payroll.columns.total')}</TableCell>
          <TableCell className="w-10" />
        </TableHead>
        {rows.map(({ employee, row }) => {
            const nonClocking = employee.employmentType === 'non-clocking'
            return (
              <TableRow key={employee.id}>
                <TableCell className="w-[80px]">
                  <span className="tabular text-meta text-ink">{employee.employeeNumber}</span>
                </TableCell>
                <TableCell className="w-[220px]">
                  <Avatar firstName={employee.firstName} lastName={employee.lastName} photoUrl={employee.photoUrl} size={24} />
                  <span className="truncate text-meta font-medium text-ink">{displayName(employee)}</span>
                </TableCell>
                <TableCell className="w-[140px]">
                  <Pill tone={employmentTypeTone(employee.employmentType)}>{t(`employmentTypes.${row.employmentType}`)}</Pill>
                </TableCell>
                <TableCell className="w-24" align="right">
                  <HoursCell
                    hours={row.regularHours}
                    isOt={false}
                    accountabilityOnly={row.accountabilityOnly && !nonClocking}
                    doesNotClock={nonClocking}
                    t={t}
                    lang={lang}
                  />
                </TableCell>
                <TableCell className="w-24" align="right">
                  <HoursCell
                    hours={row.otHours}
                    isOt
                    accountabilityOnly={row.accountabilityOnly && !nonClocking}
                    doesNotClock={nonClocking}
                    t={t}
                    lang={lang}
                  />
                </TableCell>
                <TableCell className="w-24" align="right">
                  <span className="tabular text-meta text-ink">
                    {row.hourlyRateCents != null ? formatCurrency(centsToDollars(row.hourlyRateCents), lang) : '—'}
                  </span>
                </TableCell>
                <TableCell className="w-28" align="right">
                  <span className="tabular text-meta text-ink">
                    {row.accountabilityOnly ? '—' : formatCurrency(centsToDollars(row.hourlyGrossCents), lang)}
                  </span>
                </TableCell>
                <TableCell className="w-24" align="right">
                  <span className="tabular text-meta text-ink">{formatCurrency(centsToDollars(row.tipsCents), lang)}</span>
                </TableCell>
                <TableCell className="w-24" align="right">
                  <span className="tabular text-meta text-ink">
                    {row.salaryAmountCents != null ? formatCurrency(centsToDollars(row.salaryAmountCents), lang) : '—'}
                  </span>
                </TableCell>
                <TableCell className="w-28" align="right">
                  <span className="tabular text-meta font-semibold text-ink">{formatCurrency(centsToDollars(row.grossCents), lang)}</span>
                </TableCell>
                <TableCell className="w-10" align="right">
                  <Link
                    to="/settings/shifts-and-tips"
                    className="text-chip font-medium text-primary hover:underline"
                    title={t('settings.payroll.drillDown')}
                  >
                    {t('settings.payroll.drillDown')}
                  </Link>
                </TableCell>
              </TableRow>
            )
          })}
          <TableRow className="border-t-2 border-line bg-app hover:bg-app">
            <TableCell className="w-[80px]" />
            <TableCell className="w-[220px]">
              <span className="text-meta font-semibold text-ink">{t('settings.payroll.totals')}</span>
            </TableCell>
            <TableCell className="w-[140px]" />
            <TableCell className="w-24" align="right">
              <span className="tabular text-meta font-semibold text-ink">{formatHours(totals.regularHours, lang)}</span>
            </TableCell>
            <TableCell className="w-24" align="right">
              <span className="tabular text-meta font-semibold text-ink">{formatHours(totals.otHours, lang)}</span>
            </TableCell>
            <TableCell className="w-24" />
            <TableCell className="w-28" align="right">
              <span className="tabular text-meta font-semibold text-ink">{formatCurrency(centsToDollars(totals.hourlyGrossCents), lang)}</span>
            </TableCell>
            <TableCell className="w-24" align="right">
              <span className="tabular text-meta font-semibold text-ink">{formatCurrency(centsToDollars(totals.tipsCents), lang)}</span>
            </TableCell>
            <TableCell className="w-24" align="right">
              <span className="tabular text-meta font-semibold text-ink">{formatCurrency(centsToDollars(totals.salaryCents), lang)}</span>
            </TableCell>
            <TableCell className="w-28" align="right">
              <span className="tabular text-title font-bold text-ink">{formatCurrency(centsToDollars(totals.grossCents), lang)}</span>
            </TableCell>
            <TableCell className="w-10" />
          </TableRow>
      </Table>
    </div>
  )
}

function WorkweekTable({
  rows,
  t,
  lang,
  weekLabel,
}: {
  rows: PayrollWorkshopRow[]
  t: TFunction
  lang: string
  weekLabel: (start: string, end: string) => string
}) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHead>
          <TableCell className="w-[220px]">{t('settings.payroll.columns.name')}</TableCell>
          <TableCell className="w-[160px]">{t('settings.payroll.workweekColumns.week')}</TableCell>
          <TableCell className="w-24" align="right">{t('settings.payroll.columns.regHours')}</TableCell>
          <TableCell className="w-24" align="right">{t('settings.payroll.columns.otHours')}</TableCell>
          <TableCell className="w-28" align="right">{t('settings.payroll.columns.hourlyGross')}</TableCell>
        </TableHead>
        {rows.flatMap(({ employee, row, workweeks }) =>
          workweeks.map((wk) => {
            const nonClocking = employee.employmentType === 'non-clocking'
            return (
              <TableRow key={`${employee.id}-${wk.weekId}`}>
                <TableCell className="w-[220px]">
                  <Avatar firstName={employee.firstName} lastName={employee.lastName} photoUrl={employee.photoUrl} size={24} />
                  <span className="truncate text-meta font-medium text-ink">{displayName(employee)}</span>
                </TableCell>
                <TableCell className="w-[160px]">
                  <span className="text-meta text-ink">{weekLabel(wk.weekStart, wk.weekEnd)}</span>
                </TableCell>
                <TableCell className="w-24" align="right">
                  <HoursCell
                    hours={wk.regularHours}
                    isOt={false}
                    accountabilityOnly={row.accountabilityOnly && !nonClocking}
                    doesNotClock={nonClocking}
                    t={t}
                    lang={lang}
                  />
                </TableCell>
                <TableCell className="w-24" align="right">
                  <HoursCell
                    hours={wk.otHours}
                    isOt
                    accountabilityOnly={row.accountabilityOnly && !nonClocking}
                    doesNotClock={nonClocking}
                    t={t}
                    lang={lang}
                  />
                </TableCell>
                <TableCell className="w-28" align="right">
                  <span className="tabular text-meta text-ink">
                    {row.accountabilityOnly ? '—' : formatCurrency(centsToDollars(wk.hourlyGrossCents), lang)}
                  </span>
                </TableCell>
              </TableRow>
            )
          }),
        )}
      </Table>
    </div>
  )
}

export default PayrollWorkshopPage
