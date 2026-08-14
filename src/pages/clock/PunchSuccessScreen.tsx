import { useTranslation } from 'react-i18next'

import { Avatar, Button } from '@/components/ui'
import { formatCurrency, formatHours } from '@/lib/format'

import { CheckIcon, MapPinIcon } from './icons'

/**
 * Success screens — mockup 21 (clock-in) and 22c (clock-out). One component
 * for both since they share almost every element; `punchType` swaps the copy
 * and which stat row shows. `pendingSync` renders the spec §15 "pending
 * sync" badge in place of the geofence-verified footer when the punch went
 * through the offline queue instead of a live call.
 */
export function PunchSuccessScreen({
  punchType,
  employeeFirstName,
  employeeLastName,
  heroTime,
  clockInTime,
  clockOutTime,
  dateLabel,
  shiftLabel,
  roleLabel,
  station,
  restaurantName,
  clockOutReminder,
  hoursWorked,
  tipsAmount,
  pendingSync,
  onDone,
}: {
  punchType: 'in' | 'out'
  employeeFirstName: string
  employeeLastName: string
  /** Clock-in only — the big centered timestamp. */
  heroTime: string
  /** Clock-out only — the "Clocked in" detail row. */
  clockInTime: string | null
  /** Clock-out only — the "Clocked out" detail row. */
  clockOutTime: string | null
  dateLabel: string
  shiftLabel: string | null
  roleLabel: string | null
  station: string | null
  restaurantName: string
  /** Clock-in only. */
  clockOutReminder: string | null
  /** Clock-out only. */
  hoursWorked: number | null
  /** Clock-out only, tipped employees only. */
  tipsAmount: number | null
  pendingSync: boolean
  onDone: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const displayName = employeeFirstName

  return (
    <div className="flex flex-col items-center">
      <div className="mt-4 flex flex-col items-center">
        <div className="mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-success-tint">
          <CheckIcon className="h-11 w-11 text-success" strokeWidth={4} />
        </div>
        <h1 className="text-title-lg text-center font-semibold leading-tight text-ink">
          {punchType === 'in' ? t('clock.success.inTitle') : t('clock.success.outTitle')}
        </h1>
        <p className="mt-1 text-center text-body text-ink-muted">
          {punchType === 'in'
            ? t('clock.success.inSubtitle', { name: displayName })
            : t('clock.success.outSubtitle', { name: displayName })}
        </p>
      </div>

      {punchType === 'in' ? (
        <div className="mb-10 mt-10 text-center">
          <div className="tabular text-[40px] font-semibold leading-none tracking-tight text-ink">{heroTime}</div>
          <div className="mt-1 text-meta uppercase tracking-wide text-ink-muted">{dateLabel}</div>
        </div>
      ) : null}

      <div className="mb-auto w-full overflow-hidden rounded-card-lg border border-line bg-page">
        {punchType === 'out' ? (
          <div className="grid grid-cols-2 divide-x divide-line p-5">
            <div className="flex flex-col">
              <span className="text-micro font-semibold uppercase tracking-wider text-ink-muted">
                {t('clock.success.hoursWorked')}
              </span>
              <div className="mt-1 flex items-baseline">
                <span className="tabular text-[34px] font-semibold text-ink">
                  {formatHours(hoursWorked ?? 0, i18n.language)}
                </span>
                <span className="ml-1 text-meta text-ink-muted">{t('common.hoursShort')}</span>
              </div>
            </div>
            <div className="flex flex-col pl-5">
              <span className="text-micro font-semibold uppercase tracking-wider text-ink-muted">
                {t('clock.success.tipsReported')}
              </span>
              <div className="mt-1">
                <span className="tabular text-[34px] font-semibold text-ink">
                  {tipsAmount !== null ? formatCurrency(tipsAmount, i18n.language) : '—'}
                </span>
              </div>
            </div>
          </div>
        ) : null}

        <div className={punchType === 'out' ? 'border-t border-line' : 'p-5'}>
          {punchType === 'out' ? <Row label={t('clock.success.date')} value={dateLabel} /> : null}
          {punchType === 'in' && shiftLabel ? <Row label={t('clock.success.shift')} value={shiftLabel} /> : null}
          {punchType === 'out' && clockInTime ? <Row label={t('clock.success.clockedIn')} value={clockInTime} /> : null}
          {punchType === 'out' && clockOutTime ? <Row label={t('clock.success.clockedOut')} value={clockOutTime} /> : null}
          {roleLabel ? (
            <div className="flex items-center justify-between border-b border-line py-3">
              <span className="text-meta font-medium text-ink-muted">{t('clock.success.role')}</span>
              <span className="rounded-full bg-warning-tint px-2.5 py-0.5 text-micro font-bold uppercase tracking-wider text-warning">
                {roleLabel}
              </span>
            </div>
          ) : null}
          {station ? <Row label={t('clock.success.station')} value={station} last /> : null}
        </div>

        <div className="flex items-center justify-between bg-app px-5 py-3">
          <div className="flex items-center gap-1.5">
            <MapPinIcon className={`h-4 w-4 ${pendingSync ? 'text-warning' : 'text-success'}`} />
            <span className="text-chip text-ink-muted">
              {pendingSync
                ? t('clock.success.pendingBadge')
                : punchType === 'in'
                  ? t('clock.success.punchedAt', { name: restaurantName })
                  : t('clock.success.verifiedFooter', { name: restaurantName })}
            </span>
          </div>
          {punchType === 'in' ? (
            <Avatar firstName={employeeFirstName} lastName={employeeLastName} size={32} />
          ) : null}
        </div>
      </div>

      {pendingSync ? (
        <p className="mt-4 text-center text-chip text-ink-muted">{t('clock.success.pendingNote')}</p>
      ) : punchType === 'in' && clockOutReminder ? (
        <p className="mt-6 text-center text-meta text-ink-muted">
          {t('clock.success.reminder', { time: clockOutReminder })}
        </p>
      ) : null}

      <div className="mt-6 w-full space-y-3">
        <Button variant="secondary" size="lg" fullWidth>
          {punchType === 'in' ? t('clock.success.viewShift') : t('clock.success.viewPunches')}
        </Button>
        <button
          type="button"
          onClick={onDone}
          className="flex h-12 w-full items-center justify-center font-semibold text-ink-muted"
        >
          {t('clock.success.done')}
        </button>
      </div>
    </div>
  )
}

function Row({ label, value, last = false }: { label: string; value: string; last?: boolean }): JSX.Element {
  return (
    <div className={`flex items-center justify-between py-3 ${last ? '' : 'border-b border-line'}`}>
      <span className="text-meta font-medium text-ink-muted">{label}</span>
      <span className="tabular text-meta font-semibold text-ink">{value}</span>
    </div>
  )
}
