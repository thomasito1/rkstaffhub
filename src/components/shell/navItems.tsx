import type { ReactNode } from 'react'

/**
 * Shared navigation definition for both shells, plus the inline SVG icon set.
 *
 * Icons are inline SVG (no icon library — CLAUDE.md "no component libraries").
 * The mockups draw Lucide glyphs at a 1.5px stroke; the paths below are the
 * matching Lucide outlines so the shells look identical to
 * `.superdesign/export/05-dashboard-overview-desktop-en.html` (rail) and
 * `.superdesign/export/07-staff-home-mobile-en.html` (tab bar).
 */

export interface IconProps {
  /** Size + color are driven by the caller: icons inherit `currentColor`. */
  className?: string
}

export type IconComponent = (props: IconProps) => JSX.Element

function Svg({ className, children }: IconProps & { children: ReactNode }): JSX.Element {
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

export function HomeIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M9 22V12h6v10" />
    </Svg>
  )
}

export function CalendarIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4" />
      <path d="M8 2v4" />
      <path d="M3 10h18" />
    </Svg>
  )
}

export function ClockIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Svg>
  )
}

export function UsersRoundIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M18 21a8 8 0 0 0-16 0" />
      <circle cx="10" cy="8" r="5" />
      <path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" />
    </Svg>
  )
}

export function CheckSquareIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M21 10.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      <path d="m9 11 3 3L22 4" />
    </Svg>
  )
}

export function ClipboardListIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M12 11h4" />
      <path d="M12 16h4" />
      <path d="M8 11h.01" />
      <path d="M8 16h.01" />
    </Svg>
  )
}

export function ContactIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v2" />
      <path d="M8 2v2" />
      <circle cx="12" cy="11" r="3" />
      <path d="M17.9 19a6 6 0 0 0-11.8 0" />
    </Svg>
  )
}

export function FileTextIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
      <path d="M14 2v5h5" />
      <path d="M16 13H8" />
      <path d="M16 17H8" />
      <path d="M10 9H8" />
    </Svg>
  )
}

export function BarChartIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M3 3v18h18" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </Svg>
  )
}

export function SettingsIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  )
}

export function MoreHorizontalIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </Svg>
  )
}

export function SearchIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Svg>
  )
}

export function BellIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M10.27 21a2 2 0 0 0 3.46 0" />
      <path d="M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33" />
    </Svg>
  )
}

export type NavItemId =
  | 'home'
  | 'schedule'
  | 'clock'
  | 'shiftPool'
  | 'tasks'
  | 'people'
  | 'hr'
  | 'reports'
  | 'settings'
  | 'more'

export interface NavItem {
  id: NavItemId
  /** Route path — must match a route in App.tsx. */
  to: string
  /** i18n key. Every label goes through t() (CLAUDE.md). */
  labelKey: string
  /** Rail / default icon. */
  icon: IconComponent
  /**
   * Mobile tab-bar icon when the mobile mockup draws a different glyph than the
   * desktop rail. Only Tasks needs this today.
   */
  tabIcon?: IconComponent
  /** Pass `end` to NavLink so "/" is not active on every route. */
  end?: boolean
}

/**
 * Badge affordances. Real counts arrive with their features (trades in Phase 2,
 * tasks in Phase 3); the shells render whatever they are handed.
 */
export interface NavBadge {
  /** Small red dot, top-right of the icon. */
  dot?: boolean
  /** Numeric count pill. Rendered instead of the dot when > 0. */
  count?: number
}

export type NavBadges = Partial<Record<NavItemId, NavBadge>>

const NAV_ITEMS: Record<NavItemId, NavItem> = {
  home: { id: 'home', to: '/', labelKey: 'nav.home', icon: HomeIcon, end: true },
  schedule: { id: 'schedule', to: '/schedule', labelKey: 'nav.schedule', icon: CalendarIcon },
  clock: { id: 'clock', to: '/clock', labelKey: 'nav.clock', icon: ClockIcon },
  shiftPool: {
    id: 'shiftPool',
    to: '/shift-pool',
    labelKey: 'nav.shiftPool',
    icon: UsersRoundIcon,
  },
  tasks: {
    id: 'tasks',
    to: '/tasks',
    labelKey: 'nav.tasks',
    icon: CheckSquareIcon,
    tabIcon: ClipboardListIcon,
  },
  people: { id: 'people', to: '/people', labelKey: 'nav.people', icon: ContactIcon },
  hr: { id: 'hr', to: '/hr', labelKey: 'nav.hr', icon: FileTextIcon },
  reports: { id: 'reports', to: '/reports', labelKey: 'nav.reports', icon: BarChartIcon },
  settings: { id: 'settings', to: '/settings', labelKey: 'nav.settings', icon: SettingsIcon },
  more: { id: 'more', to: '/more', labelKey: 'nav.more', icon: MoreHorizontalIcon },
}

/** Desktop rail, top group — order per mockup 05. */
export const RAIL_ITEMS: readonly NavItem[] = [
  NAV_ITEMS.home,
  NAV_ITEMS.schedule,
  NAV_ITEMS.clock,
  NAV_ITEMS.shiftPool,
  NAV_ITEMS.tasks,
  NAV_ITEMS.people,
  NAV_ITEMS.hr,
  NAV_ITEMS.reports,
]

/** Desktop rail, pinned to the bottom. */
export const RAIL_FOOTER_ITEMS: readonly NavItem[] = [NAV_ITEMS.settings]

/** Mobile bottom tab bar — exactly 5 tabs (design-system.md §5). */
export const TAB_ITEMS: readonly NavItem[] = [
  NAV_ITEMS.home,
  NAV_ITEMS.schedule,
  NAV_ITEMS.clock,
  NAV_ITEMS.tasks,
  NAV_ITEMS.more,
]
