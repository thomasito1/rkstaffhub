import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Avatar } from '@/components/ui/Avatar'
import { setLanguage, type Language } from '@/i18n'
import { useAuth } from '@/lib/auth/AuthProvider'

import { BellIcon, SearchIcon } from './navItems'

function LanguageToggle(): JSX.Element {
  const { t, i18n } = useTranslation()
  const current: Language = (i18n.resolvedLanguage ?? i18n.language).startsWith('es')
    ? 'es'
    : 'en'

  const options: ReadonlyArray<{ lang: Language; code: string; labelKey: string }> = [
    { lang: 'en', code: 'EN', labelKey: 'common.english' },
    { lang: 'es', code: 'ES', labelKey: 'common.spanish' },
  ]

  return (
    <div
      role="group"
      aria-label={t('common.language')}
      className="flex items-center rounded-control border border-line bg-app p-1"
    >
      {options.map(({ lang, code, labelKey }) => {
        const isActive = current === lang
        return (
          <button
            key={lang}
            type="button"
            aria-pressed={isActive}
            onClick={() => setLanguage(lang)}
            className={[
              'rounded px-3 py-1 text-chip font-semibold transition-colors duration-hover',
              isActive
                ? 'border border-line bg-page text-ink shadow-sm'
                : 'border border-transparent text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            {/* The visible affordance is the locale code; screen readers get the
                language name so the control is not announced as "EN". */}
            <span aria-hidden="true">{code}</span>
            <span className="sr-only">{t(labelKey)}</span>
          </button>
        )
      })}
    </div>
  )
}

export interface TopBarProps {
  /** Unread notification count for the bell badge. Real counts arrive with
   * the notifications feature; until then this stays 0 rather than a demo
   * number. */
  unreadCount?: number
}

/**
 * Profile block + sign-out menu. The trigger is the avatar/name/role block
 * from mockup 05; the menu itself has no mockup (none of the 49 screens show
 * one) — kept intentionally minimal: one item, same interaction shape as
 * `KebabMenu` (click-outside + Escape to close).
 */
function ProfileMenu({
  firstName,
  lastName,
  roleLabel,
  photoUrl,
  onSignOut,
}: {
  firstName: string
  lastName: string
  roleLabel: string
  photoUrl?: string | null
  onSignOut: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="relative border-l border-line pl-2">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-3 rounded-control p-1 transition-colors duration-hover hover:bg-app"
      >
        <div className="flex flex-col items-end">
          <span className="text-meta font-semibold text-ink">{firstName}</span>
          <span className="text-micro tracking-normal text-ink-muted">{roleLabel}</span>
        </div>
        <Avatar firstName={firstName} lastName={lastName} photoUrl={photoUrl} size={32} />
      </button>

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`${firstName} ${lastName}`}
          className="absolute right-0 z-20 mt-1 min-w-[11rem] rounded-card border border-line bg-page py-1 shadow-elevated"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onSignOut()
            }}
            className="block w-full px-3 py-2 text-left text-meta text-ink transition-colors duration-hover hover:bg-hover"
          >
            {t('nav.signOut')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Desktop top bar — 60px, white, 1px bottom border.
 * Mockup: `.superdesign/export/05-dashboard-overview-desktop-en.html`.
 */
export function TopBar({ unreadCount = 0 }: TopBarProps): JSX.Element {
  const { t } = useTranslation()
  const { employee, signOut } = useAuth()
  // RequireAuth only renders the shell once status === 'ready', which the
  // AuthProvider state machine guarantees means `employee` is set — this
  // fallback only satisfies the nullable type, it is not a reachable state.
  const firstName = employee?.firstName ?? ''
  const lastName = employee?.lastName ?? ''
  const roleLabel = employee ? t(`roles.${employee.accessRole}`) : ''

  return (
    <header className="flex h-topbar shrink-0 items-center justify-between border-b border-line bg-page px-8">
      <div className="flex items-center gap-8">
        {/* Logo mark + wordmark */}
        <div className="flex items-center gap-3">
          <div className="flex h-7 w-7 items-center justify-center rounded bg-brand">
            <span aria-hidden="true" className="text-section font-bold text-page">
              R
            </span>
          </div>
          <span className="text-body font-semibold tracking-tight text-ink">
            {t('app.name')}
          </span>
        </div>

        {/* Global search */}
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-ink-muted" />
          <input
            type="search"
            aria-label={t('common.search')}
            placeholder={t('nav.search')}
            className="h-9 w-[320px] rounded-control border border-line bg-app pl-10 pr-4 text-meta text-ink placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-primary/20"
          />
        </div>
      </div>

      <div className="flex items-center gap-6">
        <LanguageToggle />

        <button
          type="button"
          className="relative flex h-8 w-8 items-center justify-center text-ink-muted transition-colors duration-hover hover:text-ink"
        >
          <BellIcon className="h-5 w-5" />
          <span className="sr-only">{t('nav.notifications')}</span>
          {unreadCount > 0 ? (
            <>
              <span
                aria-hidden="true"
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-danger text-[10px] font-bold text-page"
              >
                {unreadCount}
              </span>
              <span className="sr-only">
                {t('a11y.notificationCount', { count: unreadCount })}
              </span>
            </>
          ) : null}
        </button>

        <ProfileMenu
          firstName={firstName}
          lastName={lastName}
          roleLabel={roleLabel}
          photoUrl={employee?.photoUrl}
          onSignOut={() => void signOut()}
        />
      </div>
    </header>
  )
}
