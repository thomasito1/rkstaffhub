import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Button, Card, Pill } from '@/components/ui'
import { acceptInvite, fetchInvite, type InvitePreview } from '@/lib/auth/authActions'
import { toAuthError } from '@/lib/auth/authErrors'
import {
  AuthField,
  AuthNotice,
  BrandLockup,
  CheckIcon,
  GoogleButton,
  LanguageToggle,
  LockIcon,
  MailIcon,
  OrDivider,
  PasswordField,
  PhoneMethod,
  Spinner,
  usePhoneOtpEnabled,
} from '@/pages/auth/LoginPage'

/**
 * Invite acceptance — `.superdesign/export/02-invite-acceptance-desktop-en.html`.
 *
 * The mockup draws all three panels side by side to show the whole sequence on
 * one frame. This is the real thing, so they are sequential states of a single
 * card, with the mockup's step caption above it.
 *
 * SECURITY (spec §2): this screen authenticates the person and then hands the
 * token to the `acceptInvite` Cloud Function. It never writes the employee
 * document and never sets custom claims — binding uid → employee and issuing
 * `role` / `employeeId` is server work, because firestore.rules keys off those
 * claims. See `authActions.acceptInvite`.
 */

type Step = 'loading' | 'unavailable' | 'invitation' | 'method' | 'success'

// ═══ Password strength (mockup: three-segment bar + label) ═══════════════════

/**
 * The rule the mockup states under the bar: "At least 8 characters with one
 * number." That is the floor, and it scores 2 of 3 — matching the mockup's two
 * filled teal segments labelled "Good". The third segment is earned by length
 * or a mix of character classes.
 */
export function passwordScore(pw: string): 0 | 1 | 2 | 3 {
  if (!pw) return 0
  const longEnough = pw.length >= 8
  const hasDigit = /\d/.test(pw)
  if (!longEnough || !hasDigit) return 1
  const strong =
    pw.length >= 12 ||
    /[^A-Za-z0-9]/.test(pw) ||
    (/[a-z]/.test(pw) && /[A-Z]/.test(pw))
  return strong ? 3 : 2
}

export const passwordMeetsPolicy = (pw: string) => passwordScore(pw) >= 2

function PasswordStrength({ password }: { password: string }) {
  const { t } = useTranslation()
  const score = passwordScore(password)
  const tone = score >= 2 ? 'bg-success' : 'bg-danger'
  const textTone = score >= 2 ? 'text-success' : 'text-danger'
  const label =
    score === 0 ? null : score === 1 ? t('auth.strengthWeak') : score === 2 ? t('auth.strengthGood') : t('auth.strengthStrong')

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        {[1, 2, 3].map((seg) => (
          <div
            key={seg}
            className={`h-1.5 flex-1 rounded-full ${score >= seg ? tone : 'bg-line'}`}
          />
        ))}
        {label ? (
          <span className={`ml-2 text-chip font-semibold ${textTone}`} aria-live="polite">
            {label}
          </span>
        ) : null}
      </div>
      <p className="text-chip text-ink-muted">{t('auth.passwordRule')}</p>
    </div>
  )
}

// ═══ Shell ═══════════════════════════════════════════════════════════════════

function InviteShell({
  captionKey,
  centered = false,
  children,
}: {
  captionKey: string
  centered?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-screen justify-center bg-app px-4 py-8 md:items-center md:p-12">
      <div className="flex w-full max-w-[400px] flex-col gap-3">
        <span className="ml-1 text-chip font-semibold uppercase tracking-widest text-ink-muted">
          {t(captionKey)}
        </span>
        <Card padded={false} className={`p-8 ${centered ? 'text-center' : ''}`}>
          {/* The lockup is centred on all three panels in the mockup, even the
              left-aligned step 2. */}
          <div className="mb-8 flex flex-col items-center">
            <BrandLockup align="center" size="sm" />
          </div>
          {children}
          <div className="mt-10 flex justify-center border-t border-line pt-6">
            <LanguageToggle />
          </div>
        </Card>
      </div>
    </div>
  )
}

// ═══ Page ════════════════════════════════════════════════════════════════════

