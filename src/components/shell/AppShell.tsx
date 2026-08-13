import { Outlet } from 'react-router-dom'

import { useIsDesktop } from '@/hooks/useMediaQuery'

import { DesktopShell } from './DesktopShell'
import { MobileShell } from './MobileShell'

/**
 * Layout route for the whole app: `<Route element={<AppShell />}>`.
 *
 * Picks the shell at the `md` breakpoint (768px). `useIsDesktop` reads
 * matchMedia synchronously on the first render, so the wrong shell never
 * paints first.
 */
export function AppShell(): JSX.Element {
  const isDesktop = useIsDesktop()

  if (isDesktop) {
    return (
      <DesktopShell>
        <Outlet />
      </DesktopShell>
    )
  }

  return (
    <MobileShell>
      <Outlet />
    </MobileShell>
  )
}

export default AppShell
