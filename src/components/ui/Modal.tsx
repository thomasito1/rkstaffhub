import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

/**
 * Modal — design-system.md §6 / §7.
 * 480–640px wide, 16px radius, elevated, title + close ×, body, right-aligned
 * footer actions. Enters with a fade + 4px rise over 200ms.
 *
 * Accessibility: role="dialog" + aria-modal, focus moves into the dialog on
 * open and is restored to the trigger on close, Tab is trapped, Escape closes,
 * and a scrim click closes (mousedown-based so a drag that starts inside the
 * panel and ends on the scrim does not dismiss it).
 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  footer,
  width = 560,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: string
  footer?: ReactNode
  width?: number
  children: ReactNode
}) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  const [entered, setEntered] = useState(false)
  const titleId = useId()
  const subtitleId = useId()

  // Open: remember the trigger, move focus in, lock the page, play the entry.
  useEffect(() => {
    if (!open) return

    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? panel)?.focus()

    const raf = requestAnimationFrame(() => setEntered(true))
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      cancelAnimationFrame(raf)
      setEntered(false)
      document.body.style.overflow = previousOverflow
      restoreRef.current?.focus()
    }
  }, [open])

  // Escape to close + Tab trap. Bound at the document so focus cannot leak out.
  useEffect(() => {
    if (!open) return

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== 'Tab') return

      const panel = panelRef.current
      if (!panel) return

      const nodes = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((n) => n.offsetParent !== null || n === document.activeElement)

      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (!first || !last) {
        e.preventDefault()
        panel.focus()
        return
      }

      const active = document.activeElement
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className={[
        'fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4',
        'transition-opacity duration-surface ease-out',
        entered ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        style={{ width: '100%', maxWidth: `${width}px` }}
        className={[
          'flex max-h-full flex-col rounded-card-lg border border-line bg-page shadow-elevated',
          'transition duration-surface ease-out focus:outline-none',
          entered ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
        ].join(' ')}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line p-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-section font-semibold text-ink">
              {title}
            </h2>
            {subtitle ? (
              <p id={subtitleId} className="mt-0.5 text-meta text-ink-muted">
                {subtitle}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('a11y.closeDialog')}
            className="-m-1 shrink-0 rounded-control p-1 text-ink-muted transition-colors duration-hover hover:bg-app hover:text-ink"
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
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="overflow-y-auto p-6 text-body text-ink">{children}</div>

        {footer ? (
          <div className="flex justify-end gap-3 border-t border-line p-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}
