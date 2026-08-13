import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Toast — design-system.md §6.
 * Bottom-center on mobile, bottom-right on desktop; icon + message + optional
 * action. Dark surface, elevated (one of only two components that may be).
 */
export type ToastTone = 'success' | 'warning' | 'error' | 'info'

export interface ToastOptions {
  tone: ToastTone
  message: string
  action?: { label: string; onClick: () => void }
}

interface ToastItem extends ToastOptions {
  id: number
}

const AUTO_DISMISS_MS = 5000

const ToastContext = createContext<{ show: (t: ToastOptions) => void } | null>(
  null,
)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used inside a <ToastProvider>')
  }
  return ctx
}

const ICON_TONE: Record<ToastTone, string> = {
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-danger',
  // On the dark toast surface the full-strength primary is too dark to read,
  // so the info glyph uses the same light blue the specimen sheet gives the
  // toast's action link.
  info: 'text-blue-400',
}

function ToastIcon({ tone }: { tone: ToastTone }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className: `h-5 w-5 shrink-0 ${ICON_TONE[tone]}`,
    'aria-hidden': true,
  }

  if (tone === 'success') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12.5 2.5 2.5 4.5-5" />
      </svg>
    )
  }
  if (tone === 'warning') {
    return (
      <svg {...common}>
        <path d="M10.7 4.2 3.3 17a1.5 1.5 0 0 0 1.3 2.2h14.8a1.5 1.5 0 0 0 1.3-2.2L13.3 4.2a1.5 1.5 0 0 0-2.6 0Z" />
        <path d="M12 9.5v4" />
        <path d="M12 16.8h.01" />
      </svg>
    )
  }
  if (tone === 'error') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="m14.5 9.5-5 5M9.5 9.5l5 5" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11.5v5" />
      <path d="M12 7.8h.01" />
    </svg>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  const timers = useRef<number[]>([])

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const show = useCallback(
    (options: ToastOptions) => {
      const id = nextId.current
      nextId.current += 1
      setToasts((current) => [...current, { ...options, id }])
      const timer = window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
      timers.current.push(timer)
    },
    [dismiss],
  )

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer)
      timers.current = []
    },
    [],
  )

  const value = useMemo(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:bottom-6 sm:right-6 sm:items-end sm:px-0"
        >
          {toasts.map((toast) => (
            <div
              key={toast.id}
              role={toast.tone === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto inline-flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-card bg-ink px-4 py-3 text-white shadow-elevated"
            >
              <ToastIcon tone={toast.tone} />
              <span className="text-meta">{toast.message}</span>
              {toast.action ? (
                <button
                  type="button"
                  onClick={() => {
                    toast.action?.onClick()
                    dismiss(toast.id)
                  }}
                  className="ml-4 shrink-0 text-meta font-semibold text-blue-400 transition-colors duration-hover hover:text-blue-300"
                >
                  {toast.action.label}
                </button>
              ) : null}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}
