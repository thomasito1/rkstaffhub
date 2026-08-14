import { useTranslation } from 'react-i18next'

import { formatCurrency } from '@/lib/format'
import type { WeekdayKey } from '@/types/models'

import { GRID_COLS } from './RoleBandRow'

/**
 * Sticky day-of-week header above the role bands — mockup 11's header row
 * (weekday abbreviation, day-of-month number, forecasted sales). Shares
 * `GRID_COLS` with `RoleBandRow` so its 7 day cells land exactly above each
 * band's day columns. The forecast number is real `projectedSalesByDate`
 * data (the same source `LaborFooter` uses for the day's labor-% pill), not
 * the mockup's fabricated placeholder.
 */
function dayOfMonth(isoDate: string): string {
  return String(Number(isoDate.slice(8, 10)))
}

export function ScheduleHeaderRow({
  weekDates,
  weekdayKeyFor,
  projectedSalesByDate,
}: {
  weekDates: string[]
  weekdayKeyFor: (isoDate: string) => WeekdayKey | undefined
  projectedSalesByDate: Record<string, number>
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language

  return (
    <div
      className="sticky top-0 z-10 grid border-b border-line bg-page"
      style={{ gridTemplateColumns: GRID_COLS }}
    >
      <div className="flex h-[72px] items-center border-r border-line px-4">
        <span className="text-micro font-semibold uppercase tracking-wider text-ink-muted">
          {t('scheduleBuilder.header.employee')}
        </span>
      </div>
      {weekDates.map((date, index) => {
        const dayKey = weekdayKeyFor(date)
        const sales = projectedSalesByDate[date]
        return (
          <div
            key={date}
            className={[
              'flex h-[72px] flex-col items-center justify-center',
              index < weekDates.length - 1 ? 'border-r border-line' : '',
            ].join(' ')}
          >
            <span className="text-micro font-semibold uppercase text-ink-muted">
              {dayKey ? t(`weekdays.short.${dayKey}`) : ''}
            </span>
            <span className="tabular mt-0.5 text-meta font-semibold text-ink">
              {dayOfMonth(date)}
            </span>
            {typeof sales === 'number' ? (
              <span className="tabular mt-0.5 text-micro text-ink-muted">
                {t('scheduleBuilder.header.forecast', { amount: formatCurrency(sales, lang) })}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
