import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, EmptyState, Modal, Pill, useToast } from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import { useAuth } from '@/lib/auth/AuthProvider'
import { listTimeOff, requestTimeOff } from '@/lib/db'
import { formatDate } from '@/lib/format'
import type { TimeOffCategory, TimeOffRequest } from '@/types/models'

/**
 * Staff time-off request — no mockup covers this screen (the 49 exported
 * frames only show the ADMIN side, mockup 36). Built plain: a request form
 * and a personal history list, using the same tokens and patterns as the
 * admin screen and MyAvailabilityPage next to it in the nav.
 */

function dateFromIso(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`)
}

export function MyTimeOffPage(): JSX.Element {
  return (
    <RequirePermission permission="timeoff.request">
      <MyTimeOffScreen />
    </RequirePermission>
  )
}

function MyTimeOffScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const { employee } = useAuth()

  const [requests, setRequests] = useState<TimeOffRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [formOpen, setFormOpen] = useState(false)

  const load = useCallback(async () => {
    if (!employee) return
    setLoading(true)
    setLoadError(false)
    try {
      setRequests(await listTimeOff({ employeeId: employee.id }))
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [employee])

  useEffect(() => {
    void load()
  }, [load])

  const sorted = useMemo(
    () => [...requests].sort((a, b) => b.startDate.localeCompare(a.startDate)),
    [requests],
  )

  function dateRangeLabel(r: TimeOffRequest): string {
    if (r.startDate === r.endDate) {
      return formatDate(dateFromIso(r.startDate), { month: 'short', day: 'numeric', year: 'numeric' }, lang)
    }
    return `${formatDate(dateFromIso(r.startDate), { month: 'short', day: 'numeric' }, lang)} – ${formatDate(
      dateFromIso(r.endDate),
      { month: 'short', day: 'numeric', year: 'numeric' },
      lang,
    )}`
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">
            {t('timeOff.my.title')}
          </h1>
          <p className="mt-0.5 text-meta text-ink-muted">{t('timeOff.my.subtitle')}</p>
        </div>
        <Button variant="primary" onClick={() => setFormOpen(true)}>
          {t('timeOff.my.newRequest')}
        </Button>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <div key={i} className="h-20 animate-skeleton rounded-card bg-app" />
          ))}
        </div>
      ) : loadError ? (
        <EmptyState
          illustration="search"
          title={t('timeOff.my.errorTitle')}
          body={t('timeOff.my.errorBody')}
          action={<Button onClick={() => void load()}>{t('common.retry')}</Button>}
        />
      ) : sorted.length === 0 ? (
        <EmptyState
          illustration="tasks"
          title={t('timeOff.my.emptyTitle')}
          body={t('timeOff.my.emptyBody')}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {sorted.map((r) => (
            <li key={r.id} className="rounded-card border border-line bg-page p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-meta font-semibold text-ink">{dateRangeLabel(r)}</p>
                  <p className="mt-0.5 text-chip text-ink-muted">{t(`timeOff.category.${r.category}`)}</p>
                  {r.reason ? <p className="mt-1 text-chip text-ink">{r.reason}</p> : null}
                  {r.status === 'declined' && r.declineReason ? (
                    <p className="mt-1 text-chip text-danger">{r.declineReason}</p>
                  ) : null}
                </div>
                <Pill tone={r.status}>{t(`status.${r.status}`)}</Pill>
              </div>
            </li>
          ))}
        </ul>
      )}

      <RequestModal
        open={formOpen}
        employeeId={employee?.id ?? null}
        onClose={() => setFormOpen(false)}
        onSubmitted={() => {
          setFormOpen(false)
          void load()
        }}
      />
    </div>
  )
}

function RequestModal({
  open,
  employeeId,
  onClose,
  onSubmitted,
}: {
  open: boolean
  employeeId: string | null
  onClose: () => void
  onSubmitted: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const startId = useId()
  const endId = useId()
  const reasonId = useId()

  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [category, setCategory] = useState<TimeOffCategory>('unpaid')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setStartDate('')
      setEndDate('')
      setCategory('unpaid')
      setReason('')
      setError(null)
    }
  }, [open])

  const valid = startDate !== '' && endDate !== '' && endDate >= startDate

  async function handleSubmit(): Promise<void> {
    if (!employeeId || !valid) {
      setError(t('timeOff.my.form.invalidRange'))
      return
    }
    setSubmitting(true)
    try {
      await requestTimeOff({ employeeId, startDate, endDate, category, reason: reason.trim() })
      toast.show({ tone: 'success', message: t('timeOff.my.toast.submitted') })
      onSubmitted()
    } catch {
      toast.show({ tone: 'error', message: t('timeOff.my.toast.submitFailed') })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('timeOff.my.newRequest')}
      footer={
        <>
          <Button onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={submitting} onClick={() => void handleSubmit()}>
            {submitting ? t('timeOff.my.form.submitting') : t('timeOff.my.form.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={startId} className="mb-1 block text-chip font-medium text-ink-muted">
              {t('timeOff.my.form.startDate')}
            </label>
            <input
              id={startId}
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full rounded-control border border-line bg-page px-3 py-2 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label htmlFor={endId} className="mb-1 block text-chip font-medium text-ink-muted">
              {t('timeOff.my.form.endDate')}
            </label>
            <input
              id={endId}
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full rounded-control border border-line bg-page px-3 py-2 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        <div>
          <span className="mb-1 block text-chip font-medium text-ink-muted">
            {t('timeOff.my.form.category')}
          </span>
          <div className="flex gap-2">
            {(['unpaid', 'paid'] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setCategory(c)}
                className={[
                  'rounded-control border px-3 py-1.5 text-chip font-medium',
                  category === c
                    ? 'border-primary bg-primary-tint text-primary'
                    : 'border-line text-ink-muted hover:text-ink',
                ].join(' ')}
              >
                {t(`timeOff.category.${c}`)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor={reasonId} className="mb-1 block text-chip font-medium text-ink-muted">
            {t('timeOff.my.form.reason')}
          </label>
          <textarea
            id={reasonId}
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-control border border-line bg-page p-3 text-meta text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {error ? <p className="text-chip font-medium text-danger">{error}</p> : null}
      </div>
    </Modal>
  )
}

export default MyTimeOffPage
