import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import type { AvailabilityDay, AvailabilityDayStatus, WeekdayKey } from '@/types/models'

/**
 * One day of the availability editor — mockup 08.
 *
 * A white card carrying the day name and a three-state segmented control
 * (Available · Partial · Not available), followed by a tinted summary strip:
 * teal "Available all day", an amber time-range pair, or red "Not available".
 *
 * ACCESSIBILITY. The three states are mutually exclusive, so they are native
 * radios inside a <fieldset> whose <legend> is the day name. That buys the
 * whole radiogroup contract for free — one tab stop, arrow keys to move
 * between states, the group name announced with each option — which a row of
 * <button>s would have to re-implement by hand and usually gets wrong. The
 * inputs are `sr-only` rather than `hidden` so they stay focusable; the visible
 * pill is a sibling <span> driven by `peer-checked`.
 *
 * SINGLE TIME RANGE. The mockup offers "+ Add another time range", but
 * AvailabilityDay (types/models.ts) carries exactly one `from`/`to` pair and
 * models.ts is out of scope for this change. One range is rendered; the button
 * is omitted rather than shipped as a control that cannot store its result.
 * Flagged in the handoff notes.
 */

const STATUSES: readonly AvailabilityDayStatus[] = [
  'available',
  'partial',
  'unavailable',
] as const

/** Sensible opening-to-close default the first time a day becomes partial. */
const DEFAULT_FROM = '09:00'
const DEFAULT_TO = '17:00'

/**
 * A partial day needs both ends and must not run backwards. Exported because
 * the page gates its Submit button on the same rule — one definition, so the
 * inline error and the disabled button can never disagree.
 */
export function isDayValid(day: AvailabilityDay): boolean {
  if (day.status !== 'partial') return true
  const from = day.from ?? ''
  const to = day.to ?? ''
  if (from === '' || to === '') return false
  // "HH:mm" is lexicographically ordered, so string comparison is time order.
  return from < to
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
      aria-hidden="true"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  )
}

function ClockIcon({ className = 'h-[18px] w-[18px]' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

function CrossIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px]"
      aria-hidden="true"
    >
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  )
}

function StatusIcon({ status }: { status: AvailabilityDayStatus }) {
  if (status === 'available') return <CheckIcon />
  if (status === 'partial') return <ClockIcon />
  return <CrossIcon />
}

/** Checked-state fill per the mockup: teal, amber, red. */
const CHECKED_FILL: Record<AvailabilityDayStatus, string> = {
  available: 'peer-checked:bg-success peer-checked:text-white',
  partial: 'peer-checked:bg-warning peer-checked:text-white',
  unavailable: 'peer-checked:bg-danger peer-checked:text-white',
}

export interface DayAvailabilityRowProps {
  dayKey: WeekdayKey
  /** Localised day name — "Monday". */
  label: string
  /** Calendar date shown alongside the name in week-specific mode. */
  dateLabel?: string
  value: AvailabilityDay
  onChange: (next: AvailabilityDay) => void
  /** Past the deadline the whole card is inert but still fully readable. */
  readOnly?: boolean
}

