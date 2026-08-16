import type { ReactNode } from 'react'

import { IconRail } from './IconRail'
import { TopBar } from './TopBar'
import type { NavBadges } from './navItems'

export interface DesktopShellProps {
  children: ReactNode
  /**
   * Real badges, computed by `AppShell`. Shift Pool's `{ dot: true }` is a
   * known, separately-tracked gap (Phase 2 trades never replaced it with a
   * real unclaimed-shift signal) — `AppShell` still hardcodes that one
   * specific entry and passes it through unchanged alongside the real
   * `tasks` count computed there now that Phase 3 has a real data source.
   */
  badges?: NavBadges
}

/**
 * Desktop chrome: 60px left icon rail + 60px top bar, content on white with
 * 32px padding (design-system.md §5).
 */
export function DesktopShell({ children, badges }: DesktopShellProps): JSX.Element {
  return (
    <div className="flex h-[100dvh] overflow-hidden bg-page">
      <IconRail badges={badges} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-y-auto bg-page p-8">{children}</main>
      </div>
    </div>
  )
}
