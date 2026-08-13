import type { ReactNode } from 'react'

/**
 * Empty state — design-system.md §6.
 * Friendly line-art illustration (thin 1.5px strokes, --text-secondary), one
 * sentence, optional single action. Never an empty gray box.
 */
export type EmptyIllustration = 'calendar' | 'tasks' | 'trades' | 'search'

const SVG_PROPS = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: 'mb-4 h-10 w-10 text-ink-muted',
  'aria-hidden': true,
}

function Illustration({ name }: { name: EmptyIllustration }) {
  if (name === 'tasks') {
    return (
      <svg {...SVG_PROPS}>
        <rect x="3" y="4" width="18" height="17" rx="2.5" />
        <path d="m8 12.5 2.5 2.5L16 9.5" />
      </svg>
    )
  }
  if (name === 'trades') {
    return (
      <svg {...SVG_PROPS}>
        <path d="M20.5 12a8.5 8.5 0 0 1-14.6 5.9" />
        <path d="M3.5 12a8.5 8.5 0 0 1 14.6-5.9" />
        <path d="M3.5 17.9v-4h4" />
        <path d="M20.5 6.1v4h-4" />
      </svg>
    )
  }
  if (name === 'search') {
    return (
      <svg {...SVG_PROPS}>
        <circle cx="11" cy="11" r="7" />
        <path d="m20.5 20.5-4.2-4.2" />
      </svg>
    )
  }
  return (
    <svg {...SVG_PROPS}>
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 10h18" />
      <path d="M8 3v4M16 3v4" />
    </svg>
  )
}

export function EmptyState({
  illustration = 'calendar',
  title,
  body,
  action,
}: {
  illustration?: EmptyIllustration
  title: string
  body: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center rounded-card-lg border border-line bg-page p-8 text-center">
      <Illustration name={illustration} />
      <p className="text-body font-semibold text-ink">{title}</p>
      <p className="mt-1 max-w-[36ch] text-meta text-ink-muted">{body}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  )
}
