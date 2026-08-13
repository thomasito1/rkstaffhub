import { useId } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Filter dropdown row — design-system.md §6.
 * Horizontal row of compact select controls, a search input and a right-aligned
 * action, sitting on the app frame surface inside a 1px border.
 */
export function FilterBar({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={[
        'flex flex-wrap items-center gap-2 rounded-card border border-line bg-app p-3',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
}

const CONTROL =
  'rounded-md border border-line bg-page text-meta text-ink ' +
  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary'

function ChevronDown() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
}) {
  const id = useId()
  return (
    <div className="relative">
      {/* The control shows the selected option; the filter's name is carried
          for assistive tech only, as in the specimen sheet's compact row. */}
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`${CONTROL} h-8 appearance-none py-0 pl-3 pr-8`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown />
    </div>
  )
}

export function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const { t } = useTranslation()
  return (
    <div className="relative">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? t('common.searchPlaceholder')}
        aria-label={t('common.search')}
        className={`${CONTROL} h-8 w-56 pl-9 pr-3 placeholder:text-ink-muted`}
      />
    </div>
  )
}
