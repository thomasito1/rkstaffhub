import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'

import {
  RAIL_FOOTER_ITEMS,
  RAIL_ITEMS,
  type NavBadge,
  type NavBadges,
  type NavItem,
} from './navItems'

interface RailItemProps {
  item: NavItem
  badge: NavBadge | undefined
}

function RailItem({ item, badge }: RailItemProps): JSX.Element {
  const { t } = useTranslation()
  const Icon = item.icon
  const label = t(item.labelKey)
  const count = badge?.count ?? 0
  const showCount = count > 0
  const showDot = !showCount && badge?.dot === true

  return (
    <NavLink
      to={item.to}
      end={item.end}
      // NavLink sets aria-current="page" on the active link for us.
      title={label}
      className={({ isActive }) =>
        [
          'relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors duration-hover',
          isActive
            ? 'bg-page text-primary shadow-sm'
            : 'text-ink-muted hover:bg-page/50 hover:text-ink',
        ].join(' ')
      }
    >
      <Icon className="h-5 w-5" />
      <span className="sr-only">{label}</span>

      {showDot ? (
        <span
          aria-hidden="true"
          className="absolute right-2 top-2 h-2 w-2 rounded-full bg-danger ring-2 ring-rail"
        />
      ) : null}

      {showCount ? (
        <>
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full border border-rail bg-danger px-1 text-[10px] font-bold text-page"
          >
            {count}
          </span>
          <span className="sr-only">{t('a11y.badgeCount', { count })}</span>
        </>
      ) : null}
    </NavLink>
  )
}

export interface IconRailProps {
  badges?: NavBadges
}

/**
 * Desktop left icon rail — 60px, icons only, Settings pinned to the bottom.
 * Mockup: `.superdesign/export/05-dashboard-overview-desktop-en.html`.
 */
export function IconRail({ badges }: IconRailProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <nav
      aria-label={t('nav.mainNavigation')}
      className="flex h-full w-rail shrink-0 flex-col items-center border-r border-line bg-rail py-6"
    >
      <div className="flex w-full flex-col items-center gap-2">
        {RAIL_ITEMS.map((item) => (
          <RailItem key={item.id} item={item} badge={badges?.[item.id]} />
        ))}
      </div>

      <div className="mt-auto flex w-full flex-col items-center gap-2 pt-2">
        {RAIL_FOOTER_ITEMS.map((item) => (
          <RailItem key={item.id} item={item} badge={badges?.[item.id]} />
        ))}
      </div>
    </nav>
  )
}
