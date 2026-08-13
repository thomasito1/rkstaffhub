import type { ReactNode } from 'react'

import { BottomTabBar } from './BottomTabBar'
import type { NavBadges } from './navItems'

/** Phase 0 demo badge. Mockup 07 draws a dot on the Tasks tab. */
const DEMO_BADGES: NavBadges = {
  tasks: { dot: true },
}

export interface MobileShellProps {
  children: ReactNode
}

/**
 * Mobile chrome: drawn safe areas top and bottom (spec §15), scrolling content,
 * 5-tab bottom bar that sits above the home-indicator inset.
 * `viewport-fit=cover` in index.html is what makes env(safe-area-inset-*)
 * resolve to non-zero on notched devices.
 */
export function MobileShell({ children }: MobileShellProps): JSX.Element {
  return (
    // pl-safe/pr-safe cover the landscape notch insets; px-* never goes on this
    // element so the two padding rules cannot fight.
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-page pl-safe pr-safe">
      {/* Drawn status-bar / notch zone. Content never enters it. */}
      <div aria-hidden="true" className="h-safe-top w-full shrink-0 bg-page" />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</main>
      <BottomTabBar badges={DEMO_BADGES} />
    </div>
  )
}
