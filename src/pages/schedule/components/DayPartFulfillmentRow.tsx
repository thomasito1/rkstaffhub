import { useTranslation } from 'react-i18next'

import type { TemplateFulfillment } from '@/lib/scheduling/fulfillment'
import type { ShiftRole, ShiftTemplate } from '@/types/models'

import { GRID_COLS } from './RoleBandRow'

/**
 * Day-part requirement fulfillment — spec §6: "the builder shows requirement
 * fulfillment per day-part (met/unmet badge)." No mockup exists for this (not
 * in `.superdesign/export/` or `.superdesign/pending/` — checked before
 * building), so the visual is new: one small pill per shiftTemplate whose
 * day-part falls on that date, aligned under `ScheduleHeaderRow` via the same
 * `GRID_COLS` grid RoleBandRow uses. Multiple templates can land on the same
 * date (e.g. Lunch + Dinner), hence a row of pills per cell rather than one
 * badge per day.
 *
 * Renders nothing when no templates exist for the visible week — an empty
 * catalog (nothing configured yet in Settings → Shift templates) should not
 * draw an empty row.
 */
export function DayPartFulfillmentRow({
  weekDates,
  templates,
  fulfillment,
  rolesById,
}: {
  weekDates: string[]
  templates: ShiftTemplate[]
  fulfillment: TemplateFulfillment[]
  rolesById: Map<string, ShiftRole>
}): JSX.Element | null {
  const { t, i18n } = useTranslation()
  const lang = i18n.language

  if (fulfillment.length === 0) return null

  const templatesById = new Map(templates.map((tpl) => [tpl.id, tpl]))
  const fulfillmentByDate = new Map<string, TemplateFulfillment[]>()
  for (const f of fulfillment) {
    const list = fulfillmentByDate.get(f.date) ?? []
    list.push(f)
    fulfillmentByDate.set(f.date, list)
  }

  const roleName = (roleId: string): string => {
    const role = rolesById.get(roleId)
    if (!role) return roleId
    return lang.startsWith('es') && role.nameEs ? role.nameEs : role.name
  }

  function tooltipFor(f: TemplateFulfillment): string {
    return f.requirements
      .map((r) =>
        t('scheduleBuilder.fulfillment.requirementLine', {
          count: r.count,
          role: roleName(r.roleId),
          level: r.minSkillLevel,
          have: r.have,
        }),
      )
      .join('\n')
  }

  return (
    <div
      className="grid border-b border-line bg-page"
      style={{ gridTemplateColumns: GRID_COLS }}
      role="row"
      aria-label={t('scheduleBuilder.fulfillment.rowLabel')}
    >
      <div className="flex items-center border-r border-line px-4 py-2">
        <span className="text-micro font-semibold uppercase tracking-wider text-ink-muted">
          {t('scheduleBuilder.fulfillment.rowLabel')}
        </span>
      </div>
      {weekDates.map((date, index) => {
        const dayFulfillment = fulfillmentByDate.get(date) ?? []
        return (
          <div
            key={date}
            className={[
              'flex flex-wrap items-center gap-1 px-2 py-2',
              index < weekDates.length - 1 ? 'border-r border-line' : '',
            ].join(' ')}
          >
            {dayFulfillment.map((f) => {
              const tpl = templatesById.get(f.templateId)
              return (
                <span
                  key={f.templateId}
                  title={tooltipFor(f)}
                  className={[
                    'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5',
                    'text-micro font-semibold',
                    f.met ? 'bg-success-tint text-success' : 'bg-danger-tint text-danger',
                  ].join(' ')}
                >
                  {tpl?.name ?? f.templateId}
                  <span className="sr-only">
                    {' — '}
                    {t(f.met ? 'scheduleBuilder.fulfillment.met' : 'scheduleBuilder.fulfillment.unmet')}
                  </span>
                </span>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
