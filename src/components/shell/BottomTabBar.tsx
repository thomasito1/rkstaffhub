import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'

import { TAB_ITEMS, type NavBadge, type NavBadges, type NavItem } from './navItems'

interface TabItemProps {
  item: NavItem
  badge: NavBadge | undefined
}

function TabItem({ item, badge }: TabItemProps): JSX.Element {
  const { t } = useTranslation()
  const Icon = item.tabIcon ?? item.icon
  const label = t(item.labelKey)
  const count = badge?.count ?? 0
  const showBadge = badge?.dot === true || count > 0

  return (
    <NavLink
      to={item.to}
      end={item.end}
      // NavLink sets aria-current="page" on the active link for us.
      className={({ isActive }) =>
        [
          'relative flex flex-1 flex-col items-center justify-center gap-0.5',
          isActive ? 'text-primary' : 'text-ink-muted',
        ].join(' ')
      }
    >
      <Icon className="h-[22px] w-[22px]" />
      <span className="text-micro font-medium tracking-normal">{label}</span>
      {showBadge ? (
        <>
          <span
            aria-hidden="true"
            className="absolute right-6 top-1.5 h-1.5 w-1.5 rounded-full bg-danger"
          />
          {count > 0 ? (
            <span className="sr-only">{t('a11y.badgeCount', { count })}</span>
          ) : null}
        </>
      ) : null}
    </NavLink>
  )
}

export interface BottomTabBarProps {
  badges?: NavBadges
}

/**
 * Mobile bottom tab bar — 56px, white, 1px top border, exactly 5 tabs, sitting
 * ABOVE the home-indicator safe area (spec §15).
 * Mockup: `.superdesign/export/07-staff-home-mobile-en.html`.
 */
export function BottomTabBar({ badges }: BottomTabBarProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <nav
      aria-label={t('nav.mainNavigation')}
      className="shrink-0 border-t border-line bg-page"
    >
      <div className="flex h-tabbar items-stretch px-2">
        {TAB_ITEMS.map((item) => (
          <TabItem key={item.id} item={item} badge={badges?.[item.id]} />
        ))}
      </div>
      {/* Drawn home-indicator zone. Nothing interactive ever enters it. */}
      <div aria-hidden="true" className="h-safe-bottom w-full bg-page" />
    </nav>
  )
}
