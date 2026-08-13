import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui'
import { useAuth } from '@/lib/auth/AuthProvider'
import {
  getPendingLinkEmail,
  isPhoneOtpEnabled,
  linkPhoneToCurrentUser,
  setRememberMe,
  signInWithEmail,
  signInWithGoogle,
  signInWithPhoneCode,
  startPhoneVerification,
} from '@/lib/auth/authActions'
import { toAuthError } from '@/lib/auth/authErrors'
import { SUPPORTED_LANGUAGES, setLanguage, type Language } from '@/i18n'

/**
 * Sign-in screen — `.superdesign/export/01-login-desktop-en.html` at `md+`,
 * `01-login-mobile-en.html` below it. One component, responsive: the desktop
 * two-panel layout collapses to the single mobile column, the sign-in card
 * loses its border and padding, and the marketing panel is dropped.
 *
 * NOTE ON FILE LAYOUT: the brand lockup, language toggle, field primitives and
 * icon set below are exported because the invite and forgot-password screens
 * need exactly the same ones, and the brief fixed the set of files this change
 * may add. If a shared `pages/auth/authUi.tsx` is preferred, everything under
 * "Shared auth UI" lifts out unchanged.
 */

// ═══ Icons ═══════════════════════════════════════════════════════════════════
// Inline SVG only — no icon library (CLAUDE.md). Lucide outlines at 1.5px to
// match the mockups, inheriting `currentColor`.

function Stroke({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/**
 * Google's "G". The four colours are Google brand assets, not design tokens —
 * the mark is only legal to use in its official colours, so this is the one
 * place in the app that carries literal hex. Everything else uses tokens.
 */
export function GoogleIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" focusable="false">
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24s.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  )
}

export function ChefHatIcon({ className }: { className?: string }) {
  return (
    <Stroke className={className}>
      <path d="M6 13.87A4 4 0 0 1 7.41 6a5.11 5.11 0 0 1 1.05-1.54 5 5 0 0 1 7.08 0A5.11 5.11 0 0 1 16.59 6 4 4 0 0 1 18 13.87V21H6z" />
      <path d="M6 17h12" />
    </Stroke>
  )
}

export function EyeIcon({ className }: { className?: string }) {
  return (
    <Stroke className={className}>
      <path d="M2 12s3.64-7 10-7 10 7 10 7-3.64 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </Stroke>
  )
}

export function EyeOffIcon({ className }: { className?: string }) {
  return (
    <Stroke className={className}>
      <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.36 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M6.61 6.61A18.15 18.15 0 0 0 2 12s3.64 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="m2 2 20 20" />
    </Stroke>
  )
}

export function PhoneIcon({ className }: { className?: string }) {
  return (
    <Stroke className={className}>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </Stroke>
  )
}

export function MailIcon({ className }: { className?: string }) {
  return (
    <Stroke className={className}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m2 7 10 6 10-6" />
    </Stroke>
  )
}

export function LockIcon({ className }: { className?: string }) {
  return (
    <Stroke className={className}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Stroke>
  )
}

export function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="m5 13 4 4L19 7" />
    </svg>
  )
}

export function AlertIcon({ className }: { className?: string }) {
  return (
    <Stroke className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5" />
      <path d="M12 16h.01" />
    </Stroke>
  )
}

export function ArrowLeftIcon({ className }: { className?: string }) {
  return (
    <Stroke className={className}>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </Stroke>
  )
}

/** Inline pending indicator — every action shows one, never a silent wait. */
export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`animate-spin ${className}`} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" fill="none" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

// ═══ Shared auth UI ══════════════════════════════════════════════════════════

/**
 * Brand lockup. The mockups draw two marks: a 44px rounded square with an "R"
 * on desktop, a 56px rounded square with a chef hat on mobile. Both are kept.
 * Brand red is a logo colour only — never a button (design-system.md).
 */
