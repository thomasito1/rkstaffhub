import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Avatar } from '@/components/ui'
import { useAuth } from '@/lib/auth/AuthProvider'

/**
 * Mobile "More" tab — no mockup covers this screen. Kept intentionally
 * minimal: the identity block the desktop TopBar shows in its header (mobile
 * has no header to put it in), a link to the existing profile screen (the
 * only route to it on mobile — the tab bar has no room for a 6th icon), and
 * sign-out, which previously had no reachable affordance on either shell.
 */
export function MorePage(): JSX.Element {
  const { t } = useTranslation()
  const { employee, signOut } = useAuth()

  return (
    <div className="max-w-2xl">
      <h1 className="text-title font-semibold tracking-tight text-ink">{t('nav.more')}</h1>

      <div className="mt-4 flex items-center gap-3 rounded-card border border-line bg-page p-4">
        <Avatar
          firstName={employee?.firstName ?? ''}
          lastName={employee?.lastName ?? ''}
          photoUrl={employee?.photoUrl}
          size={40}
        />
        <div className="flex flex-col">
          <span className="text-meta font-semibold text-ink">
            {employee ? `${employee.firstName} ${employee.lastName}` : ''}
          </span>
          <span className="text-chip text-ink-muted">
            {employee ? t(`roles.${employee.accessRole}`) : ''}
          </span>
        </div>
      </div>

      <div className="mt-4 divide-y divide-line overflow-hidden rounded-card border border-line bg-page">
        <Link
          to="/profile"
          className="block px-4 py-3 text-meta font-medium text-ink transition-colors duration-hover hover:bg-hover"
        >
          {t('more.myProfile')}
        </Link>
        <button
          type="button"
          onClick={() => void signOut()}
          className="block w-full px-4 py-3 text-left text-meta font-medium text-danger transition-colors duration-hover hover:bg-hover"
        >
          {t('nav.signOut')}
        </button>
      </div>
    </div>
  )
}
