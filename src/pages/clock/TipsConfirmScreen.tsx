import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { formatCurrency, formatHours } from '@/lib/format'

import { AlertTriangleIcon, ChevronLeftIcon, PencilIcon } from './icons'

/**
 * Tips confirmation — mockup 22b, and its zero-tips variant, mockup 22d
 * ("$0 allowed with confirmation" per spec §8 — a visually distinct screen
 * with extra friction, an explicit checkbox acknowledgement, not just 22b
 * with "0" typed in).
 */
export function TipsConfirmScreen({
  amount,
  clockInTime,
  clockOutTime,
  hours,
  roleLabel,
  onEdit,
  onGoBack,
  onConfirm,
  submitting,
}: {
  amount: number
  clockInTime: string
  clockOutTime: string
  hours: number
  roleLabel: string | null
  onEdit: () => void
  onGoBack: () => void
  onConfirm: () => void
  submitting: boolean
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const isZero = amount === 0
  const [acked, setAcked] = useState(false)

  const canConfirm = !submitting && (!isZero || acked)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-page pl-safe pr-safe">
      <div aria-hidden="true" className="h-safe-top w-full shrink-0 bg-page" />

      <header className="shrink-0 border-b border-line">
        <div className="flex h-[56px] items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <button type="button" onClick={onGoBack} aria-label={t('clock.tips.goBack')} className="-ml-1 p-1 text-ink">
              <ChevronLeftIcon className="h-6 w-6" />
            </button>
            <h1 className="text-section font-semibold text-ink">{t('clock.selfie.titleOut')}</h1>
          </div>
          <span className="text-meta text-ink-muted">{t('clock.selfie.stepOf', { step: 3, total: 3 })}</span>
        </div>
        <div className="flex h-1 w-full bg-line">
          <div className="h-full w-full bg-primary" />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-6 p-4">
          <div className="pt-2 text-center">
            <h2 className="text-section font-semibold text-ink">
              {isZero ? t('clock.tips.zeroTitle') : t('clock.tips.confirmTitle')}
            </h2>
            <p className="mt-1 px-4 text-meta text-ink-muted">
              {isZero ? t('clock.tips.zeroSubtitle') : t('clock.tips.confirmSubtitle')}
            </p>
          </div>

          <div className="rounded-card-lg border border-line bg-page p-7 text-center shadow-sm">
            <span className="mb-1 block text-micro font-bold uppercase tracking-wide text-ink-muted">
              {t('clock.tips.totalLabel')}
            </span>
            <span className="tabular block text-[44px] font-semibold leading-none text-ink">
              {formatCurrency(amount, i18n.language)}
            </span>
            <button
              type="button"
              onClick={onEdit}
              className="mt-4 inline-flex items-center gap-1.5 text-meta font-semibold text-primary"
            >
              <PencilIcon className="h-3.5 w-3.5" />
              {isZero ? t('clock.tips.zeroEnterInstead') : t('clock.tips.editAmount')}
            </button>
          </div>

          {isZero ? (
            <div className="flex gap-3 rounded-control border border-warning bg-warning-tint p-4">
              <AlertTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
              <div className="space-y-1">
                <p className="text-meta font-semibold text-ink">{t('clock.tips.zeroGuardTitle')}</p>
                <p className="text-chip leading-relaxed text-ink-muted">{t('clock.tips.zeroGuardBody')}</p>
              </div>
            </div>
          ) : null}

          {isZero ? (
            <label className="flex cursor-pointer items-start gap-3 p-1">
              <input
                type="checkbox"
                checked={acked}
                onChange={(e) => setAcked(e.target.checked)}
                className="mt-0.5 h-[22px] w-[22px] shrink-0 rounded border-line text-primary"
              />
              <span className="select-none text-meta leading-tight text-ink">{t('clock.tips.zeroAck')}</span>
            </label>
          ) : null}

          <div className="overflow-hidden rounded-card border border-line bg-page shadow-sm">
            <Row label={t('clock.tips.clockedIn')} value={clockInTime} />
            <Row label={t('clock.tips.clockedOut')} value={clockOutTime} />
            <Row
              label={t('clock.tips.totalHours')}
              value={t('clock.home.hoursShort', { hours: formatHours(hours, i18n.language) })}
              last={isZero}
            />
            {!isZero && roleLabel ? (
              <div className="flex items-center justify-between px-5 py-3.5">
                <span className="text-meta font-medium text-ink-muted">{t('clock.tips.role')}</span>
                <span className="rounded-full bg-warning-tint px-2 py-0.5 text-micro font-bold uppercase tracking-wide text-warning">
                  {roleLabel}
                </span>
              </div>
            ) : null}
          </div>

          {!isZero ? (
            <div className="flex gap-3 rounded-control border border-warning bg-warning-tint p-4">
              <AlertTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
              <p className="text-meta leading-relaxed text-ink">{t('clock.tips.editNotice')}</p>
            </div>
          ) : null}
        </div>
      </main>

      <div className="shrink-0 border-t border-line p-4 pb-0">
        <button
          type="button"
          onClick={onConfirm}
          disabled={!canConfirm}
          className="mb-3 flex h-14 w-full items-center justify-center rounded-control bg-primary font-semibold text-white transition-all active:scale-[0.98] disabled:opacity-40"
        >
          {t('clock.tips.confirmAndClockOut')}
        </button>
        <button
          type="button"
          onClick={onGoBack}
          className="flex h-[52px] w-full items-center justify-center rounded-control border border-line font-semibold text-ink active:bg-hover"
        >
          {isZero ? t('clock.tips.zeroGoBack') : t('clock.tips.goBack')}
        </button>
        <div aria-hidden="true" className="h-safe-bottom w-full bg-page" />
      </div>
    </div>
  )
}

function Row({ label, value, last = false }: { label: string; value: string; last?: boolean }): JSX.Element {
  return (
    <div className={`flex items-center justify-between px-5 py-3.5 ${last ? '' : 'border-b border-line'}`}>
      <span className="text-meta font-medium text-ink-muted">{label}</span>
      <span className="tabular text-meta font-semibold text-ink">{value}</span>
    </div>
  )
}
