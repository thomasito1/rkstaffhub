import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Avatar, Button, Modal } from '@/components/ui'
import { instantAtRestaurantWallClock, weekIdForIsoDate } from '@/lib/deadlines'
import { listShifts } from '@/lib/db'
import { formatDate } from '@/lib/format'
import { manualPunch } from '@/lib/timeClock/punchActions'
import type { Employee, Shift } from '@/types/models'
import {
  dateFromIso,
  displayName,
  hoursBetween,
  punchErrorMessage,
  roleDisplayName,
  roleLabel,
} from '../shiftsAndTipsShared'

const REASON_MAX = 500

function parseTime(hhmm: string): [number, number] {
  const [h, m] = hhmm.split(':').map(Number)
  return [h ?? 0, m ?? 0]
}

/**
 * "Add manual punch" — mockup 24. Calls `manualPunch` (functions/src/
 * punchActions.ts), which accepts clockIn, clockOut, or both (a complete
 * pair created in one call — PROGRESS.md's note on why this isn't two
 * calls). No "notify the employee" checkbox: the mockup shows one, but
 * `manualPunch`'s actual contract has no notify parameter and sends no
 * push — same "build against the real contract, not the mockup's extra
 * affordance" rule the flag-label note above already applies to this task.
 */
export function ManualPunchModal({
  open,
  eligibleEmployees,
  roleMap,
  defaultDate,
  initialEmployeeId,
  actorName,
  onClose,
  onCreated,
}: {
  open: boolean
  eligibleEmployees: Employee[]
  roleMap: Map<string, import('@/types/models').ShiftRole>
  defaultDate: string
  /** Pre-selects an employee — e.g. "Add manual clock-out" on an already-open punch. */
  initialEmployeeId?: string
  actorName: string
  onClose: () => void
  onCreated: () => void
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language

  const [query, setQuery] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [employeeId, setEmployeeId] = useState<string | null>(null)
  const [date, setDate] = useState(defaultDate)
  const [clockInTime, setClockInTime] = useState('')
  const [clockOutTime, setClockOutTime] = useState('')
  const [tips, setTips] = useState('')
  const [reason, setReason] = useState('')
  const [scheduledShift, setScheduledShift] = useState<Shift | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setPickerOpen(false)
    setEmployeeId(initialEmployeeId ?? null)
    setDate(defaultDate)
    setClockInTime('')
    setClockOutTime('')
    setTips('')
    setReason('')
    setScheduledShift(null)
    setError(null)
  }, [open, defaultDate, initialEmployeeId])

  useEffect(() => {
    if (!pickerOpen) return
    function onPointerDown(e: MouseEvent) {
      if (!pickerRef.current?.contains(e.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [pickerOpen])

  useEffect(() => {
    if (!employeeId || !date) {
      setScheduledShift(null)
      return
    }
    let cancelled = false
    listShifts(weekIdForIsoDate(date), { employeeId, date })
      .then((shifts) => {
        if (!cancelled) setScheduledShift(shifts[0] ?? null)
      })
      .catch(() => {
        if (!cancelled) setScheduledShift(null)
      })
    return () => {
      cancelled = true
    }
  }, [employeeId, date])

  const selectedEmployee = employeeId ? eligibleEmployees.find((e) => e.id === employeeId) ?? null : null

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const list = needle
      ? eligibleEmployees.filter((e) => displayName(e).toLowerCase().includes(needle))
      : eligibleEmployees
    return list.slice(0, 8)
  }, [eligibleEmployees, query])

  const totalHours = useMemo(() => {
    if (!clockInTime || !clockOutTime) return null
    const [ih, im] = parseTime(clockInTime)
    const [oh, om] = parseTime(clockOutTime)
    return hoursBetween(
      instantAtRestaurantWallClock(date, ih, im),
      instantAtRestaurantWallClock(date, oh, om),
    )
  }, [clockInTime, clockOutTime, date])

  const withinFiveMinutes = useMemo(() => {
    if (!scheduledShift) return false
    const check = (time: string, target: string) => {
      const [h, m] = parseTime(time)
      const [th, tm] = parseTime(target)
      const actual = instantAtRestaurantWallClock(date, h, m).getTime()
      const wanted = instantAtRestaurantWallClock(date, th, tm).getTime()
      return Math.abs(actual - wanted) <= 5 * 60 * 1000
    }
    if (clockInTime && check(clockInTime, scheduledShift.startTime)) return true
    if (clockOutTime && check(clockOutTime, scheduledShift.endTime)) return true
    return false
  }, [scheduledShift, clockInTime, clockOutTime, date])

  async function handleSubmit() {
    setError(null)
    if (!employeeId) {
      setError(t('shiftsAndTips.manualPunch.errors.employeeRequired'))
      return
    }
    if (!clockInTime && !clockOutTime) {
      setError(t('shiftsAndTips.manualPunch.errors.timeRequired'))
      return
    }
    if (!reason.trim()) {
      setError(t('shiftsAndTips.manualPunch.errors.reasonRequired'))
      return
    }

    setSubmitting(true)
    try {
      const clockIn = clockInTime
        ? instantAtRestaurantWallClock(date, ...parseTime(clockInTime)).toISOString()
        : undefined
      const clockOut = clockOutTime
        ? instantAtRestaurantWallClock(date, ...parseTime(clockOutTime)).toISOString()
        : undefined
      const tipsAmount = clockOutTime && tips.trim() !== '' ? Number(tips) : undefined

      await manualPunch({ employeeId, clockIn, clockOut, tipsAmount, reason: reason.trim() })
      onCreated()
      onClose()
    } catch (err) {
      setError(punchErrorMessage(err, t))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('shiftsAndTips.manualPunch.title')}
      subtitle={t('shiftsAndTips.manualPunch.subtitle', {
        date: formatDate(dateFromIso(date), { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }, lang),
      })}
      footer={
        <>
          <Button onClick={onClose} disabled={submitting}>
            {t('shiftsAndTips.manualPunch.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? t('shiftsAndTips.manualPunch.submitting') : t('shiftsAndTips.manualPunch.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="flex gap-3 rounded-card border border-warning/30 bg-warning-tint p-4">
          <p className="text-meta leading-relaxed text-ink">{t('shiftsAndTips.manualPunch.advisory')}</p>
        </div>

        <div className="flex flex-col gap-2" ref={pickerRef}>
          <label htmlFor={inputId} className="text-meta font-medium text-ink-muted">
            {t('shiftsAndTips.manualPunch.employeeLabel')} <span className="text-danger">*</span>
          </label>
          {selectedEmployee && !pickerOpen ? (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="flex h-[52px] items-center justify-between rounded-control border border-line bg-page px-3 text-left shadow-sm"
            >
              <span className="flex items-center gap-3">
                <Avatar
                  firstName={selectedEmployee.firstName}
                  lastName={selectedEmployee.lastName}
                  photoUrl={selectedEmployee.photoUrl}
                  size={24}
                />
                <span className="flex flex-col">
                  <span className="text-meta font-medium text-ink">{displayName(selectedEmployee)}</span>
                  <span className="text-chip text-ink-muted">
                    {roleLabel(selectedEmployee, roleMap, lang, (level) => t('people.levelShort', { level }))}
                  </span>
                </span>
              </span>
              <span className="text-chip font-medium text-primary">{t('shiftsAndTips.manualPunch.changeEmployee')}</span>
            </button>
          ) : (
            <div className="relative">
              <input
                id={inputId}
                type="text"
                value={query}
                autoFocus
                onFocus={() => setPickerOpen(true)}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setPickerOpen(true)
                }}
                placeholder={t('shiftsAndTips.manualPunch.employeeSearchPlaceholder')}
                className="h-[44px] w-full rounded-control border border-line bg-page px-3 text-meta text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
              {pickerOpen ? (
                <div className="absolute z-10 mt-1 max-h-56 w-full overflow-y-auto rounded-card border border-line bg-page shadow-elevated">
                  {filtered.length === 0 ? (
                    <p className="px-3 py-2 text-meta text-ink-muted">
                      {t('shiftsAndTips.manualPunch.noEligibleEmployees')}
                    </p>
                  ) : (
                    filtered.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        onClick={() => {
                          setEmployeeId(e.id)
                          setQuery('')
                          setPickerOpen(false)
                        }}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-hover hover:bg-hover"
                      >
                        <Avatar firstName={e.firstName} lastName={e.lastName} photoUrl={e.photoUrl} size={24} />
                        <span className="flex flex-col">
                          <span className="text-meta font-medium text-ink">{displayName(e)}</span>
                          <span className="text-chip text-ink-muted">
                            {roleLabel(e, roleMap, lang, (level) => t('people.levelShort', { level }))}
                          </span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <label className="text-meta font-medium text-ink-muted">{t('shiftsAndTips.manualPunch.dateLabel')}</label>
          <input
            type="date"
            value={date}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => setDate(e.target.value)}
            className="h-[44px] rounded-control border border-line bg-page px-3 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <label className="text-meta font-medium text-ink-muted">{t('shiftsAndTips.manualPunch.clockInLabel')}</label>
            <input
              type="time"
              value={clockInTime}
              onChange={(e) => setClockInTime(e.target.value)}
              className="h-[44px] rounded-control border border-line bg-page px-3 text-meta tabular text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-meta font-medium text-ink-muted">{t('shiftsAndTips.manualPunch.clockOutLabel')}</label>
            <input
              type="time"
              value={clockOutTime}
              onChange={(e) => setClockOutTime(e.target.value)}
              className="h-[44px] rounded-control border border-line bg-page px-3 text-meta tabular text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
        {totalHours !== null ? (
          <p className="tabular text-chip font-medium text-ink-muted">
            {t('shiftsAndTips.manualPunch.totalHours', { hours: totalHours.toFixed(1) })}
          </p>
        ) : null}

        {employeeId ? (
          <div className="flex flex-col gap-2">
            <label className="text-meta font-medium text-ink-muted">
              {t('shiftsAndTips.manualPunch.scheduledShiftLabel')}
            </label>
            {scheduledShift ? (
              <div className="rounded-control border border-line bg-app p-3">
                <div className="flex items-center gap-3">
                  <span
                    className="rounded px-2 py-0.5 text-micro font-bold uppercase tracking-wider text-white"
                    style={{ backgroundColor: roleMap.get(scheduledShift.roleId)?.color ?? '#6B7280' }}
                  >
                    {roleDisplayName(roleMap.get(scheduledShift.roleId), lang)}
                  </span>
                  <span className="text-meta font-medium text-ink">
                    {scheduledShift.startTime} – {scheduledShift.endTime}
                    {scheduledShift.station ? ` · ${scheduledShift.station}` : ''}
                  </span>
                </div>
                {withinFiveMinutes ? (
                  <p className="mt-1.5 text-chip text-success">{t('shiftsAndTips.manualPunch.withinFiveMinutes')}</p>
                ) : null}
              </div>
            ) : (
              <p className="text-chip text-ink-muted">{t('shiftsAndTips.manualPunch.noScheduledShift')}</p>
            )}
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <label className="text-meta font-medium text-ink-muted">{t('shiftsAndTips.manualPunch.tipsLabel')}</label>
          <div className="flex h-[44px] items-center rounded-control border border-line bg-page px-3">
            <span className="mr-1 text-ink-muted">$</span>
            <input
              type="number"
              min={0}
              step="0.01"
              value={tips}
              onChange={(e) => setTips(e.target.value)}
              placeholder="0.00"
              className="w-full bg-transparent text-meta tabular text-ink focus:outline-none"
            />
          </div>
          <p className="text-chip text-ink-muted">{t('shiftsAndTips.manualPunch.tipsHint')}</p>
        </div>

        <div className="relative flex flex-col gap-2">
          <label className="text-meta font-medium text-ink-muted">
            {t('shiftsAndTips.manualPunch.reasonLabel')} <span className="text-danger">*</span>
          </label>
          <textarea
            rows={3}
            maxLength={REASON_MAX}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('shiftsAndTips.manualPunch.reasonPlaceholder')}
            className="w-full resize-none rounded-control border border-line bg-page p-3 text-meta text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <span className="absolute bottom-2 right-3 text-chip text-ink-muted">
            {t('shiftsAndTips.editModal.charCount', { count: reason.length, max: REASON_MAX })}
          </span>
        </div>

        {error ? <p className="text-meta text-danger">{error}</p> : null}

        <div className="flex gap-3 rounded-control border border-line bg-app px-3 py-2">
          <p className="text-chip text-ink-muted">
            {t('shiftsAndTips.manualPunch.auditNotice', {
              name: actorName,
              date: formatDate(new Date(), { month: 'short', day: 'numeric', year: 'numeric' }, lang),
            })}
          </p>
        </div>
      </div>
    </Modal>
  )
}

export default ManualPunchModal