export function BrandLockup({
  align = 'responsive',
  size = 'lg',
}: {
  /** `responsive` = centred on mobile, left-aligned at `md+`, as the two mockups draw it. */
  align?: 'start' | 'center' | 'responsive'
  size?: 'sm' | 'lg'
}) {
  const { t } = useTranslation()
  const alignment =
    align === 'center'
      ? 'items-center text-center'
      : align === 'start'
        ? 'items-start'
        : 'items-center text-center md:items-start md:text-left'
  return (
    <div className={`flex flex-col ${alignment}`}>
      <div
        className={
          size === 'lg'
            ? 'mb-3 flex h-14 w-14 items-center justify-center rounded-card bg-brand md:h-11 md:w-11 md:rounded-control'
            : 'mb-2 flex h-9 w-9 items-center justify-center rounded-control bg-brand'
        }
      >
        <ChefHatIcon className="h-7 w-7 text-white md:hidden" />
        <span
          className={`hidden font-bold text-white md:block ${size === 'lg' ? 'text-title' : 'text-section'}`}
        >
          R
        </span>
      </div>
      <h1
        className={`font-semibold leading-tight text-ink ${size === 'lg' ? 'text-[22px]' : 'text-section'}`}
      >
        {t('app.name')}
      </h1>
      <p className={`text-ink-muted ${size === 'lg' ? 'text-[15px]' : 'text-meta'}`}>
        {t('app.productName')}
      </p>
    </div>
  )
}

const LANGUAGE_LABELS: Record<Language, string> = { en: 'EN', es: 'ES' }

