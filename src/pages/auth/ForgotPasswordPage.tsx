import { useCallback, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui'
import { sendPasswordReset } from '@/lib/auth/authActions'
import { toAuthError } from '@/lib/auth/authErrors'
import {
  ArrowLeftIcon,
  AuthField,
  AuthNotice,
  BrandLockup,
  CheckIcon,
  LanguageToggle,
  LegalLinks,
  Spinner,
} from '@/pages/auth/LoginPage'

/**
 * Password reset request.
 *
 * Not in `.superdesign/export/` — the login mockups link to it but no frame
 * was drawn. It therefore borrows the login screen's left panel wholesale:
 * same app-frame background, same brand lockup, same card treatment (bare on
 * mobile, bordered at `md+`), same footer.
 *
 * The confirmation deliberately does not say whether the address exists. The
 * login screen already refuses to distinguish "no such user" from "wrong
 * password" (see authErrors), and a reset form that leaked the difference
 * would undo that.
 */
export function ForgotPasswordPage() {
  const { t } = useTranslation()

  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (pending) return
      setPending(true)
      setError(null)
      void (async () => {
        try {
          await sendPasswordReset(email)
          setSent(true)
        } catch (err) {
          const info = toAuthError(err)
          // `user-not-found` maps to the vague credentials message; showing it
          // here would still confirm the address is unknown. Only genuine
          // failures (network, rate limit, malformed address) surface.
          if (info.code === 'auth/user-not-found') setSent(true)
          else setError(t(info.messageKey))
        } finally {
          setPending(false)
        }
      })()
    },
    [email, pending, t],
  )

  return (
    <div className="flex min-h-screen w-full flex-col bg-page px-6 pb-2 pt-safe md:items-center md:justify-center md:bg-app md:px-16 md:py-12">
      <div className="mb-10 mt-12 md:mb-8 md:mt-0 md:w-full md:max-w-[400px]">
        <BrandLockup />
      </div>

      <div className="flex flex-1 items-start justify-center md:flex-none md:items-center">
        <div className="w-full md:max-w-[400px] md:rounded-card-lg md:border md:border-line md:bg-page md:p-8">
          {sent ? (
            <div className="flex flex-col items-center text-center">
              <div className="mb-6 flex h-12 w-12 items-center justify-center rounded-full bg-success-tint">
                <CheckIcon className="h-6 w-6 text-success" />
              </div>
              <h1 className="mb-2 text-title font-semibold text-ink">
                {t('auth.reset.sentTitle')}
              </h1>
              <p className="mb-8 text-sm leading-relaxed text-ink-muted">
                {t('auth.reset.sentBody', { email: email.trim() })}
              </p>
              <Button
                variant="secondary"
                fullWidth
                className="!h-14 !rounded-card !text-[15px] md:!h-12 md:!rounded-control"
                onClick={() => {
                  setSent(false)
                  setError(null)
                }}
              >
                {t('auth.reset.tryAnotherEmail')}
              </Button>
            </div>
          ) : (
            <>
              <div className="text-center md:text-left">
                <h1 className="text-title font-semibold text-ink md:mb-1">
                  {t('auth.reset.title')}
                </h1>
                <p className="mx-auto mt-2 max-w-[280px] text-sm leading-relaxed text-ink-muted md:mx-0 md:mb-8 md:mt-0 md:max-w-none">
                  {t('auth.reset.body')}
                </p>
              </div>

              <form onSubmit={onSubmit} noValidate className="mt-8 space-y-4 md:mt-0">
                {error ? <AuthNotice tone="error">{error}</AuthNotice> : null}

                <AuthField
                  label={t('auth.email')}
                  type="email"
                  name="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />

                <Button
                  type="submit"
                  variant="primary"
                  fullWidth
                  disabled={pending || email.trim().length === 0}
                  className="!h-14 !rounded-card !text-[15px] md:!h-12 md:!rounded-control"
                  icon={pending ? <Spinner /> : undefined}
                >
                  {pending ? t('auth.reset.sending') : t('auth.reset.submit')}
                </Button>
              </form>
            </>
          )}

          <div className="mt-8 flex justify-center border-t border-line pt-6">
            <Link
              to="/login"
              className="inline-flex items-center gap-2 text-meta font-medium text-primary hover:underline"
            >
              <ArrowLeftIcon className="h-4 w-4" />
              {t('auth.reset.backToSignIn')}
            </Link>
          </div>
        </div>
      </div>

      <div className="mt-auto flex flex-col items-center gap-6 pb-2 pt-8 md:mt-8 md:w-full md:max-w-[400px] md:flex-row md:justify-between md:gap-0 md:pt-0">
        <LanguageToggle />
        <LegalLinks />
      </div>
    </div>
  )
}

export default ForgotPasswordPage
