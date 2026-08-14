import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getDownloadURL, ref } from 'firebase/storage'

import { Button, Modal } from '@/components/ui'
import { instantAtRestaurantWallClock } from '@/lib/deadlines'
import { storage } from '@/lib/firebase'
import { formatCurrency, formatDate } from '@/lib/format'
import { editPunch, editTipReport } from '@/lib/timeClock/punchActions'
import type { Employee, PunchEditHistoryEntry, TipReportEditHistoryEntry } from '@/types/models'
import {
  dateFromIso,
  displayName,
  hoursBetween,
  millisOf,
  punchErrorMessage,
  restaurantTimeInputValue,
  toDate,
  type PunchRow,
} from '../shiftsAndTipsShared'

const REASON_MAX = 500

function parseTime(hhmm: string): [number, number] {
  const [h, m] = hhmm.split(':').map(Number)
  return [h ?? 0, m ?? 0]
}

type HistoryItem =
  | { kind: 'punch'; field: 'clockIn' | 'clockOut'; entry: PunchEditHistoryEntry }
  | { kind: 'tip'; entry: TipReportEditHistoryEntry }

/**
 * "Edit punch" — mockup 25b. `editPunch` (functions/src/punchActions.ts)
 * corrects ONE punch document's timestamp; a pair whose in AND out both
 * changed means two calls sharing one reason (PROGRESS.md's note on why
 * the server stays single-document-per-call while this modal shows both
 * sides together). `editTipReport` either edits the row's existing report
 * or, when the row has none (the "missing tip report" flag), creates one
 * via its employeeId+date path.
 *
 * WAGE DELTA: the mockup shows "âˆ’0.2 hrs Â· âˆ’$3.60 in wages". This admin
 * screen only has `listEmployees()`'s profile half — `hourlyRate` lives in
 * `employees/{id}/private/compensation`, gated separately (employees.ts's
 * own module comment) and never fetched here. Rather than a second
 * permission-gated read (or, worse, a fabricated number for a salaried or
 * rate-less employee), this shows the HOURS delta only, with a one-line
 * note explaining the omission.
 */
