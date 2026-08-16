import type { ReactNode } from 'react'

/**
 * Payroll Workshop icon set — inline SVG, no icon library (CLAUDE.md "no
 * component libraries"), same convention as `pages/tasks/icons.tsx`. Paths
 * are the matching Lucide outlines mockup 26 draws (chevron-left/right for
 * the period stepper, chevron-down for the export split-button, lock for
 * the lock action).
 */

interface IconProps {
  className?: string
}

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

export function ChevronLeftIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="m15 18-6-6 6-6" />
    </Svg>
  )
}

export function ChevronRightIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="m9 18 6-6-6-6" />
    </Svg>
  )
}

export function ChevronDownIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  )
}

export function LockIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Svg>
  )
}
