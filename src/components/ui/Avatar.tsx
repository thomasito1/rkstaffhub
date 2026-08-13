import { useTranslation } from 'react-i18next'
import { initialsOf } from '@/lib/format'

/**
 * Avatar — design-system.md §6.
 * Photo where available, otherwise a colored fallback with initials; the
 * fallback color is derived deterministically from the name so the same person
 * is always the same color across every screen.
 */
export type AvatarSize = 24 | 28 | 32 | 40 | 48 | 80

const SIZE: Record<AvatarSize, string> = {
  24: 'h-6 w-6 text-[10px]',
  28: 'h-7 w-7 text-[11px]',
  32: 'h-8 w-8 text-chip',
  40: 'h-10 w-10 text-meta',
  48: 'h-12 w-12 text-body',
  80: 'h-20 w-20 text-[28px]',
}

/**
 * Fallback palette. Every entry is a design token (semantic or role band) so no
 * raw hex reaches a component. Written as whole class strings for Tailwind's
 * content scanner.
 */
const FALLBACK_COLORS = [
  'bg-primary',
  'bg-success',
  'bg-warning',
  'bg-role-bartender',
  'bg-role-host',
  'bg-role-runner',
  'bg-role-manager',
  'bg-role-onCallServer',
] as const

/** Stable 32-bit string hash — same name in, same color out, forever. */
function colorFor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length] ?? 'bg-primary'
}

export function Avatar({
  firstName,
  lastName,
  photoUrl,
  size = 32,
  className = '',
}: {
  firstName: string
  lastName: string
  photoUrl?: string | null
  size?: AvatarSize
  className?: string
}) {
  const { t } = useTranslation()
  const name = `${firstName} ${lastName}`.trim()

  const shell = [
    'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold',
    SIZE[size],
    className,
  ]
    .filter(Boolean)
    .join(' ')

  if (photoUrl) {
    return (
      <span className={`${shell} border border-line bg-app`}>
        <img
          src={photoUrl}
          alt={t('a11y.avatarOf', { name })}
          className="h-full w-full object-cover"
        />
      </span>
    )
  }

  return (
    <span
      role="img"
      aria-label={name}
      className={`${shell} ${colorFor(name)} text-white`}
    >
      <span aria-hidden="true">{initialsOf(firstName, lastName)}</span>
    </span>
  )
}
