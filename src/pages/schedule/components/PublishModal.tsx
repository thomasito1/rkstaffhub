import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Avatar, Button, Modal, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth/AuthProvider'
import { formatCurrency, formatDate, formatHours, formatPercent } from '@/lib/format'
import type { ScheduleData } from '../useScheduleData'
import { computeWeekLabor } from './LaborFooter'

/**
 * Publish / republish confirmation — mockup 15's two variants.
 *
 * "Changes since last publish" is real data, not mockup 15's fabricated
 * per-field diffs (drafted from field-level history nothing in this app
 * currently records): a shift still in `status: 'draft'` is exactly the set
 * `republishSchedule()` itself notifies (see schedules.ts's publishInternal),
 * so the affected-employees list here is that same set, honestly computed —
 * not invented "time changed 4p→11p" copy this data can't support yet.
 */
function toDateSafe(value: unknown): Date | null {
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate()
  }
  return null
}

export function PublishModal({
  open,
  onClose,
  data,
  weekRangeLabel,
}: {
  open: boolean
  onClose: () => void
  data: ScheduleData
  weekRangeLabel: string
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()
  const { employee, user } = useAuth()
  const [submitting, setSubmitting] = useState(false)

  const isRepublish =
    data.schedule?.status === 'published' || data.schedule?.status === 'republished'

  const activeShifts = useMemo(
    () => data.shifts.filter((s) => s.status !== 'cancelled'),
    [data.shifts],
  )
  const draftShifts = useMemo(() => activeShifts.filter((s) => s.status === 'draft'), [activeShifts])

  const assignedEmployeeIds = useMemo(
    () => [...new Set(activeShifts.map((s) => s.employeeId).filter((id): id is string => id !== null))],
    [activeShifts],
  )
  const affectedEmployeeIds = useMemo(
    () => [...new Set(draftShifts.map((s) => s.employeeId).filter((id): id is string => id !== null))],
    [draftShifts],
  )
  const unchangedCount = Math.max(assignedEmployeeIds.length - affectedEmployeeIds.length, 0)

  const { hours, cost } = useMemo(
    () => computeWeekLabor(data.weekDates, data.shifts, data.employeesById, data.compensationByEmployee),
    [data.weekDates, data.shifts, data.employeesById, data.compensationByEmployee],
  )
  const pct =
    data.projectedSalesTotal && data.projectedSalesTotal > 0 ? cost / data.projectedSalesTotal : null

  const publishedAt = toDateSafe(data.schedule?.publishedAt)

  async function handleConfirm() {
    if (!employee || !user) return
    setSubmitting(true)
    try {
      if (isRepublish) {
        await data.republish({ employeeId: employee.id, uid: user.uid })
      } else {
        await data.publish({ employeeId: employee.id, uid: user.uid })
      }
      toast.show({
        tone: 'success',
        message: isRepublish
          ? t('scheduleBuilder.publish.toast.republished')
          : t('scheduleBuilder.publish.toast.published'),
      })
      onClose()
    } catch {
      toast.show({ tone: 'error', message: t('scheduleBuilder.publish.toast.failed') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isRepublish ? t('scheduleBuilder.publish.republishTitle') : t('scheduleBuilder.publish.publishTitle')}
      subtitle={weekRangeLabel}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={submitting} onClick={() => void handleConfirm()}>
            {isRepublish
              ? t('scheduleBuilder.publish.confirmRepublish', { count: affectedEmployeeIds.length })
              : t('scheduleBuilder.publish.confirmPublish')}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {isRepublish ? (
          <div className="flex gap-3 rounded-card border border-warning bg-warning-tint p-3">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.75}
              className="mt-0.5 h-5 w-5 shrink-0 text-warning"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 8v5M12 15.8h.01" />
            </svg>
            <p className="text-chip leading-normal text-ink">
              {publishedAt
                ? t('scheduleBuilder.publish.alreadyPublished', {
                    date: formatDate(publishedAt, { dateStyle: 'medium', timeStyle: 'short' }, lang),
                  })
                : t('scheduleBuilder.publish.alreadyPublishedUnknown')}
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-line bg-app px-4 py-3 text-chip text-ink">
            <span className="tabular font-medium">
              {t('scheduleBuilder.publish.shiftCount', { count: activeShifts.length })}
            </span>
            <span className="text-line">|</span>
            <span className="tabular font-medium">{formatHours(hours, lang)} hrs</span>
            <span className="text-line">|</span>
            <span className="tabular font-medium">{formatCurrency(cost, lang)}</span>
            {pct !== null ? (
              <>
                <span className="text-line">|</span>
                <span className="tabular font-medium text-success">{formatPercent(pct, lang)}</span>
              </>
            ) : null}
          </div>
        )}

        {isRepublish ? (
          <div className="space-y-3">
            <h3 className="text-meta font-semibold text-ink">
              {t('scheduleBuilder.publish.changesTitle')}
            </h3>
            {affectedEmployeeIds.length === 0 ? (
              <p className="text-chip text-ink-muted">{t('scheduleBuilder.publish.noChanges')}</p>
            ) : (
              <div className="divide-y divide-line overflow-hidden rounded-card border border-line">
                {affectedEmployeeIds.map((id) => {
                  const person = data.employeesById.get(id)
                  const count = draftShifts.filter((s) => s.employeeId === id).length
                  return (
                    <div key={id} className="flex items-center justify-between p-3">
                      <div className="flex items-center gap-3">
                        <Avatar
                          firstName={person?.firstName ?? '?'}
                          lastName={person?.lastName ?? ''}
                          photoUrl={person?.photoUrl}
                          size={32}
                        />
                        <div className="flex flex-col">
                          <span className="text-chip font-semibold text-ink">
                            {person ? `${person.firstName} ${person.lastName}` : id}
                          </span>
                          <span className="text-chip text-ink-muted">
                            {t('scheduleBuilder.publish.shiftsChanged', { count })}
                          </span>
                        </div>
                      </div>
                      <span className="rounded bg-warning-tint px-2 py-0.5 text-[10px] font-bold uppercase text-warning">
                        {t('scheduleBuilder.publish.updatedBadge')}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="flex items-center gap-2 rounded-card border border-line bg-app p-3 text-chip text-ink-muted">
              <span className="font-medium text-ink">
                {t('scheduleBuilder.publish.affectedCount', { count: affectedEmployeeIds.length })}
              </span>
              {unchangedCount > 0 ? (
                <span>· {t('scheduleBuilder.publish.unchangedCount', { count: unchangedCount })}</span>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <h3 className="text-meta font-semibold text-ink">{t('scheduleBuilder.publish.nextStepsTitle')}</h3>
            <ul className="space-y-2 text-chip text-ink">
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                {t('scheduleBuilder.publish.stepNotify', { count: assignedEmployeeIds.length })}
              </li>
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                {t('scheduleBuilder.publish.stepVisible')}
              </li>
              <li className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                {t('scheduleBuilder.publish.stepTrades')}
              </li>
            </ul>
          </div>
        )}
      </div>
    </Modal>
  )
}