export function PunchEditModal({
  row,
  employee,
  employeesById,
  actorName,
  canEditTimes,
  canEditTips,
  onClose,
  onSaved,
}: {
  row: PunchRow | null
  employee: Employee | null
  employeesById: Map<string, Employee>
  actorName: string
  canEditTimes: boolean
  canEditTips: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language

  const [clockInTime, setClockInTime] = useState('')
  const [clockOutTime, setClockOutTime] = useState('')
  const [tips, setTips] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inPhotoUrl, setInPhotoUrl] = useState<string | null>(null)
  const [outPhotoUrl, setOutPhotoUrl] = useState<string | null>(null)

  const originalInTime = row?.inPunch ? restaurantTimeInputValue(toDate(row.inPunch.timestamp) ?? new Date()) : ''
  const originalOutTime = row?.outPunch ? restaurantTimeInputValue(toDate(row.outPunch.timestamp) ?? new Date()) : ''
  const originalTips = row?.tipReport ? String(row.tipReport.amount) : ''

  useEffect(() => {
    setClockInTime(originalInTime)
    setClockOutTime(originalOutTime)
    setTips(originalTips)
    setReason('')
    setError(null)
    setInPhotoUrl(null)
    setOutPhotoUrl(null)

    if (!row) return
    let cancelled = false
    async function loadPhotos(currentRow: PunchRow) {
      const [inUrl, outUrl] = await Promise.all([
        currentRow.inPunch?.selfieStoragePath
          ? getDownloadURL(ref(storage, currentRow.inPunch.selfieStoragePath)).catch(() => null)
          : Promise.resolve(null),
        currentRow.outPunch?.selfieStoragePath
          ? getDownloadURL(ref(storage, currentRow.outPunch.selfieStoragePath)).catch(() => null)
          : Promise.resolve(null),
      ])
      if (!cancelled) {
        setInPhotoUrl(inUrl)
        setOutPhotoUrl(outUrl)
      }
    }
    void loadPhotos(row)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.key])

  const originalHours = useMemo(() => {
    if (!row?.inPunch || !row.outPunch) return null
    const inDate = toDate(row.inPunch.timestamp)
    const outDate = toDate(row.outPunch.timestamp)
    if (!inDate || !outDate) return null
    return hoursBetween(inDate, outDate)
  }, [row])

  const newHours = useMemo(() => {
    if (!row?.inPunch || !row.outPunch || !clockInTime || !clockOutTime) return null
    return hoursBetween(
      instantAtRestaurantWallClock(row.date, ...parseTime(clockInTime)),
      instantAtRestaurantWallClock(row.date, ...parseTime(clockOutTime)),
    )
  }, [row, clockInTime, clockOutTime])

  const hoursDelta = originalHours !== null && newHours !== null ? newHours - originalHours : null

  const clockInChanged = canEditTimes && !!row?.inPunch && clockInTime !== originalInTime && clockInTime !== ''
  const clockOutChanged = canEditTimes && !!row?.outPunch && clockOutTime !== originalOutTime && clockOutTime !== ''
  const tipsChanged =
    canEditTips &&
    !!row?.outPunch &&
    tips.trim() !== '' &&
    !Number.isNaN(Number(tips)) &&
    Number(tips) !== (row?.tipReport?.amount ?? Number.NaN)
  const hasChanges = clockInChanged || clockOutChanged || tipsChanged

  const history: HistoryItem[] = useMemo(() => {
    if (!row) return []
    const items: HistoryItem[] = []
    for (const entry of row.inPunch?.editHistory ?? []) items.push({ kind: 'punch', field: 'clockIn', entry })
    for (const entry of row.outPunch?.editHistory ?? []) items.push({ kind: 'punch', field: 'clockOut', entry })
    for (const entry of row.tipReport?.editHistory ?? []) items.push({ kind: 'tip', entry })
    return items.sort((a, b) => millisOf(b.entry.at) - millisOf(a.entry.at))
  }, [row])

  function timeLabel(date: Date | null): string {
    if (!date) return '—'
    return new Intl.DateTimeFormat(lang.startsWith('es') ? 'es' : 'en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date)
  }

  async function handleSave() {
    if (!row) return
    setError(null)
    if (!hasChanges) {
      setError(t('shiftsAndTips.editModal.noChanges'))
      return
    }
    if (!reason.trim()) {
      setError(t('clock.errors.reason-required'))
      return
    }

    setSubmitting(true)
    try {
      if (clockInChanged && row.inPunch) {
        await editPunch({
          punchId: row.inPunch.id,
          newTimestamp: instantAtRestaurantWallClock(row.date, ...parseTime(clockInTime)).toISOString(),
          reason: reason.trim(),
        })
      }
      if (clockOutChanged && row.outPunch) {
        await editPunch({
          punchId: row.outPunch.id,
          newTimestamp: instantAtRestaurantWallClock(row.date, ...parseTime(clockOutTime)).toISOString(),
          reason: reason.trim(),
        })
      }
      if (tipsChanged) {
        if (row.tipReport) {
          await editTipReport({ tipReportId: row.tipReport.id, newAmount: Number(tips), reason: reason.trim() })
        } else {
          await editTipReport({
            employeeId: row.employeeId,
            date: row.date,
            newAmount: Number(tips),
            reason: reason.trim(),
          })
        }
      }
      onSaved()
      onClose()
    } catch (err) {
      setError(punchErrorMessage(err, t))
    } finally {
      setSubmitting(false)
    }
  }

  if (!row || !employee) return null

  return (
    <Modal
      open={row !== null}
      onClose={onClose}
      title={t('shiftsAndTips.editModal.title')}
      subtitle={t('shiftsAndTips.editModal.subtitle', {
        name: displayName(employee),
        date: formatDate(dateFromIso(row.date), { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }, lang),
      })}
      footer={
        <>
          <Button onClick={onClose} disabled={submitting}>
            {t('shiftsAndTips.editModal.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void handleSave()} disabled={submitting}>
            {submitting ? t('shiftsAndTips.editModal.saving') : t('shiftsAndTips.editModal.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-6">
        {row.inPunch?.flagged && row.inPunch.flagReason === 'no-scheduled-shift' ? (
          <div className="rounded-card border border-warning/30 bg-warning-tint px-4 py-2.5 text-meta text-ink">
            {t('shiftsAndTips.flags.noScheduledShift')}
          </div>
        ) : null}
        {row.inPunch?.flagReason === 'forgotten-clockout' && !row.outPunch ? (
          <div className="rounded-card border border-danger/30 bg-danger-tint px-4 py-2.5 text-meta text-ink">
            {t('shiftsAndTips.flags.forgottenClockout')}
          </div>
        ) : null}
        {row.missingTipReport ? (
          <div className="rounded-card border border-warning/30 bg-warning-tint px-4 py-2.5 text-meta text-ink">
            {t('shiftsAndTips.flags.missingTipReport')}
          </div>
        ) : null}

        <div className="overflow-hidden rounded-card border border-line">
          <div className="grid grid-cols-[100px_1fr_24px_1fr] gap-2 border-b border-line bg-app px-4 py-2">
            <span className="text-micro font-bold uppercase tracking-wider text-ink-muted">
              {t('shiftsAndTips.editModal.fieldHeader')}
            </span>
            <span className="text-micro font-bold uppercase tracking-wider text-ink-muted">
              {t('shiftsAndTips.editModal.currentHeader')}
            </span>
            <span />
            <span className="pl-2 text-micro font-bold uppercase tracking-wider text-ink-muted">
              {t('shiftsAndTips.editModal.newHeader')}
            </span>
          </div>

          {row.inPunch ? (
            <div className="grid grid-cols-[100px_1fr_24px_1fr] items-center gap-2 border-b border-line px-4 py-3">
              <span className="text-meta font-medium text-ink">{t('shiftsAndTips.editModal.clockIn')}</span>
              <span className="tabular text-meta text-ink-muted">{timeLabel(toDate(row.inPunch.timestamp))}</span>
              <ArrowRight />
              <input
                type="time"
                value={clockInTime}
                disabled={!canEditTimes}
                onChange={(e) => setClockInTime(e.target.value)}
                className="tabular ml-2 w-full rounded-control border border-line bg-page px-2 py-1.5 text-meta font-semibold text-ink disabled:opacity-50"
              />
            </div>
          ) : null}

          {row.outPunch ? (
            <div className="grid grid-cols-[100px_1fr_24px_1fr] items-center gap-2 border-b border-line px-4 py-3">
              <span className="text-meta font-medium text-ink">{t('shiftsAndTips.editModal.clockOut')}</span>
              <span className="tabular text-meta text-ink-muted">{timeLabel(toDate(row.outPunch.timestamp))}</span>
              <ArrowRight />
              <input
                type="time"
                value={clockOutTime}
                disabled={!canEditTimes}
                onChange={(e) => setClockOutTime(e.target.value)}
                className="tabular ml-2 w-full rounded-control border border-line bg-page px-2 py-1.5 text-meta font-semibold text-ink disabled:opacity-50"
              />
            </div>
          ) : (
            <p className="border-b border-line px-4 py-3 text-meta text-ink-muted">
              {t('shiftsAndTips.editModal.stillOpenNote')}
            </p>
          )}

          {originalHours !== null ? (
            <div className="grid grid-cols-[100px_1fr_24px_1fr] items-center gap-2 border-b border-line px-4 py-3">
              <span className="text-meta font-medium text-ink">{t('shiftsAndTips.editModal.hours')}</span>
              <span className="tabular text-meta text-ink-muted">{originalHours.toFixed(1)} hrs</span>
              <ArrowRight />
              <div className="ml-2 flex flex-col">
                <span className="tabular text-meta font-semibold text-ink">
                  {(newHours ?? originalHours).toFixed(1)} hrs
                </span>
                {hoursDelta !== null && Math.abs(hoursDelta) > 0.001 ? (
                  <span className="text-chip text-ink-muted">{t('shiftsAndTips.editModal.recalculated')}</span>
                ) : null}
              </div>
            </div>
          ) : null}

          {row.outPunch ? (
            <div className="grid grid-cols-[100px_1fr_24px_1fr] items-center gap-2 px-4 py-3">
              <span className="text-meta font-medium text-ink">{t('shiftsAndTips.editModal.tips')}</span>
              <span className="tabular text-meta text-ink-muted">
                {row.tipReport ? formatCurrency(row.tipReport.amount, lang) : '—'}
              </span>
              <ArrowRight />
              <input
                type="number"
                min={0}
                step="0.01"
                value={tips}
                disabled={!canEditTips}
                onChange={(e) => setTips(e.target.value)}
                className="tabular ml-2 w-full rounded-control border border-line bg-page px-2 py-1.5 text-meta font-semibold text-ink disabled:opacity-50"
              />
            </div>
          ) : null}
        </div>

        {hoursDelta !== null && Math.abs(hoursDelta) > 0.001 ? (
          <div className="flex items-center justify-between rounded-card border border-line px-4 py-3">
            <span className="text-meta font-bold text-ink">{t('shiftsAndTips.editModal.netChange')}</span>
            <span className={`tabular text-meta font-semibold ${hoursDelta < 0 ? 'text-danger' : 'text-success'}`}>
              {t('shiftsAndTips.editModal.netChangeHours', {
                sign: hoursDelta > 0 ? '+' : '−',
                hours: Math.abs(hoursDelta).toFixed(1),
              })}
            </span>
          </div>
        ) : null}
        <p className="text-chip text-ink-muted">{t('shiftsAndTips.editModal.wageNote')}</p>

        {row.inPunch || row.outPunch ? (
          <div>
            <h3 className="mb-3 text-meta font-bold text-ink">{t('shiftsAndTips.editModal.photos')}</h3>
            <div className="grid grid-cols-2 gap-4">
              {row.inPunch ? (
                <PhotoTile url={inPhotoUrl} label={t('shiftsAndTips.editModal.photoClockIn', { time: timeLabel(toDate(row.inPunch.timestamp)) })} t={t} />
              ) : null}
              {row.outPunch ? (
                <PhotoTile url={outPhotoUrl} label={t('shiftsAndTips.editModal.photoClockOut', { time: timeLabel(toDate(row.outPunch.timestamp)) })} t={t} />
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="relative space-y-2">
          <label className="text-meta font-medium text-ink">{t('shiftsAndTips.editModal.reasonLabel')}</label>
          <textarea
            rows={3}
            maxLength={REASON_MAX}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('shiftsAndTips.editModal.reasonPlaceholder')}
            className="w-full resize-none rounded-control border border-line bg-page p-3 text-meta text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <span className="absolute bottom-2 right-3 text-chip text-ink-muted">
            {t('shiftsAndTips.editModal.charCount', { count: reason.length, max: REASON_MAX })}
          </span>
        </div>

        {history.length > 0 ? (
          <div className="space-y-3">
            <h3 className="text-meta font-bold text-ink">{t('shiftsAndTips.editModal.history')}</h3>
            <div className="space-y-3 rounded-card border border-line p-3">
              {history.map((item, i) => {
                const who = employeesById.get(item.entry.by)
                const name = who ? displayName(who) : t('shiftsAndTips.editModal.title')
                return (
                  <div key={i} className={i > 0 ? 'border-t border-line pt-3' : ''}>
                    <p className="text-meta text-ink">
                      {item.kind === 'punch'
                        ? t('shiftsAndTips.editModal.historyPunchChange', {
                            name,
                            field: t(`shiftsAndTips.editModal.field${item.field === 'clockIn' ? 'ClockIn' : 'ClockOut'}`),
                            from: timeLabel(toDate(item.entry.oldTimestamp)),
                            to: timeLabel(toDate(item.entry.newTimestamp)),
                          })
                        : t('shiftsAndTips.editModal.historyTipChange', {
                            name,
                            from: formatCurrency((item.entry as TipReportEditHistoryEntry).oldAmount, lang),
                            to: formatCurrency((item.entry as TipReportEditHistoryEntry).newAmount, lang),
                          })}
                    </p>
                    <p className="text-chip text-ink-muted">{formatDate(toDate(item.entry.at) ?? new Date(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, lang)}</p>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}

        {error ? <p className="text-meta text-danger">{error}</p> : null}

        <div className="flex gap-3 rounded-control border border-line bg-app px-3 py-2">
          <p className="text-chip text-ink-muted">
            {t('shiftsAndTips.editModal.auditNotice', {
              name: actorName,
              date: formatDate(new Date(), { month: 'short', day: 'numeric', year: 'numeric' }, lang),
            })}
          </p>
        </div>
      </div>
    </Modal>
  )
}

function PhotoTile({ url, label, t }: { url: string | null; label: string; t: (key: string) => string }) {
  return (
    <div className="space-y-2">
      <div className="flex h-24 items-center justify-center rounded-control border border-line bg-app">
        {url ? (
          <img src={url} alt={label} className="h-full w-full rounded-control object-cover" />
        ) : (
          <span className="text-chip text-ink-muted">{t('shiftsAndTips.editModal.noPhoto')}</span>
        )}
      </div>
      <span className="block text-chip text-ink-muted">{label}</span>
    </div>
  )
}

function ArrowRight() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-4 w-4 text-ink-muted" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default PunchEditModal
