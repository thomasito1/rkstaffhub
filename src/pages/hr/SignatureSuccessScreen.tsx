import { useTranslation } from 'react-i18next'

import { formatDate, formatTime } from '@/lib/format'
import type { Employee, Policy, Signature } from '@/types/models'

import { CheckIcon, ChevronRightIcon, FileTextIcon } from './icons'

/**
 * Post-signature confirmation — mockup 30c. `signature` is the freshly
 * created record re-fetched via `getSignature` (src/lib/db/signatures.ts) so
 * the signed-at timestamp shown here is the server's own, not a client
 * guess; `signedAtFallback` covers the read being permission-denied or still
 * propagating right after the write (best-effort display only, never used
 * for anything that matters — the server document is the source of truth).
 *
 * Mockup 30c also offers a "Download a copy" action; that needs a Storage
 * download-URL lookup with no existing client wrapper (out of scope — see
 * this task's own constraint against touching `db/signatures.ts`), so it is
 * intentionally left out rather than wired to a broken button.
 */
export function SignatureSuccessScreen({
  policy,
  employee,
  signatureId,
  signature,
  signedAtFallback,
  remaining,
  onSignNext,
  onDone,
}: {
  policy: Policy
  employee: Employee
  signatureId: string
  signature: Signature | null
  signedAtFallback: Date
  remaining: Policy[]
  onSignNext: (policy: Policy) => void
  onDone: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language

  const signedAt = toDate(signature?.signedAt) ?? signedAtFallback
  const activeFromDate = policy.activeFrom ? new Date(`${policy.activeFrom}T00:00:00`) : null
  const employeeName = `${employee.preferredName || employee.firstName} ${employee.lastName}`.trim()
  const nextUp = remaining[0] ?? null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-page pl-safe pr-safe">
      <div aria-hidden="true" className="h-safe-top w-full shrink-0 bg-page" />

      <main className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-8">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-[88px] w-[88px] items-center justify-center rounded-full bg-success-tint">
            <CheckIcon className="h-10 w-10 text-success" />
          </div>
          <h1 className="text-title-lg font-semibold leading-tight text-ink">{t('hr.success.title')}</h1>
          <p className="mt-1 max-w-[30ch] text-meta leading-snug text-ink-muted">{t('hr.success.subtitle')}</p>
        </div>

        <div className="mb-6 rounded-card-lg border border-line bg-page p-5">
          <div className="mb-4 flex items-start gap-3">
            <div className="rounded-lg bg-app p-2 text-ink-muted">
              <FileTextIcon className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-meta font-semibold text-ink">{policy.title}</h2>
              <p className="text-chip text-ink-muted">{t('hr.success.versionLabel', { version: policy.version })}</p>
            </div>
          </div>

          <div className="mb-2 space-y-0">
            <ReceiptRow label={t('hr.success.signedBy')} value={employeeName} />
            <ReceiptRow label={t('hr.success.date')} value={formatDate(signedAt, { dateStyle: 'medium' }, lang)} />
            <ReceiptRow label={t('hr.success.time')} value={formatTime(signedAt, lang)} last={!activeFromDate} />
            {activeFromDate ? (
              <ReceiptRow label={t('hr.success.effective')} value={formatDate(activeFromDate, { dateStyle: 'medium' }, lang)} />
            ) : null}
            <ReceiptRow label={t('hr.success.reference')} value={signatureId} last />
          </div>

          {signature?.emailedTo ? (
            <div className="mt-2 flex items-center gap-2 border-t border-line pt-3">
              <CheckIcon className="h-3.5 w-3.5 text-success" />
              <span className="text-chip text-ink-muted">
                {t('hr.success.emailedTo', { email: signature.emailedTo })}
              </span>
            </div>
          ) : signature?.emailPending ? (
            <div className="mt-2 flex items-center gap-2 border-t border-line pt-3">
              <span className="text-chip text-warning">{t('hr.success.emailPending')}</span>
            </div>
          ) : null}
        </div>

        {nextUp ? (
          <div className="rounded-card-lg border border-line bg-page p-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-meta font-semibold text-ink">{t('hr.success.stillNeedsTitle')}</h3>
              <span className="tabular rounded-full bg-warning-tint px-2 py-0.5 text-chip font-bold text-warning">
                {remaining.length}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onSignNext(nextUp)}
              className="flex w-full items-center gap-3 py-1 text-left"
            >
              <div className="shrink-0 rounded-lg bg-app p-2 text-ink-muted">
                <FileTextIcon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-meta font-semibold text-ink">{nextUp.title}</p>
              </div>
              <ChevronRightIcon className="h-4 w-4 shrink-0 text-ink-muted" />
            </button>
          </div>
        ) : null}
      </main>

      <div className="shrink-0 space-y-3 bg-page px-4 pb-4 pt-2">
        {nextUp ? (
          <button
            type="button"
            onClick={() => onSignNext(nextUp)}
            className="flex h-14 w-full items-center justify-center rounded-control bg-primary font-semibold text-white"
          >
            {t('hr.success.signNext')}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onDone}
          className="flex h-12 w-full items-center justify-center text-meta font-medium text-ink-muted"
        >
          {t('hr.success.done')}
        </button>
      </div>

      <div aria-hidden="true" className="h-safe-bottom w-full shrink-0 bg-page" />
    </div>
  )
}

function ReceiptRow({ label, value, last = false }: { label: string; value: string; last?: boolean }): JSX.Element {
  return (
    <div className={`flex items-center justify-between py-2 ${last ? '' : 'border-b border-line'}`}>
      <span className="text-chip font-medium text-ink-muted">{label}</span>
      <span className="tabular text-meta font-semibold text-ink">{value}</span>
    </div>
  )
}

function toDate(value: unknown): Date | null {
  if (value && typeof value === 'object' && 'toDate' in value) {
    return (value as { toDate(): Date }).toDate()
  }
  return null
}

export default SignatureSuccessScreen
