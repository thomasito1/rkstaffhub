import type { ReactNode } from 'react'

/**
 * "My Tasks" icon set — inline SVG, no icon library (CLAUDE.md "no component
 * libraries"), same convention as `pages/clock/icons.tsx` and
 * `components/shell/navItems.tsx`. Paths are the matching Lucide outlines
 * mockup 27 draws at a 1.5px stroke.
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

export function CheckIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  )
}

export function CameraIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
      <circle cx="12" cy="13" r="3.5" />
    </Svg>
  )
}

export function SlidersHorizontalIcon({ className }: IconProps): JSX.Element {
  return (
    <Svg className={className}>
      <path d="M4 6h6M14 6h6M4 12h10M18 12h2M4 18h2M10 18h10" />
      <circle cx="12" cy="6" r="1.5" />
      <circle cx="16" cy="12" r="1.5" />
      <circle cx="8" cy="18" r="1.5" />
    </Svg>
  )
}
