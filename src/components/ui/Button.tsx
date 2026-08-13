import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * Button — design-system.md §6.
 *
 * Primary: --primary fill, white text, 8px radius, 40px tall.
 * Secondary: white fill, --border border, --text-primary.
 * Ghost: transparent, --text-secondary, no border.
 * Danger: --danger fill, white text.
 * Disabled: 40% opacity, no pointer.
 *
 * The brand red (#B4232A) is NEVER a button color — blue owns every primary
 * action. There is deliberately no `brand` variant.
 */
/**
 * `success` exists because the mockups consistently pair a TEAL Approve with a
 * white Decline — dashboard "items requiring attention", availability requests,
 * shift pool, trade approval. Teal is the design system's approved/affirmative
 * colour, and CLAUDE.md gives mockups the final say on visuals.
 *
 * It does NOT weaken the rule that #2563EB owns primary actions: `success` is
 * only for approving an item in a list, never for a page's main CTA.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  /** md = 40px (desktop) · lg = 56px (mobile / kiosk tap target). */
  size?: 'md' | 'lg'
  icon?: ReactNode
  fullWidth?: boolean
}

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-control font-semibold ' +
  'transition-colors duration-hover disabled:cursor-not-allowed disabled:opacity-40'

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white hover:bg-blue-700',
  secondary: 'border border-line bg-page text-ink hover:bg-hover',
  ghost: 'bg-transparent text-ink-muted hover:bg-app',
  danger: 'bg-danger text-white hover:bg-red-700',
  success: 'bg-success text-white hover:bg-teal-600',
}

const SIZE: Record<'md' | 'lg', string> = {
  md: 'h-10 px-4 text-meta',
  lg: 'h-14 px-8 text-body',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  fullWidth = false,
  className = '',
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    BASE,
    VARIANT[variant],
    SIZE[size],
    fullWidth ? 'w-full' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button type={type} className={classes} {...rest}>
      {icon ? (
        <span className="shrink-0" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  )
}