/** EN/ES segmented control, present on every unauthenticated screen. */
export function LanguageToggle({ className = '' }: { className?: string }) {
  const { t, i18n } = useTranslation()
  const current = i18n.language.startsWith('es') ? 'es' : 'en'

  return (
    <div
      role="group"
      aria-label={t('common.language')}
      className={`inline-flex rounded-control border border-line bg-app p-1 ${className}`}
    >
      {SUPPORTED_LANGUAGES.map((lang) => {
        const active = current === lang
        return (
          <button
            key={lang}
            type="button"
            aria-pressed={active}
            onClick={() => setLanguage(lang)}
            className={
              'rounded-md px-4 py-1.5 text-chip font-semibold transition-colors duration-hover ' +
              (active
                ? 'border border-line bg-page text-ink shadow-sm'
                : 'text-ink-muted hover:text-ink')
            }
          >
            <span aria-hidden="true">{LANGUAGE_LABELS[lang]}</span>
            <span className="sr-only">
              {lang === 'en' ? t('common.english') : t('common.spanish')}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Privacy / Terms line. Short labels on mobile, full labels on desktop. */
export function LegalLinks({ className = '' }: { className?: string }) {
  const { t } = useTranslation()
  const cls = 'text-chip text-ink-muted underline underline-offset-2 hover:text-ink'
  return (
    <div className={`flex items-center gap-4 ${className}`}>
      <a href="#privacy" className={cls}>
        <span className="md:hidden">{t('auth.privacyShort')}</span>
        <span className="hidden md:inline">{t('auth.privacy')}</span>
      </a>
      <a href="#terms" className={cls}>
        <span className="md:hidden">{t('auth.termsShort')}</span>
        <span className="hidden md:inline">{t('auth.terms')}</span>
      </a>
    </div>
  )
}

const FIELD_BASE =
  'w-full rounded-card border border-line bg-page px-4 text-[15px] text-ink outline-none ' +
  'transition-colors placeholder:text-ink-muted ' +
  'focus:border-primary focus:ring-2 focus:ring-primary/10 ' +
  'read-only:bg-app read-only:text-ink-muted ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/10 ' +
  'h-[52px] md:h-11 md:rounded-control'

export interface AuthFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id'> {
  label: string
  /** Message shown under the field and wired through aria-describedby. */
  error?: string | null
  hint?: string
  /** Rendered inside the input's right edge (eye toggle, lock glyph). */
  trailing?: ReactNode
  inputRef?: Ref<HTMLInputElement>
}

/**
 * Labelled input. Errors are wired with `aria-invalid` + `aria-describedby`
 * so a screen reader reaches the message from the field itself, in addition
 * to the form-level live region.
 */
export function AuthField({
  label,
  error,
  hint,
  trailing,
  inputRef,
  ...input
}: AuthFieldProps) {
  const id = useId()
  const errorId = `${id}-error`
  const hintId = `${id}-hint`
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ')

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-meta font-medium text-ink-muted">
        {label}
      </label>
      <div className="relative">
        <input
          {...input}
          id={id}
          ref={inputRef}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={`${FIELD_BASE}${trailing ? ' pr-12' : ''}`}
        />
        {trailing}
      </div>
      {hint ? (
        <p id={hintId} className="text-chip text-ink-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-chip font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Password field with the mockup's show/hide eye toggle. */
export function PasswordField(props: Omit<AuthFieldProps, 'type' | 'trailing'>) {
  const { t } = useTranslation()
  const [visible, setVisible] = useState(false)

  return (
    <AuthField
      {...props}
      type={visible ? 'text' : 'password'}
      trailing={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? t('auth.hidePassword') : t('auth.showPassword')}
          className="absolute right-4 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink"
        >
          {visible ? <EyeOffIcon className="h-5 w-5" /> : <EyeIcon className="h-5 w-5" />}
        </button>
      }
    />
  )
}

export type NoticeTone = 'error' | 'info'

/**
 * Form-level message. `role="alert"` on the error tone so the failure is
 * announced the moment it lands — no silent red text.
 */
export function AuthNotice({
  tone,
  title,
  children,
}: {
  tone: NoticeTone
  title?: string
  children: ReactNode
}) {
  const isError = tone === 'error'
  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      className={
        'flex gap-3 rounded-control border p-3 text-meta ' +
        (isError
          ? 'border-danger/30 bg-danger-tint text-ink'
          : 'border-primary/30 bg-primary-tint text-ink')
      }
    >
      <AlertIcon className={`mt-0.5 h-4 w-4 shrink-0 ${isError ? 'text-danger' : 'text-primary'}`} />
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className={title ? 'mt-0.5' : undefined}>{children}</div>
      </div>
    </div>
  )
}

/** The "or" rule between the Google button and the email form. */
export function OrDivider() {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3">
      <div className="h-px flex-1 bg-line" />
      <span className="text-chip font-medium uppercase tracking-wider text-ink-muted">
        {t('auth.or')}
      </span>
      <div className="h-px flex-1 bg-line" />
    </div>
  )
}

/** Google button, identical on the login and invite screens. */
export function GoogleButton({
  onClick,
  pending,
  disabled,
}: {
  onClick: () => void
  pending: boolean
  disabled?: boolean
}) {
  const { t } = useTranslation()
  return (
    <Button
      variant="secondary"
      fullWidth
      onClick={onClick}
      disabled={disabled || pending}
      className="!h-[52px] !rounded-card !text-[15px] !font-medium md:!h-12 md:!rounded-control"
      icon={pending ? <Spinner className="h-5 w-5" /> : <GoogleIcon />}
    >
      {pending ? t('auth.signingIn') : t('auth.continueWithGoogle')}
    </Button>
  )
}

/**
 * Phone OTP method (spec §2). Shipped disabled behind
 * `settings/app.featureFlags.phoneOtp` — the flag is read from Firestore, not
 * hardcoded, and the SMS + linking calls in `authActions` already exist, so
 * flipping the flag activates the method without a code change.
 *
 * `settings/app` is readable by signed-in users only, so on the signed-out
 * login screen the read is denied and resolves to `false` — the shipped state.
 */
export function usePhoneOtpEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)
  useEffect(() => {
    let cancelled = false
    void isPhoneOtpEnabled().then((on) => {
      if (!cancelled) setEnabled(on)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return enabled
}

export function PhoneMethod({
  enabled,
  mode,
}: {
  enabled: boolean
  /** `signIn` starts a session; `link` attaches the number to the current one. */
  mode: 'signIn' | 'link'
}) {
  const { t } = useTranslation()
  const [step, setStep] = useState<'closed' | 'number' | 'code'>('closed')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [verificationId, setVerificationId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      const info = toAuthError(err)
      if (!info.cancelled) setError(t(info.messageKey))
    } finally {
      setBusy(false)
    }
  }

  if (!enabled) {
    return (
      <Button
        variant="secondary"
        fullWidth
        disabled
        aria-describedby="phone-coming-soon"
        className="!h-[52px] !justify-between !rounded-card px-4 !font-medium md:!h-12 md:!rounded-control"
      >
        <span className="flex items-center gap-3">
          <PhoneIcon className="h-5 w-5 text-ink-muted" />
          <span className="text-[15px] text-ink">{t('auth.continueWithPhone')}</span>
        </span>
        <span
          id="phone-coming-soon"
          className="rounded bg-gray-100 px-1.5 py-0.5 text-micro font-bold uppercase tracking-wide text-ink-muted"
        >
          {t('common.comingSoon')}
        </span>
      </Button>
    )
  }

  if (step === 'closed') {
    return (
      <Button
        variant="secondary"
        fullWidth
        onClick={() => setStep('number')}
        className="!h-[52px] !rounded-card !text-[15px] !font-medium md:!h-12 md:!rounded-control"
        icon={<PhoneIcon className="h-5 w-5" />}
      >
        {t('auth.continueWithPhone')}
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-control border border-line p-4">
      {/* reCAPTCHA mounts here; invisible until Firebase decides otherwise. */}
      <div id="phone-recaptcha" />
      {error ? <AuthNotice tone="error">{error}</AuthNotice> : null}

      {step === 'number' ? (
        <>
          <AuthField
            label={t('auth.phoneNumber')}
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            hint={t('auth.phoneNumberHint')}
          />
          <Button
            variant="primary"
            fullWidth
            disabled={busy || phone.trim().length < 7}
            onClick={() =>
              void run(async () => {
                setVerificationId(await startPhoneVerification(phone.trim(), 'phone-recaptcha'))
                setStep('code')
              })
            }
            icon={busy ? <Spinner /> : undefined}
          >
            {t('auth.sendCode')}
          </Button>
        </>
      ) : (
        <>
          <AuthField
            label={t('auth.verificationCode')}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <Button
            variant="primary"
            fullWidth
            disabled={busy || code.trim().length < 6}
            onClick={() =>
              void run(async () => {
                if (mode === 'link') await linkPhoneToCurrentUser(verificationId, code.trim())
                else await signInWithPhoneCode(verificationId, code.trim())
              })
            }
            icon={busy ? <Spinner /> : undefined}
          >
            {t('auth.verifyCode')}
          </Button>
        </>
      )}
      <Button variant="ghost" fullWidth onClick={() => setStep('closed')} disabled={busy}>
        {t('common.cancel')}
      </Button>
    </div>
  )
}

// ═══ Login page ══════════════════════════════════════════════════════════════

type PendingAction = 'google' | 'password' | null

export function LoginPage() {
  const { t } = useTranslation()
  const location = useLocation()
  const { status } = useAuth()
  const phoneOtpEnabled = usePhoneOtpEnabled()
  const passwordRef = useRef<HTMLInputElement>(null)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [pending, setPending] = useState<PendingAction>(null)
  const [error, setError] = useState<string | null>(null)
  /** Set when Google collided with an existing password account (spec §2). */
  const [linkEmail, setLinkEmail] = useState<string | null>(null)

  const from = (location.state as { from?: string } | null)?.from

  const handleFailure = useCallback(
    (err: unknown) => {
      const info = toAuthError(err)

      // The user closed the Google popup. Not a failure — say nothing.
      if (info.cancelled) return

      // THE LINKING COLLISION. This address already has a password account, so
      // Firebase refused the Google credential. The credential is held in
      // authActions; signing in with the password below links it automatically.
      if (info.accountExists) {
        const stashed = getPendingLinkEmail() ?? info.email
        if (stashed) {
          setLinkEmail(stashed)
          setEmail(stashed)
          setError(null)
          window.setTimeout(() => passwordRef.current?.focus(), 0)
          return
        }
      }

      setError(t(info.messageKey))
    },
    [t],
  )

  const onGoogle = useCallback(() => {
    setPending('google')
    setError(null)
    void (async () => {
      try {
        await setRememberMe(remember)
        await signInWithGoogle()
      } catch (err) {
        handleFailure(err)
      } finally {
        setPending(null)
      }
    })()
  }, [handleFailure, remember])

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (pending) return
      setPending('password')
      setError(null)
      void (async () => {
        try {
          await setRememberMe(remember)
          await signInWithEmail(email, password)
        } catch (err) {
          handleFailure(err)
        } finally {
          setPending(null)
        }
      })()
    },
    [email, handleFailure, password, pending, remember],
  )

  // Already authenticated — bounce to wherever they were headed.
  if (status === 'ready') return <Navigate to={from ?? '/'} replace />

  const busy = pending !== null

  const form = (
    <div className="w-full md:max-w-[400px] md:rounded-card-lg md:border md:border-line md:bg-page md:p-8">
      <div className="text-center md:text-left">
        <h2 className="text-title font-semibold text-ink md:mb-1">{t('auth.signIn')}</h2>
        <p className="mx-auto mt-2 max-w-[280px] text-sm leading-relaxed text-ink-muted md:mx-0 md:mb-8 md:mt-0 md:max-w-none">
          {t('auth.signInWelcome')}
        </p>
      </div>

      <div className="mt-8 space-y-4 md:mt-0">
        {/* Signed in with Firebase but never bound to an employee record. */}
        {status === 'no-employee' ? (
          <AuthNotice tone="info" title={t('auth.notLinkedTitle')}>
            {t('auth.notLinkedBody')}
          </AuthNotice>
        ) : null}

        {linkEmail ? (
          <AuthNotice tone="info" title={t('auth.linkAccountTitle')}>
            {t('auth.linkAccountBody', { email: linkEmail })}
          </AuthNotice>
        ) : null}

        {error ? <AuthNotice tone="error">{error}</AuthNotice> : null}

        <GoogleButton onClick={onGoogle} pending={pending === 'google'} disabled={busy} />

        <OrDivider />

        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <AuthField
            label={t('auth.email')}
            type="email"
            name="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            readOnly={linkEmail !== null}
          />

          <div>
            <PasswordField
              label={t('auth.password')}
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              inputRef={passwordRef}
            />
            <div className="mt-1.5 flex justify-end">
              <Link
                to="/forgot-password"
                className="text-meta font-medium text-primary hover:underline"
              >
                {t('auth.forgotPassword')}
              </Link>
            </div>
          </div>

          {/* Mockup places "remember me" on desktop only. */}
          <label className="hidden cursor-pointer items-center gap-3 md:flex">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="h-4 w-4 rounded border-line text-primary focus:ring-primary"
            />
            <span className="text-sm text-ink">{t('auth.rememberMe')}</span>
          </label>

          <Button
            type="submit"
            variant="primary"
            fullWidth
            disabled={busy}
            className="!h-14 !rounded-card !text-[15px] md:!h-12 md:!rounded-control"
            icon={pending === 'password' ? <Spinner /> : undefined}
          >
            {pending === 'password'
              ? t('auth.signingIn')
              : linkEmail
                ? t('auth.signInAndLink')
                : t('auth.signIn')}
          </Button>
        </form>

        <div className="pt-2">
          <PhoneMethod enabled={phoneOtpEnabled} mode="signIn" />
        </div>
      </div>

      <p className="pt-2 text-center text-meta text-ink-muted md:mt-8 md:border-t md:border-line md:pt-6">
        {t('auth.noAccountLead')}{' '}
        <span className="font-medium text-ink">{t('auth.noAccountAction')}</span>
      </p>
    </div>
  )

  return (
    <div className="flex min-h-screen w-full bg-page">
      <main className="flex min-h-screen w-full">
        {/* LEFT / ONLY PANEL — sign-in */}
        <div className="flex w-full flex-col px-6 pb-2 pt-safe md:w-[45%] md:border-r md:border-line md:bg-app md:px-16 md:py-12">
          <div className="mb-10 mt-12 md:mb-auto md:mt-0">
            <BrandLockup />
          </div>

          <div className="flex flex-1 items-start justify-center md:items-center md:py-12">
            {form}
          </div>

          <div className="mt-auto flex flex-col items-center gap-6 pb-2 pt-8 md:flex-row md:items-center md:justify-between md:gap-0 md:pt-0">
            <LanguageToggle />
            <LegalLinks />
          </div>
        </div>

        {/* RIGHT PANEL — quiet, typographic brand surface. Desktop only. */}
        <div className="relative hidden w-[55%] items-center justify-center bg-page md:flex">
          <div className="absolute inset-y-0 left-0 w-px bg-brand/20" />
          <div className="absolute inset-0 bg-[radial-gradient(theme(colors.brand)_0.5px,transparent_0.5px)] opacity-[0.03] [background-size:24px_24px]" />

          <div className="relative z-10 max-w-lg px-8 text-center">
            <h2 className="mb-2 text-title-lg font-semibold tracking-tight text-ink">
              {t('auth.marketingHeadline')}
            </h2>
            <p className="mb-12 text-lg text-ink-muted">{t('auth.marketingSubhead')}</p>

            {/* Flat line-art suggestion of a schedule grid and a phone. */}
            <div className="flex justify-center" aria-hidden="true">
              <div className="relative h-56 w-80 overflow-hidden rounded-card-lg border-2 border-line bg-page">
                <div className="absolute left-4 right-4 top-4 flex h-6 gap-2">
                  <div className="h-full w-1/4 rounded-md border border-line bg-app" />
                  <div className="h-full w-1/4 rounded-md border border-line bg-app" />
                  <div className="h-full w-1/4 rounded-md border border-primary/20 bg-primary/5" />
                  <div className="h-full w-1/4 rounded-md border border-line bg-app" />
                </div>
                <div className="mt-14 space-y-3 px-4">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-gray-100" />
                    <div className="h-2 flex-1 rounded-full bg-gray-100" />
                    <div className="h-2 w-12 rounded-full bg-gray-100" />
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-gray-100" />
                    <div className="h-2 flex-1 rounded-full bg-brand/5" />
                    <div className="h-2 w-16 rounded-full bg-brand/10" />
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-gray-100" />
                    <div className="h-2 flex-1 rounded-full bg-gray-100" />
                    <div className="h-2 w-10 rounded-full bg-gray-100" />
                  </div>
                </div>
                <div className="absolute -bottom-8 -right-8 flex h-44 w-32 rotate-12 flex-col rounded-sheet border-2 border-line bg-page p-3 shadow-elevated">
                  <div className="mb-4 h-1 w-8 self-center rounded-full bg-gray-100" />
                  <div className="flex-1 rounded-control border border-gray-100" />
                </div>
              </div>
            </div>
          </div>

          <ChefHatIcon className="absolute bottom-12 right-12 h-9 w-9 text-brand/10" />
        </div>
      </main>
    </div>
  )
}

export default LoginPage
