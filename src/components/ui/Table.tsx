import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Table — design-system.md §6.
 * 56px rows, 1px bottom border, hover #FAFAFA, right-aligned kebab menu, all
 * inside a 1px-bordered rounded panel.
 *
 * Built from ARIA grid roles rather than <table> markup, matching the specimen
 * sheet (which lays rows out with flexbox) — the columns are flexible widths
 * driven by the cells, which table layout would fight.
 */
const HeadContext = createContext(false)

export function Table({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      role="table"
      className={[
        'overflow-hidden rounded-card border border-line bg-page',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
}

export function TableHead({ children }: { children: ReactNode }) {
  return (
    <HeadContext.Provider value={true}>
      <div
        role="row"
        className="flex h-10 items-center gap-4 border-b border-line bg-app px-4 text-micro font-semibold uppercase text-ink-muted"
      >
        {children}
      </div>
    </HeadContext.Provider>
  )
}

export function TableRow({
  children,
  onClick,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  className?: string
}) {
  const interactive = Boolean(onClick)

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!onClick) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onClick()
    }
  }

  return (
    <div
      role="row"
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={interactive ? handleKeyDown : undefined}
      className={[
        // min-h, not h: a row whose content wraps (e.g. a status cell with a
        // pill plus two action buttons, in a narrower column than
        // Availability's) grows instead of clipping. py-2 keeps unwrapped
        // rows visually identical to the old fixed 56px.
        'flex min-h-14 items-center gap-4 border-b border-line px-4 py-2 last:border-b-0',
        'transition-colors duration-hover hover:bg-hover',
        interactive ? 'cursor-pointer' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
}

export function TableCell({
  children,
  align = 'left',
  className = '',
}: {
  children?: ReactNode
  align?: 'left' | 'right'
  className?: string
}) {
  const isHead = useContext(HeadContext)
  return (
    <div
      role={isHead ? 'columnheader' : 'cell'}
      className={[
        'flex min-w-0 items-center gap-2',
        align === 'right' ? 'justify-end text-right tabular' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  )
}

/**
 * Row kebab menu. Fully keyboard operable: Enter/Space/ArrowDown open it,
 * arrows move between items, Escape closes and returns focus to the trigger.
 */
export function KebabMenu({
  items,
}: {
  items: { label: string; onClick: () => void; danger?: boolean }[]
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    if (!open) return
    itemRefs.current[activeIndex]?.focus()
  }, [open, activeIndex])

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node
      if (menuRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  function close(restoreFocus: boolean) {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  function openAt(index: number) {
    setActiveIndex(index)
    setOpen(true)
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openAt(0)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      openAt(Math.max(items.length - 1, 0))
    }
  }

  function onMenuKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
    } else if (e.key === 'Tab') {
      close(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => (i + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => (i - 1 + items.length) % items.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActiveIndex(Math.max(items.length - 1, 0))
    }
  }

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={t('a11y.rowMenu')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={onTriggerKeyDown}
        className="flex h-8 w-8 items-center justify-center rounded-control text-ink-muted transition-colors duration-hover hover:bg-app hover:text-ink"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
          aria-hidden="true"
        >
          <circle cx="12" cy="5" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="12" cy="19" r="1" />
        </svg>
      </button>

      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label={t('a11y.rowMenu')}
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 z-20 mt-1 min-w-[11rem] rounded-card border border-line bg-page py-1 shadow-elevated"
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              ref={(node) => {
                itemRefs.current[index] = node
              }}
              type="button"
              role="menuitem"
              tabIndex={index === activeIndex ? 0 : -1}
              onClick={() => {
                close(true)
                item.onClick()
              }}
              className={[
                'block w-full px-3 py-2 text-left text-meta transition-colors duration-hover hover:bg-hover',
                item.danger ? 'text-danger' : 'text-ink',
              ].join(' ')}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
