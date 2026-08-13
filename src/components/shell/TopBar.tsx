import { useTranslation } from 'react-i18next'

import { Avatar } from '@/components/ui/Avatar'
import { setLanguage, type Language } from '@/i18n'

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
  /** Unread notification count for the bell badge. */
  unreadCount?: number
  /** Signed-in user. Wired to auth in a later phase; demo values for now. */
  userFirstName?: string
  userLastName?: string
  /** Already-translated permission level label shown under the name. */
  userRoleLabel?: string
}

/**
 * Desktop top bar — 60px, white, 1px bottom border.
 * Mockup: `.superdesign/export/05-dashboard-overview-desktop-en.html`.
 */
export function TopBar({
  unreadCount = 0,
  userFirstName = 'Rafa',
  userLastName = 'Owner',
  userRoleLabel,
}: TopBarProps): JSX.Element {
  const { t } = useTranslation()
  const roleLabel = userRoleLabel ?? t('roles.owner')

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

        {/* Profile block. Not a link yet — no profile route exists in Phase 0. */}
        <div className="flex items-center gap-3 border-l border-line pl-2">
          <div className="flex flex-col items-end">
            <span className="text-meta font-semibold text-ink">{userFirstName}</span>
            <span className="text-micro tracking-normal text-ink-muted">{roleLabel}</span>
          </div>
          <Avatar firstName={userFirstName} lastName={userLastName} size={32} />
        </div>
      </div>
    </header>
  )
}
