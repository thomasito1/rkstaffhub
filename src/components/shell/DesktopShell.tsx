import type { ReactNode } from 'react'

import { IconRail } from './IconRail'
import { TopBar } from './TopBar'
import type { NavBadges } from './navItems'

/**
 * Phase 0 demo badges. Mockup 05 draws a dot on Shift Pool and a "3" on Tasks.
 * Real counts arrive with their features (trades Phase 2, tasks Phase 3).
 */
const DEMO_BADGES: NavBadges = {
  shiftPool: { dot: true },
  tasks: { count: 3 },
}

/** Mockup 05 draws "4" on the bell. */
const DEMO_UNREAD = 4

export interface DesktopShellProps {
  children: ReactNode
}

/**
 * Desktop chrome: 60px left icon rail + 60px top bar, content on white with
 * 32px padding (design-system.md §5).
 */
export function DesktopShell({ children }: DesktopShellProps): JSX.Element {
  return (
    <div className="flex h-[100dvh] overflow-hidden bg-page">
      <IconRail badges={DEMO_BADGES} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar unreadCount={DEMO_UNREAD} />
        <main className="min-h-0 flex-1 overflow-y-auto bg-page p-8">{children}</main>
      </div>
    </div>
  )
}
