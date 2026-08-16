import type { ReactNode } from 'react'

/**
 * HR hub icon set — inline SVG, no icon library (CLAUDE.md "no component
 * libraries"), same convention as `pages/clock/icons.tsx` and
 * `pages/tasks/icons.tsx`: each feature owns a small, self-contained set
 * rather than sharing one global icon module.
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

export function FileTextIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6M9 17h6M9 9h1" />
    </Svg>
  )
}

export function BookOpenIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M12 7v14" />
      <path d="M3 5a2 2 0 0 1 2-2h4a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H3Z" />
      <path d="M21 5a2 2 0 0 0-2-2h-4a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7Z" />
    </Svg>
  )
}

export function ClipboardListIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M9 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4" />
      <path d="M9 12h6M9 16h6M9 8h.01" />
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

export function ChevronRightIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="m9 18 6-6-6-6" />
    </Svg>
  )
}

export function CheckIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M20 6 9 17l-5-5" />
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

export function XIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M18 6 6 18M6 6l12 12" />
    </Svg>
  )
}

export function UndoIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Svg>
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

export function InfoIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </Svg>
  )
}

export function MailIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 6-10 7L2 6" />
    </Svg>
  )
}
