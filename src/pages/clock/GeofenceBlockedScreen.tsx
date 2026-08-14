import { useTranslation } from 'react-i18next'

import { InfoIcon, LockIcon, MapPinIcon, MapPinOffIcon, RefreshCwIcon } from './icons'

/**
 * Geofence-blocked state — mockup 23. Rendered in place of the normal home
 * content (the header, date/time, and bottom tab bar stay put — this is a
 * state of the Clock Home screen, not a separate route).
 *
 * JUDGMENT CALL: mockup 23 also draws an "Ask a manager to punch me in"
 * button and an "on shift now" manager list. Building the manager-assisted
 * manual-punch UI (or a query for who's on duty) is explicitly out of scope
 * for this task — that's the `manualPunch` API's UI, which belongs to
 * Shifts & Tips admin. Dropped both; "ask a manager" survives as copy in the
 * explanation paragraph below, which is what the mockup's own body text
 * already says.
 */
export function GeofenceBlockedScreen({
  punchType,
  reason,
  distanceMeters,
  radiusMeters,
  restaurantName,
  secondsAgo,
  onTryAgain,
  retrying,
}: {
  punchType: 'in' | 'out'
  reason: 'outside' | 'imprecise'
  distanceMeters: number | null
  radiusMeters: number
  restaurantName: string
  secondsAgo: number
  onTryAgain: () => void
  retrying: boolean
}): JSX.Element {
  const { t } = useTranslation()

  const distanceLabel = distanceMeters !== null ? Math.round(distanceMeters) : 0

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3 rounded-full border border-danger bg-danger-tint p-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-page shadow-sm">
          <MapPinOffIcon className="h-5 w-5 text-danger" />
        </div>
        <div className="flex flex-col">
          <span className="text-meta font-semibold text-ink">
            {reason === 'outside'
              ? t('clock.blocked.chipTitleOutside', { name: restaurantName })
              : t('clock.blocked.chipTitleImprecise')}
          </span>
          <span className="tabular mt-0.5 text-chip text-ink-muted">
            {reason === 'outside'
              ? t('clock.blocked.chipSubtitleOutside', { distance: distanceLabel, seconds: secondsAgo })
              : t('clock.blocked.chipSubtitleImprecise')}
          </span>
        </div>
      </div>

      <div className="overflow-hidden rounded-card-lg border border-line bg-page">
        <div className="flex h-[140px] items-center justify-center bg-app">
          <MapPinIcon className="h-10 w-10 text-success" />
        </div>
        <div className="flex items-center gap-2 border-t border-line p-3">
          <InfoIcon className="h-4 w-4 shrink-0 text-ink-muted" />
          <p className="text-chip text-ink-muted">
            {t('clock.blocked.mapCaption', { radius: radiusMeters })}
          </p>
        </div>
      </div>

      <div>
        <h3 className="text-section font-semibold text-ink">{t('clock.blocked.whyTitle')}</h3>
        <p className="mt-2 text-meta leading-relaxed text-ink-muted">{t('clock.blocked.whyBody')}</p>
      </div>

      <div className="flex flex-col items-center">
        <button
          type="button"
          disabled
          className="flex h-24 w-full cursor-not-allowed items-center justify-center gap-3 rounded-card-lg bg-primary text-white opacity-40"
        >
          <LockIcon className="h-7 w-7" />
          <span className="text-section font-semibold">
            {punchType === 'in' ? t('clock.blocked.clockInLocked') : t('clock.blocked.clockOutLocked')}
          </span>
        </button>
        <p className="mt-3 text-meta text-ink-muted">{t('clock.blocked.unlockHint')}</p>
      </div>

      <button
        type="button"
        onClick={onTryAgain}
        disabled={retrying}
        className="flex items-center justify-center gap-2 py-2 text-meta font-semibold text-primary disabled:opacity-50"
      >
        <RefreshCwIcon className="h-4 w-4" />
        <span>{t('clock.blocked.tryAgain')}</span>
      </button>
    </div>
  )
}
