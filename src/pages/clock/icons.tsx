import type { ReactNode } from 'react'

/**
 * Clock-screen icon set — inline SVG, no icon library (CLAUDE.md "no
 * component libraries"), same convention as `components/shell/navItems.tsx`.
 * Paths are the matching Lucide outlines the mockups draw at a 1.5px stroke.
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

export function ClockIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </Svg>
  )
}

export function MapPinIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </Svg>
  )
}

export function MapPinOffIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M12.75 7.09a3 3 0 0 1 2.16 2.16" />
      <path d="M17.07 17.07 12 22s-7-6-7-12a8 8 0 0 1 4.79-7.33" />
      <path d="M15.66 4.34A8 8 0 0 1 20 10c0 2.44-1.31 4.83-2.77 6.77" />
      <path d="m2 2 20 20" />
    </Svg>
  )
}

export function CheckCircleIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="m22 4-10 10-3-3" />
    </Svg>
  )
}

export function CheckIcon({
  className,
  strokeWidth = 1.5,
}: IconProps & { strokeWidth?: number }): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}

export function AlertCircleIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </Svg>
  )
}

export function AlertTriangleIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </Svg>
  )
}

export function ChevronLeftIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="m15 18-6-6 6-6" />
    </Svg>
  )
}

export function PencilIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </Svg>
  )
}

export function BackspaceIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M22 3H7a2 2 0 0 0-1.41.59L1 9l4.59 5.41A2 2 0 0 0 7 15h15a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Z" />
      <path d="m12 9 6 6" />
      <path d="m18 9-6 6" />
    </Svg>
  )
}

export function RefreshCwIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </Svg>
  )
}

export function UserIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <circle cx="12" cy="8" r="4" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </Svg>
  )
}

export function LockIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Svg>
  )
}

export function InfoIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </Svg>
  )
}
