import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState, Pill, type PillTone } from '@/components/ui'
import { useAuth } from '@/lib/auth/AuthProvider'
import { findSignatureForTarget, getSignature } from '@/lib/db'
import type { Policy, Signature } from '@/types/models'

import { FileTextIcon } from './icons'
import { PolicyReadScreen } from './PolicyReadScreen'
import { SignatureCanvasScreen } from './SignatureCanvasScreen'
import { SignatureSuccessScreen } from './SignatureSuccessScreen'
import { useHrHubData } from './useHrHubData'

/**
 * HR hub — staff-facing entry point, spec §12/Phase 4. Replaces the
 * `PlaceholderPage` App.tsx previously mounted at `/hr`.
 *
 * No mockup exists for the LIST screen itself (checked `.superdesign/export`
 * and the `batch-m3-mobile.json` prompt behind mockups 30a–c — they start
 * mid-flow, already on a specific policy, and every "back to home" link in
 * them points at a screen outside this task's four mockups). The read →
 * sign → success steps that follow ARE mockups 30a/30b/30c and are
 * reproduced closely; this list is new design work in the same spirit as
 * `ShiftTemplatesPage`'s own "no mockup exists" screens — this codebase's
 * established list/EmptyState/Pill vocabulary, not a fresh visual language.
 */

type PolicyStatus = 'needs-signature' | 'needs-resign' | 'signed' | 'no-signature-required'

function statusFor(policy: Policy, signatures: Signature[]): PolicyStatus {
  if (!policy.requiresSignature) return 'no-signature-required'
  const sig = findSignatureForTarget(signatures, 'policy', policy.id)
  if (!sig) return 'needs-signature'
  if (sig.policyVersion !== policy.version) return 'needs-resign'
  return 'signed'
}

const STATUS_TONE: Record<PolicyStatus, PillTone> = {
  'needs-signature': 'pending',
  'needs-resign': 'pending',
  signed: 'approved',
  'no-signature-required': 'neutral',
}

type Step =
  | { kind: 'list' }
  | { kind: 'read'; policy: Policy }
  | { kind: 'sign'; policy: Policy }
  | { kind: 'success'; policy: Policy; signatureId: string; signature: Signature | null; signedAtFallback: Date }

export function HrHubPage(): JSX.Element {
  const { t } = useTranslation()
  const { employee } = useAuth()
  const data = useHrHubData(employee)
  const [step, setStep] = useState<Step>({ kind: 'list' })

  const sorted = useMemo(() => [...data.policies].sort((a, b) => a.title.localeCompare(b.title)), [data.policies])
  const needsAction = sorted.filter((p) => {
    const s = statusFor(p, data.signatures)
    return s === 'needs-signature' || s === 'needs-resign'
  })
  const rest = sorted.filter((p) => !needsAction.includes(p))

  async function handleSigned(policy: Policy, signatureId: string) {
    const signedAtFallback = new Date()
    let signature: Signature | null = null
    try {
      signature = await getSignature(signatureId)
    } catch {
      signature = null
    }
    await data.reload()
    setStep({ kind: 'success', policy, signatureId, signature, signedAtFallback })
  }

  if (!employee) {
    return (
      <div className="mx-auto max-w-lg pt-10">
        <EmptyState illustration="search" title={t('app.loading')} body="" />
      </div>
    )
  }

  if (step.kind === 'read') {
    return (
      <PolicyReadScreen
        policy={step.policy}
        requiresSignature={step.policy.requiresSignature && statusFor(step.policy, data.signatures) !== 'signed'}
        onClose={() => setStep({ kind: 'list' })}
        onContinueToSign={() => setStep({ kind: 'sign', policy: step.policy })}
      />
    )
  }

  if (step.kind === 'sign') {
    return (
      <SignatureCanvasScreen
        policy={step.policy}
        employee={employee}
        onBack={() => setStep({ kind: 'read', policy: step.policy })}
        onCancel={() => setStep({ kind: 'list' })}
        onSigned={(signatureId) => void handleSigned(step.policy, signatureId)}
      />
    )
  }

  if (step.kind === 'success') {
    // Recompute against the just-reloaded data so "still needs signature"
    // reflects the signature that was just submitted, not a stale snapshot.
    const remaining = [...data.policies]
      .filter((p) => p.id !== step.policy.id)
      .filter((p) => {
        const s = statusFor(p, data.signatures)
        return s === 'needs-signature' || s === 'needs-resign'
      })
      .sort((a, b) => a.title.localeCompare(b.title))

    return (
      <SignatureSuccessScreen
        policy={step.policy}
        employee={employee}
        signatureId={step.signatureId}
        signature={step.signature}
        signedAtFallback={step.signedAtFallback}
        remaining={remaining}
        onSignNext={(policy) => setStep({ kind: 'read', policy })}
        onDone={() => setStep({ kind: 'list' })}
      />
    )
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 pb-4">
      <header>
        <h1 className="text-title font-semibold leading-tight text-ink">{t('hr.hub.title')}</h1>
        <p className="mt-0.5 text-meta text-ink-muted">{t('hr.hub.subtitle')}</p>
      </header>

      {data.loading ? (
        <div className="flex flex-col gap-4">
          <div className="h-20 animate-skeleton rounded-card-lg bg-app" />
          <div className="h-20 animate-skeleton rounded-card-lg bg-app" />
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState illustration="search" title={t('hr.hub.emptyTitle')} body={t('hr.hub.emptyBody')} />
      ) : (
        <>
          {needsAction.length > 0 ? (
            <Section titleKey="hr.hub.groupNeedsSignature" count={needsAction.length}>
              {needsAction.map((p) => (
                <PolicyRow key={p.id} policy={p} status={statusFor(p, data.signatures)} onOpen={() => setStep({ kind: 'read', policy: p })} />
              ))}
            </Section>
          ) : null}

          <Section titleKey="hr.hub.groupAll" count={rest.length}>
            {rest.map((p) => (
              <PolicyRow key={p.id} policy={p} status={statusFor(p, data.signatures)} onOpen={() => setStep({ kind: 'read', policy: p })} />
            ))}
          </Section>
        </>
      )}
    </div>
  )
}

function Section({
  titleKey,
  count,
  children,
}: {
  titleKey: string
  count: number
  children: ReactNode
}): JSX.Element | null {
  const { t } = useTranslation()
  if (count === 0) return null
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-chip font-semibold uppercase tracking-widest text-ink-muted">
        {t(titleKey)} <span className="opacity-50">{count}</span>
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function PolicyRow({
  policy,
  status,
  onOpen,
}: {
  policy: Policy
  status: PolicyStatus
  onOpen: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const title = lang.startsWith('es') && policy.titleEs ? policy.titleEs : policy.title

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-4 rounded-card-lg border border-line bg-page p-4 text-left transition-colors duration-hover hover:bg-hover"
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-app text-ink-muted">
        <FileTextIcon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-meta font-semibold text-ink">{title}</p>
        <p className="tabular text-chip text-ink-muted">{t('hr.hub.versionLabel', { version: policy.version })}</p>
      </div>
      {status !== 'no-signature-required' ? <Pill tone={STATUS_TONE[status]}>{t(`hr.hub.status.${status}`)}</Pill> : null}
    </button>
  )
}

export default HrHubPage
