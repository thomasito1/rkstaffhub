import { useCallback, useSyncExternalStore } from 'react'

/**
 * SSR-safe media query hook.
 *
 * Implemented with `useSyncExternalStore` on purpose:
 *   - the first client render already reads the real `matchMedia` result, so the
 *     desktop shell never paints before being swapped for the mobile one (no
 *     first-paint flicker, no `useEffect` round trip);
 *   - `getServerSnapshot` keeps it safe if this ever renders without a `window`.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {}
      }
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onStoreChange)
      return () => mql.removeEventListener('change', onStoreChange)
    },
    [query],
  )

  const getSnapshot = useCallback((): boolean => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false
    }
    return window.matchMedia(query).matches
  }, [query])

  // Server / no-DOM: assume the mobile shell. It is the smaller, safer layout.
  const getServerSnapshot = useCallback((): boolean => false, [])

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

/** Tailwind's `md` breakpoint. The shell switches here. */
export const DESKTOP_QUERY = '(min-width: 768px)'

/** True at or above Tailwind's `md` breakpoint (768px). */
export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY)
}
