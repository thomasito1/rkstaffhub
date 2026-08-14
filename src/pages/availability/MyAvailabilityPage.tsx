import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Button, EmptyState, Pill, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth/AuthProvider'
import {
  AvailabilityLockedError,
  getAvailability,
  getEmployee,
  getRecurringAvailability,
  resolveEffectiveAvailability,
  submitAvailability,
} from '@/lib/db'
import {
  addDaysToIsoDate,
  availabilityDeadlineFor,
  datesForWeekId,
  isAvailabilityLocked,
  openAvailabilityWeekId,
} from '@/lib/deadlines'
import { formatDate } from '@/lib/format'
import {
  WEEKDAY_KEYS,
  type Availability,
  type AvailabilityDay,
  type AvailabilityType,
  type WeekdayKey,
} from '@/types/models'

import { DayAvailabilityRow, isDayValid } from './components/DayAvailabilityRow'

/**
 * My availability — mockup 08, mobile first.
 *
 * Seven day cards over a Recurring / "This week only" segmented control, an
 * amber deadline banner, and a pinned Submit button.
 *
 * TWO THINGS THE MOCKUP DOES NOT SHOW, BOTH REQUIRED BY §5:
 *
 * 1. THE LOCK IS REAL. Past Thursday 23:59 ET a week-specific submission is
 *    refused by submitAvailability(), so the editor for a locked week renders
 *    read-only with the deadline spelled out, rather than letting someone
 *    re-enter their whole week and meet an error on save. Recurring is never
 *    week-locked — it belongs to no single week — so that tab stays editable
 *    and says so.
 *
 * 2. PENDING IS NOT APPROVED. resolveEffectiveAvailability() puts a temporary
 *    record in force the moment it is submitted, but flags `isPending`. The
 *    footer shows "Submitted — waiting for approval" in that case; only a
 *    genuinely approved record reads as approved, and a declined one shows the
 *    manager's reason.
 *
 * WEEK PICKER. The mockup routes week-specific changes to a separate screen
 * ("Temporary change for a specific week"). That screen does not exist in this
 * change, so week selection lives on the "This week only" tab: it defaults to
 * the open week from openAvailabilityWeekId() and steps a week at a time, which
 * is also what makes the locked read-only state reachable.
 */

const RECURRING: AvailabilityType = 'recurring'
const TEMPORARY: AvailabilityType = 'temporary'

