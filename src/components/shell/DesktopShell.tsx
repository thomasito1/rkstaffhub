import type { ReactNode } from 'react'

import { IconRail } from './IconRail'
import { TopBar } from './TopBar'
import type { NavBadges } from './navItems'

/**
 * Phase 0 demo badge. Mockup 05 also draws a "3" count on Tasks, but Tasks
 * has no real data source until Phase 3 (spec §19) — showing no badge is
 * honest; showing a fixed "3" forever is not. Shift Pool's dot stays: Phase 2
 * trades will replace it with a real unclaimed-shift signal, and a dot
 * carries no specific (and therefore no false) number.
 */
const DEMO_BADGES: NavBadges = {
  shiftPool: { dot: true },
}

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
        <TopBar />
        <main className="min-h-0 flex-1 overflow-y-auto bg-page p-8">{children}</main>
      </div>
    </div>
  )
}
