import type { ReactNode } from 'react'

/**
 * Card — design-system.md §4.
 * Flat: 1px border does the work, no shadow. Only Modal and Toast elevate.
 */
export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode
  className?: string
  padded?: boolean
}) {
  return (
    <div
      className={[
        'rounded-card border border-line bg-page',
        padded ? 'p-4' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
}