/** ISO date → an instant safely inside that calendar day in New York. */
function dateFromIso(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`)
}

function allAvailable(): Record<WeekdayKey, AvailabilityDay> {
  const out = {} as Record<WeekdayKey, AvailabilityDay>
  for (const key of WEEKDAY_KEYS) out[key] = { status: 'available', from: null, to: null }
  return out
}

function cloneDays(
  days: Record<WeekdayKey, AvailabilityDay>,
): Record<WeekdayKey, AvailabilityDay> {
  const out = {} as Record<WeekdayKey, AvailabilityDay>
  for (const key of WEEKDAY_KEYS) {
    const day = days[key]
    out[key] = { status: day.status, from: day.from ?? null, to: day.to ?? null }
  }
  return out
}

/** Stable comparison key for dirty-tracking — order is fixed by WEEKDAY_KEYS. */
function daysFingerprint(days: Record<WeekdayKey, AvailabilityDay>): string {
  return WEEKDAY_KEYS.map((key) => {
    const day = days[key]
    return `${key}:${day.status}:${day.from ?? ''}-${day.to ?? ''}`
  }).join('|')
}

export function MyAvailabilityPage(): JSX.Element {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const { employee } = useAuth()
  const lang = i18n.language

  // One clock read for the lifetime of the screen: the banner, the lock and
  // the open week must all agree, and a re-render must not move the deadline.
  const [now] = useState(() => new Date())
  const openWeekId = useMemo(() => openAvailabilityWeekId(now), [now])

  const [mode, setMode] = useState<AvailabilityType>(RECURRING)
  const [weekId, setWeekId] = useState<string>(openWeekId)

  const [recurring, setRecurring] = useState<Availability | null>(null)
  const [temporary, setTemporary] = useState<Availability | null>(null)
  const [reviewerName, setReviewerName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [saving, setSaving] = useState(false)

  const [days, setDays] = useState<Record<WeekdayKey, AvailabilityDay>>(allAvailable)
  const [baseline, setBaseline] = useState<string>(() => daysFingerprint(allAvailable()))

  const employeeId = employee?.id ?? null

  const load = useCallback(async () => {
    if (!employeeId) return
    setLoading(true)
    setLoadError(false)
    try {
      const [rec, tmp] = await Promise.all([
        getRecurringAvailability(employeeId),
        getAvailability(employeeId, weekId),
      ])
      setRecurring(rec)
      setTemporary(tmp)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [employeeId, weekId])

  useEffect(() => {
    void load()
  }, [load])

  const effective = useMemo(
    () => resolveEffectiveAvailability(employeeId ?? '', weekId, recurring, temporary),
    [employeeId, weekId, recurring, temporary],
  )

  /** The record whose review status this tab is reporting on. */
  const activeRecord: Availability | null = mode === RECURRING ? recurring : temporary

  // Seed the editor whenever the tab or the loaded records change. Recurring
  // edits its own baseline; a week-specific edit starts from what is actually
  // in force that week, so an override written from scratch does not silently
  // discard the days the baseline already covers.
  useEffect(() => {
    const seed =
      mode === RECURRING
        ? (recurring?.days ?? allAvailable())
        : (temporary?.days ?? effective.days)
    const next = cloneDays(seed)
    setDays(next)
    setBaseline(daysFingerprint(next))
  }, [mode, weekId, recurring, temporary, effective.days])

  const weekDates = useMemo(() => datesForWeekId(weekId), [weekId])
  const deadline = useMemo(() => availabilityDeadlineFor(weekId), [weekId])
  const weekLocked = useMemo(() => isAvailabilityLocked(weekId, now), [weekId, now])

  // Recurring belongs to no single week, so the Thursday lock never applies to
  // it (submitAvailability() skips the deadline check for recurring outright).
  const readOnly = mode === TEMPORARY && weekLocked

  const dirty = daysFingerprint(days) !== baseline
  const allValid = WEEKDAY_KEYS.every((key) => isDayValid(days[key]))

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

  const deadlineLabel = useMemo(
    () =>
      formatDate(
        deadline,
        {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        },
        lang,
      ),
    [deadline, lang],
  )

  // Best effort only: a staff member may not be allowed to read the reviewer's
  // employee record, in which case the footer simply omits the name.
  useEffect(() => {
    const reviewedBy = activeRecord?.reviewedBy
    if (!reviewedBy) {
      setReviewerName(null)
      return
    }
    let cancelled = false
    void getEmployee(reviewedBy)
      .then((reviewer) => {
        if (cancelled || !reviewer) return
        const first = reviewer.preferredName?.trim() ? reviewer.preferredName : reviewer.firstName
        setReviewerName(`${first} ${reviewer.lastName}`.trim())
      })
      .catch(() => setReviewerName(null))
    return () => {
      cancelled = true
    }
  }, [activeRecord?.reviewedBy])

  function setDay(key: WeekdayKey, next: AvailabilityDay): void {
    setDays((prev) => ({ ...prev, [key]: next }))
  }

  async function submit(): Promise<void> {
    if (!employeeId || readOnly || !allValid) return
    setSaving(true)
    try {
      await submitAvailability({ employeeId, weekId, type: mode, days })
      toast.show({ tone: 'success', message: t('availability.my.toast.submitted') })
      await load()
    } catch (err) {
      if (err instanceof AvailabilityLockedError) {
        toast.show({ tone: 'error', message: t('availability.my.toast.locked') })
      } else {
        toast.show({ tone: 'error', message: t('availability.my.toast.failed') })
      }
    } finally {
      setSaving(false)
    }
  }

  if (!employee) {
    return (
      <EmptyState
        illustration="calendar"
        title={t('availability.my.noEmployeeTitle')}
        body={t('availability.my.noEmployeeBody')}
      />
    )
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-4 pb-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-title font-semibold tracking-tight text-ink">
            {t('availability.my.title')}
          </h1>
          <p className="mt-0.5 text-meta text-ink-muted">{t('availability.my.subtitle')}</p>
        </div>
        <Link
          to="/time-off"
          className="shrink-0 rounded-control border border-line px-3 py-1.5 text-chip font-medium text-ink-muted transition-colors duration-hover hover:text-ink"
        >
          {t('availability.my.requestTimeOff')}
        </Link>
      </div>

      {/* Deadline banner — amber while the week is open, neutral once shut. */}
      <div
        className={[
          'flex items-start gap-3 rounded-card border p-3',
          readOnly ? 'border-line bg-app' : 'border-warning/20 bg-warning-tint',
        ].join(' ')}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          className={[
            'mt-0.5 h-5 w-5 shrink-0',
            readOnly ? 'text-ink-muted' : 'text-warning',
          ].join(' ')}
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        <div className="min-w-0">
          {mode === RECURRING ? (
            <>
              <p className="text-meta font-semibold text-ink">
                {t('availability.my.recurringBannerTitle')}
              </p>
              <p className="text-meta text-ink-muted">
                {t('availability.my.recurringBannerBody')}
              </p>
            </>
          ) : readOnly ? (
            <>
              <p className="text-meta font-semibold text-ink">
                {t('availability.my.lockedTitle', { week: weekRangeLabel })}
              </p>
              <p className="tabular text-meta text-ink-muted">
                {t('availability.my.lockedBody', { deadline: deadlineLabel })}
              </p>
            </>
          ) : (
            <>
              <p className="tabular text-meta font-semibold text-ink">
                {t('availability.my.deadlineTitle', { deadline: deadlineLabel })}
              </p>
              <p className="tabular text-meta text-ink-muted">
                {t('availability.my.deadlineBody', { week: weekRangeLabel })}
              </p>
            </>
          )}
        </div>
      </div>

      {/* Segmented control — Recurring vs this week only. */}
      <div>
        <div
          role="group"
          aria-label={t('availability.my.modeLabel')}
          className="flex rounded-control bg-gray-100 p-1"
        >
          {[RECURRING, TEMPORARY].map((value) => {
            const selected = mode === value
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                onClick={() => setMode(value)}
                className={[
                  'flex-1 rounded-md py-1.5 text-meta transition-colors duration-hover',
                  selected
                    ? 'bg-page font-semibold text-ink shadow-sm'
                    : 'font-medium text-ink-muted',
                ].join(' ')}
              >
                {t(`availability.my.mode.${value}`)}
              </button>
            )
          })}
        </div>
        <p className="mt-2 px-1 text-chip text-ink-muted">
          {t(`availability.my.modeHint.${mode}`)}
        </p>
      </div>

      {/* Week stepper — week-specific submissions only. */}
      {mode === TEMPORARY ? (
        <div className="flex items-center justify-between rounded-card border border-line bg-app p-1.5">
          <button
            type="button"
            aria-label={t('availability.previousWeek')}
            onClick={() => setWeekId((w) => addDaysToIsoDate(w, -7))}
            className="flex h-8 w-8 items-center justify-center rounded-control text-ink-muted transition-colors duration-hover hover:bg-page hover:text-ink"
          >
            <Chevron dir="left" />
          </button>
          <span className="tabular text-meta font-semibold text-ink">{weekRangeLabel}</span>
          <button
            type="button"
            aria-label={t('availability.nextWeek')}
            onClick={() => setWeekId((w) => addDaysToIsoDate(w, 7))}
            className="flex h-8 w-8 items-center justify-center rounded-control text-ink-muted transition-colors duration-hover hover:bg-page hover:text-ink"
          >
            <Chevron dir="right" />
          </button>
        </div>
      ) : null}

      {/* Review status of whatever is on file for this tab. */}
      {activeRecord ? (
        <div className="flex flex-wrap items-center gap-2 rounded-card border border-line bg-page p-3">
          <Pill tone={activeRecord.status}>{t(`status.${activeRecord.status}`)}</Pill>
          <span className="min-w-0 flex-1 text-meta text-ink-muted">
            {activeRecord.status === 'pending'
              ? t('availability.my.pendingNote')
              : activeRecord.status === 'declined'
                ? t('availability.my.declinedNote', {
                    reason: activeRecord.declineReason ?? t('availability.my.noReasonGiven'),
                  })
                : reviewerName !== null
                  ? t('availability.my.approvedByNote', { name: reviewerName })
                  : t('availability.my.approvedNote')}
          </span>
        </div>
      ) : null}

      {/* A pending temporary is already in force for the week (§5) — say so
          plainly rather than letting it look like an approved fact. */}
      {mode === TEMPORARY && effective.isPending && effective.source === 'temporary' ? (
        <p className="rounded-card border border-warning/20 bg-warning-tint p-3 text-meta text-ink">
          {t('availability.my.pendingInForce')}
        </p>
      ) : null}

      {loading ? (
        <>
          <p className="sr-only" role="status">
            {t('app.loading')}
          </p>
          <div className="flex flex-col gap-3">
            {WEEKDAY_KEYS.map((key) => (
              <div
                key={key}
                className="h-[104px] animate-skeleton rounded-card border border-line bg-app"
              />
            ))}
          </div>
        </>
      ) : loadError ? (
        <EmptyState
          illustration="search"
          title={t('availability.my.errorTitle')}
          body={t('availability.my.errorBody')}
          action={<Button onClick={() => void load()}>{t('common.retry')}</Button>}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {WEEKDAY_KEYS.map((key, index) => {
            const isoDate = weekDates[index]
            return (
              <DayAvailabilityRow
                key={key}
                dayKey={key}
                label={t(`weekdays.long.${key}`)}
                dateLabel={
                  mode === TEMPORARY && isoDate !== undefined
                    ? formatDate(
                        dateFromIso(isoDate),
                        { month: 'short', day: 'numeric' },
                        lang,
                      )
                    : undefined
                }
                value={days[key]}
                onChange={(next) => setDay(key, next)}
                readOnly={readOnly}
              />
            )
          })}
        </div>
      )}

      {!loading && !loadError ? (
        <div className="sticky bottom-0 -mx-4 border-t border-line bg-page px-4 pb-safe pt-3">
          {readOnly ? (
            <p className="py-2 text-center text-meta text-ink-muted">
              {t('availability.my.lockedFooter')}
            </p>
          ) : (
            <>
              <Button
                variant="primary"
                size="lg"
                fullWidth
                disabled={saving || !dirty || !allValid}
                onClick={() => void submit()}
              >
                {saving ? t('availability.my.submitting') : t('availability.my.submit')}
              </Button>
              {!allValid ? (
                <p className="mt-2 text-center text-chip text-danger">
                  {t('availability.my.fixRanges')}
                </p>
              ) : !dirty ? (
                <p className="mt-2 text-center text-chip text-ink-muted">
                  {t('availability.my.noChanges')}
                </p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
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
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path d={dir === 'left' ? 'm15 6-6 6 6 6' : 'm9 6 6 6-6 6'} />
    </svg>
  )
}

export default MyAvailabilityPage
