import { Outlet } from 'react-router-dom'

import { useIsDesktop } from '@/hooks/useMediaQuery'
import { useAuth } from '@/lib/auth/AuthProvider'
import { useMyOpenTaskCount } from '@/lib/tasks/useMyOpenTaskCount'

import { DesktopShell } from './DesktopShell'
import { MobileShell } from './MobileShell'
import type { NavBadges } from './navItems'

/**
 * Layout route for the whole app: `<Route element={<AppShell />}>`.
 *
 * Picks the shell at the `md` breakpoint (768px). `useIsDesktop` reads
 * matchMedia synchronously on the first render, so the wrong shell never
 * paints first.
 *
 * Badges: Tasks now has a real data source (Phase 3, spec §19) — a fixed dot
 * forever was never honest, and now it doesn't have to be. Shift Pool's
 * `{ dot: true }` is a separate, already-known gap (Phase 2 trades never
 * replaced it with a real unclaimed-shift signal) — kept exactly as-is here,
 * out of scope for this task.
 */
export function AppShell(): JSX.Element {
  const isDesktop = useIsDesktop()
  const { employee } = useAuth()
  const openTaskCount = useMyOpenTaskCount(employee)

  const badges: NavBadges = {
    shiftPool: { dot: true },
    ...(openTaskCount > 0 ? { tasks: { count: openTaskCount } } : {}),
  }

  if (isDesktop) {
    return (
      <DesktopShell badges={badges}>
        <Outlet />
      </DesktopShell>
    )
  }

  return (
    <MobileShell badges={badges}>
      <Outlet />
    </MobileShell>
  )
}

export default AppShell
