import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { formatDate } from '@/lib/format'
import type { Language, Policy } from '@/types/models'

import { ChevronLeftIcon, FileTextIcon, InfoIcon } from './icons'

/**
 * Policy read view — mockup 30a. Rendered as a fixed full-viewport overlay
 * (same convention as `pages/clock/SelfieCaptureScreen.tsx`) so it visually
 * replaces the bottom tab bar the mockup hides, without touching
 * AppShell/MobileShell.
 *
 * `bodyMarkdown`/`bodyMarkdownEs` are the policy's OWN language fields, not
 * i18n keys — CLAUDE.md's i18n rule is about UI chrome, not user-authored
 * document content. No markdown-rendering library exists in this codebase
 * yet (checked package.json), so this renders a light hand-rolled pass
 * (`#`/`##` headings, `-`/`*` bullets, blank-line paragraph breaks) rather
 * than adding a new dependency for one screen.
 */

const WORDS_PER_MINUTE = 200

function renderBody(text: string): ReactNode[] {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let listBuffer: string[] = []
  let key = 0

  function flushList() {
    if (listBuffer.length === 0) return
    blocks.push(
      <ul key={`ul-${key++}`} className="list-disc space-y-2 pl-5">
        {listBuffer.map((item, i) => (
          <li key={i} className="text-[16px] leading-[1.6] text-ink">
            {item}
          </li>
        ))}
      </ul>,
    )
    listBuffer = []
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      flushList()
      continue
    }
    const heading = /^#{1,3}\s+(.*)/.exec(line)
    if (heading?.[1]) {
      flushList()
      blocks.push(
        <h3 key={`h-${key++}`} className="text-[18px] font-semibold text-ink">
          {heading[1]}
        </h3>,
      )
      continue
    }
    const bullet = /^[-*]\s+(.*)/.exec(line)
    if (bullet?.[1]) {
      listBuffer.push(bullet[1])
      continue
    }
    flushList()
    blocks.push(
      <p key={`p-${key++}`} className="text-[16px] leading-[1.6] text-ink">
        {line}
      </p>,
    )
  }
  flushList()
  return blocks
}

export function PolicyReadScreen({
  policy,
  requiresSignature,
  onClose,
  onContinueToSign,
}: {
  policy: Policy
  requiresSignature: boolean
  onClose: () => void
  onContinueToSign: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const mainRef = useRef<HTMLDivElement | null>(null)
  const [scrollFraction, setScrollFraction] = useState(0)
  const [viewLang, setViewLang] = useState<Language>(i18n.language.startsWith('es') ? 'es' : 'en')

  const hasEs = Boolean(policy.titleEs && policy.bodyMarkdownEs)
  const showEs = viewLang === 'es' && hasEs
  const title = showEs ? policy.titleEs : policy.title
  const body = showEs ? policy.bodyMarkdownEs : policy.bodyMarkdown

  const readMinutes = useMemo(() => {
    const words = body.trim().split(/\s+/).filter(Boolean).length
    return Math.max(1, Math.round(words / WORDS_PER_MINUTE))
  }, [body])

  const blocks = useMemo(() => renderBody(body), [body])

  const atEnd = scrollFraction >= 0.98

  function handleScroll() {
    const el = mainRef.current
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    setScrollFraction(max <= 0 ? 1 : Math.min(1, el.scrollTop / max))
  }

  const activeFromDate = policy.activeFrom ? new Date(`${policy.activeFrom}T00:00:00`) : null

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-page pl-safe pr-safe">
      <div aria-hidden="true" className="h-safe-top w-full shrink-0 bg-page" />

      <header className="shrink-0 border-b border-line bg-page">
        <div className="relative flex h-[56px] items-center px-4">
          <button type="button" onClick={onClose} aria-label={t('hr.read.back')} className="absolute left-4 -ml-2 p-1">
            <ChevronLeftIcon className="h-6 w-6 text-ink" />
          </button>
          <h1 className="flex-1 truncate px-12 text-center text-section font-semibold text-ink">{title}</h1>
          {requiresSignature ? (
            <span className="absolute right-4 text-chip font-medium text-ink-muted">
              {t('hr.stepIndicator', { step: 1, total: 3 })}
            </span>
          ) : null}
        </div>
        {requiresSignature ? (
          <div className="flex h-[3px] w-full bg-line">
            <div className="h-full w-1/3 bg-primary" />
            <div className="h-full w-1/3 bg-line" />
            <div className="h-full w-1/3 bg-line" />
          </div>
        ) : null}
      </header>

      <div className="shrink-0 px-4 py-3">
        <div className="flex items-center gap-3 rounded-card-lg border border-line bg-page p-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-app text-ink-muted">
            <FileTextIcon className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-meta font-semibold text-ink">{title}</p>
            <p className="truncate text-chip text-ink-muted">
              {t('hr.read.meta', {
                version: policy.version,
                date: activeFromDate ? formatDate(activeFromDate, { dateStyle: 'medium' }, i18n.language) : policy.activeFrom,
                minutes: readMinutes,
              })}
            </p>
          </div>
          <div className="flex shrink-0 rounded-lg bg-app p-0.5">
            <button
              type="button"
              onClick={() => setViewLang('en')}
              className={`rounded-md px-2 py-1 text-chip font-bold ${viewLang === 'en' ? 'bg-page text-ink shadow-sm' : 'text-ink-muted'}`}
            >
              {t('hr.read.langEn')}
            </button>
            <button
              type="button"
              onClick={() => setViewLang('es')}
              className={`rounded-md px-2 py-1 text-chip font-bold ${viewLang === 'es' ? 'bg-page text-ink shadow-sm' : 'text-ink-muted'}`}
            >
              {t('hr.read.langEs')}
            </button>
          </div>
        </div>
        {viewLang === 'es' && !hasEs ? (
          <p className="mt-2 flex items-center gap-1.5 text-chip text-warning">
            <InfoIcon className="h-3.5 w-3.5" />
            {t('hr.read.noSpanishFallback')}
          </p>
        ) : null}
      </div>

      <main ref={mainRef} onScroll={handleScroll} className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-6 px-6 py-6 pb-24">{blocks}</div>
      </main>

      <footer className="shrink-0 border-t border-line bg-page px-4 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] pt-3">
        <div className="flex flex-col gap-3">
          {requiresSignature ? (
            <>
              {!atEnd ? (
                <div className="flex items-center justify-center gap-1.5">
                  <InfoIcon className="h-4 w-4 text-ink-muted" />
                  <span className="text-chip text-ink-muted">{t('hr.read.scrollToContinue')}</span>
                </div>
              ) : null}
              <button
                type="button"
                onClick={onContinueToSign}
                disabled={!atEnd}
                className="flex h-14 w-full items-center justify-center rounded-control bg-primary font-semibold text-white transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t('hr.read.continueToSign')}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="flex h-14 w-full items-center justify-center rounded-control bg-primary font-semibold text-white transition-transform active:scale-[0.98]"
            >
              {t('hr.read.done')}
            </button>
          )}
        </div>
      </footer>

      <div aria-hidden="true" className="h-safe-bottom w-full shrink-0 bg-page" />
    </div>
  )
}

export default PolicyReadScreen