export function InviteAcceptPage() {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const params = useParams()
  const phoneOtpEnabled = usePhoneOtpEnabled()

  // Invite links may carry the token either way; accept both.
  const token = searchParams.get('token') ?? params['token'] ?? ''

  const [step, setStep] = useState<Step>('loading')
  const [invite, setInvite] = useState<InvitePreview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<null | 'google' | 'password'>(null)

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [confirmTouched, setConfirmTouched] = useState(false)

  const load = useCallback(() => {
    setStep('loading')
    setLoadError(null)
    void (async () => {
      try {
        setInvite(await fetchInvite(token))
        setStep('invitation')
      } catch (err) {
        // The `getInvite` callable is not deployed yet. Rather than a blank
        // screen, this is an explicit, retryable state — and it is the same
        // state a revoked or mistyped token produces.
        setLoadError(t(toAuthError(err).messageKey))
        setStep('unavailable')
      }
    })()
  }, [t, token])

  useEffect(load, [load])

  const accept = useCallback(
    (method: 'google' | 'password', pw?: string) => {
      setPending(method)
      setError(null)
      void (async () => {
        try {
          await acceptInvite(token, method, pw)
          setStep('success')
        } catch (err) {
          const info = toAuthError(err)
          if (!info.cancelled) setError(t(info.messageKey))
        } finally {
          setPending(null)
        }
      })()
    },
    [t, token],
  )

  const onCreateAccount = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending) return
    setConfirmTouched(true)
    if (!passwordMeetsPolicy(password) || password !== confirm) return
    accept('password', password)
  }

  // ── Step 0: loading ───────────────────────────────────────────────────────
  if (step === 'loading') {
    return (
      <InviteShell captionKey="auth.invite.step1Caption" centered>
        <div className="flex flex-col items-center gap-3 py-8 text-ink-muted">
          <Spinner className="h-6 w-6" />
          <p className="text-meta">{t('app.loading')}</p>
        </div>
      </InviteShell>
    )
  }

  // ── Step 0b: the invite could not be read ─────────────────────────────────
  if (step === 'unavailable') {
    return (
      <InviteShell captionKey="auth.invite.step1Caption" centered>
        <h2 className="mb-3 text-[22px] font-semibold leading-tight text-ink">
          {t('auth.invite.unavailableTitle')}
        </h2>
        <p className="mb-8 text-sm text-ink-muted">{loadError ?? t('auth.errors.generic')}</p>
        <Button variant="primary" fullWidth className="!h-12" onClick={load}>
          {t('common.retry')}
        </Button>
        <Link
          to="/login"
          className="mt-4 inline-block text-meta text-ink-muted hover:text-ink"
        >
          {t('auth.invite.goToSignIn')}
        </Link>
      </InviteShell>
    )
  }

  // ── Step 3: success ───────────────────────────────────────────────────────
  if (step === 'success') {
    const firstName = invite?.employeeName.split(' ')[0] ?? ''
    const nextSteps = [
      { title: t('auth.invite.next1Title'), detail: t('auth.invite.next1Detail') },
      { title: t('auth.invite.next2Title'), detail: t('auth.invite.next2Detail') },
      { title: t('auth.invite.next3Title'), detail: t('auth.invite.next3Detail') },
    ]
    return (
      <InviteShell captionKey="auth.invite.step3Caption" centered>
        <div className="flex flex-col items-center">
          <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-success-tint ring-8 ring-success/5">
            <CheckIcon className="h-8 w-8 text-success" />
          </div>
          <h2 className="mb-2 text-[22px] font-semibold leading-tight text-ink">
            {firstName
              ? t('auth.invite.successTitle', { name: firstName })
              : t('auth.invite.successTitleNoName')}
          </h2>
          <p className="mb-10 text-sm text-ink-muted">{t('auth.invite.successBody')}</p>

          <ol className="mb-10 flex w-full flex-col gap-6 text-left">
            {nextSteps.map((s, i) => (
              <li key={s.title} className="flex gap-4">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line text-chip font-bold text-ink">
                  {i + 1}
                </span>
                <span>
                  <span className="block text-sm font-semibold text-ink">{s.title}</span>
                  <span className="block text-chip text-ink-muted">{s.detail}</span>
                </span>
              </li>
            ))}
          </ol>

          {/* Full page load, not a client navigation: the employeeId custom
              claim was just issued and AuthProvider resolves the employee from
              it at session start. */}
          <Button
            variant="primary"
            fullWidth
            className="!h-12"
            onClick={() => window.location.assign('/')}
          >
            {t('auth.invite.goToDashboard')}
          </Button>
          <button
            type="button"
            onClick={() => window.location.assign('/schedule')}
            className="mt-4 text-meta font-medium text-primary hover:underline"
          >
            {t('auth.invite.setAvailabilityFirst')}
          </button>
        </div>
      </InviteShell>
    )
  }

  // ── Step 1: the invitation ────────────────────────────────────────────────
  if (step === 'invitation') {
    const roleLabel = invite?.roleName
      ? invite.skillLevel != null
        ? `${invite.roleName} · L${invite.skillLevel}`
        : invite.roleName
      : null

    return (
      <InviteShell captionKey="auth.invite.step1Caption" centered>
        <div className="flex flex-col items-center">
          <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-success-tint">
            <MailIcon className="h-6 w-6 text-success" />
          </div>
          <h2 className="mb-3 text-[22px] font-semibold leading-tight text-ink">
            {t('auth.invite.title')}
          </h2>
          <p className="mb-8 text-sm text-ink-muted">
            {invite?.invitedByName
              ? t('auth.invite.body', { name: invite.invitedByName })
              : t('auth.invite.bodyNoInviter')}
          </p>

          <dl className="mb-8 w-full overflow-hidden rounded-control border border-line text-left">
            <div className="flex items-center justify-between border-b border-line p-4">
              <dt className="text-meta text-ink-muted">{t('auth.invite.name')}</dt>
              <dd className="text-sm font-medium text-ink">{invite?.employeeName}</dd>
            </div>
            {roleLabel ? (
              <div className="flex items-center justify-between border-b border-line p-4">
                <dt className="text-meta text-ink-muted">{t('auth.invite.role')}</dt>
                <dd>
                  <Pill
                    tone="pending"
                    className="!rounded !px-2 !py-0.5 !text-micro !font-bold uppercase tracking-wider"
                  >
                    {roleLabel}
                  </Pill>
                </dd>
              </div>
            ) : null}
            <div className="flex items-center justify-between p-4">
              <dt className="text-meta text-ink-muted">{t('auth.email')}</dt>
              <dd className="truncate pl-3 text-sm font-medium text-ink">{invite?.email}</dd>
            </div>
          </dl>

          <Button
            variant="primary"
            fullWidth
            className="!h-12"
            onClick={() => setStep('method')}
          >
            {t('auth.invite.accept')}
          </Button>
          <Link
            to="/login"
            className="mb-8 mt-4 text-meta text-ink-muted transition-colors hover:text-ink"
          >
            {t('auth.invite.notMe')}
          </Link>

          {invite?.expiresAt ? (
            <p className="text-chip text-ink-muted">
              {t('auth.invite.expiresIn', { count: daysUntil(invite.expiresAt) })}
            </p>
          ) : null}
        </div>
      </InviteShell>
    )
  }

  // ── Step 2: choose a sign-in method ───────────────────────────────────────
  const mismatch = confirmTouched && confirm.length > 0 && password !== confirm
  const busy = pending !== null

  return (
    <InviteShell captionKey="auth.invite.step2Caption">
      <div className="mb-6">
        <h2 className="text-[22px] font-semibold leading-tight text-ink">
          {t('auth.invite.methodTitle')}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">{t('auth.invite.methodBody')}</p>
      </div>

      {error ? (
        <div className="mb-6">
          <AuthNotice tone="error">{error}</AuthNotice>
        </div>
      ) : null}

      <div className="mb-6">
        <GoogleButton
          onClick={() => accept('google')}
          pending={pending === 'google'}
          disabled={busy}
        />
      </div>

      <div className="mb-6">
        <OrDivider />
      </div>

      <form onSubmit={onCreateAccount} noValidate className="flex flex-col gap-5">
        <AuthField
          label={t('auth.email')}
          type="email"
          value={invite?.email ?? ''}
          readOnly
          hint={t('auth.invite.emailLocked')}
          trailing={
            <LockIcon className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          }
          onChange={() => undefined}
        />

        <PasswordField
          label={t('auth.invite.createPassword')}
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <PasswordField
          label={t('auth.invite.confirmPassword')}
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onBlur={() => setConfirmTouched(true)}
          error={mismatch ? t('auth.errors.passwordsDoNotMatch') : null}
        />

        <PasswordStrength password={password} />

        <Button
          type="submit"
          variant="primary"
          fullWidth
          disabled={busy}
          className="!mt-2 !h-12"
          icon={pending === 'password' ? <Spinner /> : undefined}
        >
          {pending === 'password' ? t('auth.invite.creating') : t('auth.invite.createAccount')}
        </Button>

        <PhoneMethod enabled={phoneOtpEnabled} mode="link" />
      </form>
    </InviteShell>
  )
}

/** Whole days between now and an ISO timestamp, floored at 0. */
function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms)) return 0
  return Math.max(0, Math.ceil(ms / 86_400_000))
}

export default InviteAcceptPage
