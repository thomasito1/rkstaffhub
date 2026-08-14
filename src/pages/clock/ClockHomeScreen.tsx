import { useTranslation } from 'react-i18next'

import { formatDate, formatHours } from '@/lib/format'
import type { Employee, Punch, Shift, ShiftRole } from '@/types/models'

import { formatClock12, formatClock12Compact, employeeDisplayName } from './shared'
import type { RecentPunchRow } from './useClockData'
import { CheckCircleIcon, ClockIcon, MapPinIcon, MapPinOffIcon } from './icons'

export interface GeofenceStatus {
  state: 'checking' | 'verified' | 'outside' | 'unavailable'
  secondsAgo: number
}

/**
 * Clock home — mockup 19. `onPrimaryAction` starts the clock-in/out flow;
 * this component only ever renders — the geolocation + geofence pre-check
 * happens one level up (ClockPage), which decides whether to move to the
 * selfie step or the geofence-blocked screen.
 */
export function ClockHomeScreen({
  hasOpenPunch,
  todaysShift,
  coworkers,
  role,
  geofence,
  restaurantName,
  recentPunches,
  pendingSyncCount,
  busy,
  onPrimaryAction,
}: {
  hasOpenPunch: boolean
  todaysShift: Shift | null
  coworkers: Employee[]
  role: ShiftRole | undefined
  geofence: GeofenceStatus
  restaurantName: string
  recentPunches: RecentPunchRow[]
  pendingSyncCount: number
  busy: boolean
  onPrimaryAction: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const now = new Date()

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-1 pb-4">
      <header className="pb-2 pt-2">
        <h1 className="text-title font-semibold leading-tight text-ink">{t('clock.home.title')}</h1>
        <p className="tabular mt-0.5 text-meta text-ink-muted">
          {t('clock.home.dateTime', {
            date: formatDate(now, { weekday: 'long', month: 'short', day: 'numeric' }, lang),
            time: formatDate(now, { hour: 'numeric', minute: '2-digit' }, lang),
          })}
        </p>
      </header>

      {pendingSyncCount > 0 ? (
        <div className="mt-2 rounded-control border border-warning bg-warning-tint px-4 py-2 text-chip font-medium text-ink">
          {t('clock.home.pendingSyncBanner', { count: pendingSyncCount })}
        </div>
      ) : null}

      <div className="mt-4">
        <GeofenceChip status={geofence} restaurantName={restaurantName} />
      </div>

      <section className="mt-6">
        <div className="rounded-card-lg border border-line bg-page p-5">
          <div className="mb-3 flex flex-col gap-1">
            <span className="text-micro font-bold uppercase tracking-wide text-ink-muted">
              {t('clock.home.todaysShift')}
            </span>
            {todaysShift ? (
              <span className="tabular mt-0.5 text-section font-bold text-ink">
                {formatClock12(todaysShift.startTime)} – {formatClock12(todaysShift.endTime)}
              </span>
            ) : (
              <span className="mt-0.5 text-body italic text-ink-muted">{t('clock.home.noShiftToday')}</span>
            )}
          </div>
          {todaysShift ? (
            <>
              <div className="mb-4 flex gap-2">
                <span className="rounded-full bg-warning-tint px-2 py-0.5 text-micro font-bold uppercase text-warning">
                  {role ? `${lang.startsWith('es') && role.nameEs ? role.nameEs : role.name} · L${todaysShift.requiredSkillLevel}` : `L${todaysShift.requiredSkillLevel}`}
                </span>
                {todaysShift.station ? (
                  <span className="rounded-full border border-line px-2 py-0.5 text-micro font-bold uppercase text-ink-muted">
                    {todaysShift.station}
                  </span>
                ) : null}
              </div>
              {coworkers.length > 0 ? (
                <div className="text-meta text-ink-muted">
                  {t('clock.home.scheduledWith', {
                    names: coworkers.map(employeeDisplayName).join(', '),
                  })}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </section>

      <section className="mt-8 flex flex-col items-center">
        <button
          type="button"
          onClick={onPrimaryAction}
          disabled={busy}
          className="flex h-24 w-full items-center justify-center gap-3 rounded-card-lg bg-primary font-semibold text-white transition-all active:scale-[0.98] disabled:opacity-60"
        >
          <ClockIcon className="h-7 w-7" />
          <span className="text-section font-semibold">
            {hasOpenPunch ? t('clock.home.clockOut') : t('clock.home.clockIn')}
          </span>
        </button>
        {!hasOpenPunch ? (
          <p className="tabular mt-4 text-meta text-ink-muted">{t('clock.home.clockInHint')}</p>
        ) : null}
      </section>

      {recentPunches.length > 0 ? (
        <section className="mb-4 mt-10">
          <h2 className="mb-3 px-1 text-body font-semibold text-ink">{t('clock.home.recentPunches')}</h2>
          <div className="overflow-hidden rounded-card-lg border border-line bg-page">
            {recentPunches.map((row, i) => (
              <RecentPunchRowView key={row.date} row={row} last={i === recentPunches.length - 1} lang={lang} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function RecentPunchRowView({
  row,
  last,
  lang,
}: {
  row: RecentPunchRow
  last: boolean
  lang: string
}): JSX.Element {
  const { t } = useTranslation()
  const inDate = toDate(row.inPunch)
  const outDate = toDate(row.outPunch)

  return (
    <div className={`flex items-center justify-between p-4 text-meta text-ink ${last ? '' : 'border-b border-line'}`}>
      <div className="flex flex-col gap-0.5">
        <span className="font-medium">
          {new Intl.DateTimeFormat(lang, { weekday: 'short', month: 'short', day: 'numeric' }).format(
            new Date(`${row.date}T12:00:00`),
          )}
        </span>
        <span className="tabular text-ink-muted">
          {inDate ? formatClock12CompactFromDate(inDate) : '—'} – {outDate ? formatClock12CompactFromDate(outDate) : '—'}
        </span>
      </div>
      <span className="tabular text-ink-muted">{t('clock.home.hoursShort', { hours: formatHours(row.hours, lang) })}</span>
    </div>
  )
}

function toDate(p: Punch): Date | null {
  const ts = p.timestamp
  return ts && typeof ts === 'object' && 'toDate' in ts ? (ts as { toDate(): Date }).toDate() : null
}

function formatClock12CompactFromDate(d: Date): string {
  return formatClock12Compact(`${d.getHours()}:${d.getMinutes()}`)
}

function GeofenceChip({ status, restaurantName }: { status: GeofenceStatus; restaurantName: string }): JSX.Element {
  const { t } = useTranslation()

  if (status.state === 'verified') {
    return (
      <div className="flex flex-col">
        <div className="flex w-full items-center gap-2 rounded-full bg-success-tint px-4 py-2 text-success">
          <MapPinIcon className="h-5 w-5" />
          <span className="flex-1 text-meta font-semibold">{t('clock.home.geofence.verified', { name: restaurantName })}</span>
          <CheckCircleIcon className="h-5 w-5" />
        </div>
        <p className="ml-4 mt-1.5 text-chip text-ink-muted">
          {t('clock.home.geofence.verifiedAgo', { count: status.secondsAgo })}
        </p>
      </div>
    )
  }

  if (status.state === 'outside') {
    return (
      <div className="flex w-full items-center gap-2 rounded-full border border-danger bg-danger-tint px-4 py-2 text-danger">
        <MapPinOffIcon className="h-5 w-5" />
        <span className="flex-1 text-meta font-semibold">{t('clock.home.geofence.outside', { name: restaurantName })}</span>
      </div>
    )
  }

  return (
    <div className="flex w-full items-center gap-2 rounded-full bg-app px-4 py-2 text-ink-muted">
      <MapPinIcon className="h-5 w-5" />
      <span className="flex-1 text-meta font-medium">
        {status.state === 'checking' ? t('clock.home.geofence.checking') : t('clock.home.geofence.unavailable')}
      </span>
    </div>
  )
}
