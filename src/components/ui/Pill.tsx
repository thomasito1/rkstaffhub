import type { ReactNode } from 'react'

/**
 * Status pill — design-system.md §6.
 * 12px / 600, fully round, tinted background + full-strength text.
 *
 * `draft` uses #F3F4F6 / #6B7280 from the design system; those land exactly on
 * Tailwind's stock gray-100 / our `ink-muted`, so no raw hex is needed.
 */
export type PillTone =
  | 'pending'
  | 'approved'
  | 'declined'
  | 'draft'
  | 'published'
  | 'neutral'

const TONE: Record<PillTone, string> = {
  pending: 'bg-warning-tint text-warning',
  approved: 'bg-success-tint text-success',
  declined: 'bg-danger-tint text-danger',
  draft: 'bg-gray-100 text-ink-muted',
  published: 'bg-primary-tint text-primary',
  // Not in the specimen sheet — a bordered, untinted variant for counts and
  // other non-status labels, so `draft` keeps its meaning.
  neutral: 'bg-app text-ink-muted ring-1 ring-inset ring-line',
}

export function Pill({
  tone,
  children,
  className = '',
}: {
  tone: PillTone
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={[
        'inline-flex items-center whitespace-nowrap rounded-full px-3 py-1',
        'text-chip font-semibold',
        TONE[tone],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  )
}
