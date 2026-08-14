import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { formatHours } from '@/lib/format'

import { BackspaceIcon, ChevronLeftIcon } from './icons'

const KEYS: readonly string[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫']

/**
 * Tip entry numpad — mockup 22a. Free-form dollars-then-cents entry (type the
 * whole-dollar digits, optionally hit "." to start entering cents) rather
 * than a cents-shift keypad — matches the mockup's own worked example
 * (typing "1","4","2" reads as "$142.00", not "$1.42").
 */
export function TipsNumpadScreen({
  shiftHours,
  initialAmount,
  onBack,
  onContinue,
  onNoTips,
}: {
  shiftHours: number
  /** Re-populates the pad when returning from "Edit amount" on the confirm screen. */
  initialAmount?: number
  onBack: () => void
  onContinue: (amount: number) => void
  onNoTips: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const initial = initialAmount && initialAmount > 0 ? initialAmount.toFixed(2).split('.') : null
  const [whole, setWhole] = useState(initial?.[0] ?? '0')
  const [hasDecimal, setHasDecimal] = useState(Boolean(initial))
  const [decimal, setDecimal] = useState(initial?.[1] ?? '')

  function pressDigit(d: string) {
    if (!hasDecimal) {
      setWhole((w) => {
        if (w === '0') return d === '0' ? '0' : d
        if (w.length >= 6) return w
        return w + d
      })
    } else if (decimal.length < 2) {
      setDecimal((c) => c + d)
    }
  }

  function pressDot() {
    if (!hasDecimal) setHasDecimal(true)
  }

  function pressBackspace() {
    if (hasDecimal) {
      if (decimal.length > 0) setDecimal((c) => c.slice(0, -1))
      else setHasDecimal(false)
    } else {
      setWhole((w) => (w.length > 1 ? w.slice(0, -1) : '0'))
    }
  }

  function handleKey(key: string) {
    if (key === '⌫') pressBackspace()
    else if (key === '.') pressDot()
    else pressDigit(key)
  }

  const decimalDisplay = hasDecimal ? decimal.padEnd(2, '0').slice(0, 2) : '00'
  const amount = Number(`${whole}.${decimalDisplay}`)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-page pl-safe pr-safe">
      <div aria-hidden="true" className="h-safe-top w-full shrink-0 bg-page" />

      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-line px-4">
        <button type="button" onClick={onBack} aria-label={t('clock.tips.goBack')} className="w-10 -ml-2 p-2 text-ink">
          <ChevronLeftIcon className="h-6 w-6" />
        </button>
        <h1 className="text-section font-semibold text-ink">{t('clock.selfie.titleOut')}</h1>
        <span className="w-20 text-right text-chip text-ink-muted">
          {t('clock.selfie.stepOf', { step: 2, total: 3 })}
        </span>
      </header>
      <div className="flex h-1 w-full shrink-0 bg-line">
        <div className="flex-1 bg-primary" />
        <div className="flex-1 bg-primary" />
        <div className="flex-1 bg-line" />
      </div>

      <main className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-10">
        <div className="mb-8 text-center">
          <h2 className="text-section font-semibold leading-tight text-ink">{t('clock.tips.title')}</h2>
          <p className="mt-2 text-meta text-ink-muted">{t('clock.tips.subtitle')}</p>
        </div>

        <div className="flex flex-col items-center">
          <div className="tabular flex items-baseline gap-1">
            <span className="text-title-lg text-ink-muted">$</span>
            <span className="text-[56px] font-semibold leading-none text-ink">{whole}</span>
            <span className="text-title-lg font-semibold text-ink-muted">.{decimalDisplay}</span>
          </div>
          <div className="mt-2 h-px w-[240px] bg-line" />
          <p className="mt-3 text-chip font-medium uppercase tracking-wider text-ink-muted">
            {t('clock.tips.shiftTotal', { hours: formatHours(shiftHours, i18n.language) })}
          </p>
        </div>

        <div className="mb-8 mt-auto w-full pb-6">
          <div className="mb-8 grid grid-cols-3 gap-2">
            {KEYS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => handleKey(key)}
                className="tabular flex h-[72px] items-center justify-center rounded-control border border-line bg-page text-[26px] font-medium text-ink active:bg-hover"
              >
                {key === '⌫' ? <BackspaceIcon className="h-6 w-6 text-ink-muted" /> : key}
              </button>
            ))}
          </div>

          <div className="flex flex-col gap-4 px-2">
            <button
              type="button"
              onClick={() => onContinue(amount)}
              className="flex h-14 w-full items-center justify-center rounded-control bg-primary font-semibold text-white transition-transform active:scale-[0.98]"
            >
              {t('clock.tips.continue')}
            </button>
            <button type="button" onClick={onNoTips} className="text-center text-meta font-semibold text-primary">
              {t('clock.tips.noTips')}
            </button>
          </div>
        </div>
      </main>

      <div aria-hidden="true" className="h-safe-bottom w-full shrink-0 bg-page" />
    </div>
  )
}