export function DayAvailabilityRow({
  dayKey,
  label,
  dateLabel,
  value,
  onChange,
  readOnly = false,
}: DayAvailabilityRowProps): JSX.Element {
  const { t } = useTranslation()
  const uid = useId()
  const groupName = `${uid}-${dayKey}`
  const errorId = `${groupName}-error`
  const invalid = !isDayValid(value)

  function selectStatus(status: AvailabilityDayStatus): void {
    if (status === 'partial') {
      onChange({
        status,
        from: value.from ?? DEFAULT_FROM,
        to: value.to ?? DEFAULT_TO,
      })
      return
    }
    // from/to are meaningless off 'partial' and the db layer strips them.
    onChange({ status, from: null, to: null })
  }

  return (
    <div className="rounded-card border border-line bg-page p-4">
      <fieldset disabled={readOnly}>
        {/* The legend must be the fieldset's first child to name the group, so
            it carries the accessible name and the visible day name is a
            separate span laid out per the mockup. */}
        <legend className="sr-only">
          {t('availability.dayGroupLabel', { day: label })}
        </legend>

        <div className="mb-3 flex items-center justify-between gap-3">
          <span>
            <span className="text-body font-semibold text-ink">{label}</span>
            {dateLabel !== undefined ? (
              <span className="tabular ml-2 text-meta text-ink-muted">{dateLabel}</span>
            ) : null}
          </span>

          <div className="ml-auto flex rounded-control bg-gray-100 p-0.5">
            {STATUSES.map((status) => {
              const id = `${groupName}-${status}`
              return (
                <label key={status} htmlFor={id} className="cursor-pointer">
                  <input
                    id={id}
                    type="radio"
                    name={groupName}
                    value={status}
                    className="peer sr-only"
                    checked={value.status === status}
                    disabled={readOnly}
                    onChange={() => selectStatus(status)}
                  />
                  <span
                    className={[
                      'flex h-8 w-8 items-center justify-center rounded-md text-ink-muted',
                      'transition-colors duration-hover',
                      'peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2',
                      'peer-disabled:cursor-not-allowed peer-disabled:opacity-60',
                      CHECKED_FILL[status],
                    ].join(' ')}
                  >
                    <StatusIcon status={status} />
                    <span className="sr-only">{t(`availability.dayStatus.${status}`)}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </div>

        {value.status === 'available' ? (
          <p className="rounded-control bg-success-tint px-3 py-2.5 text-meta font-semibold text-success">
            {t('availability.availableAllDay')}
          </p>
        ) : null}

        {value.status === 'unavailable' ? (
          <p className="rounded-control bg-danger-tint px-3 py-2.5 text-meta font-semibold text-danger">
            {t('availability.dayStatus.unavailable')}
          </p>
        ) : null}

        {value.status === 'partial' ? (
          <div className="rounded-control bg-warning-tint p-3">
            <div className="flex items-center gap-2">
              <TimeField
                id={`${groupName}-from`}
                label={t('availability.availableFrom')}
                value={value.from ?? ''}
                invalid={invalid}
                describedBy={invalid ? errorId : undefined}
                readOnly={readOnly}
                onChange={(next) => onChange({ ...value, status: 'partial', from: next })}
              />
              <span className="shrink-0 text-meta font-medium text-warning">
                {t('availability.to')}
              </span>
              <TimeField
                id={`${groupName}-to`}
                label={t('availability.availableUntil')}
                value={value.to ?? ''}
                invalid={invalid}
                describedBy={invalid ? errorId : undefined}
                readOnly={readOnly}
                onChange={(next) => onChange({ ...value, status: 'partial', to: next })}
              />
            </div>
            {invalid ? (
              <p id={errorId} role="alert" className="mt-2 text-chip font-medium text-danger">
                {t('availability.rangeError')}
              </p>
            ) : null}
          </div>
        ) : null}
      </fieldset>
    </div>
  )
}

function TimeField({
  id,
  label,
  value,
  invalid,
  describedBy,
  readOnly,
  onChange,
}: {
  id: string
  label: string
  value: string
  invalid: boolean
  describedBy: string | undefined
  readOnly: boolean
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <div className="min-w-0 flex-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div
        className={[
          'flex items-center gap-2 rounded-md border bg-page px-3 py-2',
          invalid ? 'border-danger' : 'border-warning/30',
        ].join(' ')}
      >
        <ClockIcon className="h-4 w-4 shrink-0 text-warning" />
        <input
          id={id}
          type="time"
          value={value}
          disabled={readOnly}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
          className="tabular w-full min-w-0 bg-transparent text-meta font-medium text-ink focus:outline-none disabled:cursor-not-allowed"
        />
      </div>
    </div>
  )
}

export default DayAvailabilityRow
