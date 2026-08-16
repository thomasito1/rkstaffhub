import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, useToast } from '@/components/ui'
import { generateAiSchedule } from '@/lib/ai/aiActions'
import { formatDate } from '@/lib/format'
import type { AiDraftMeta } from '@/types/models'
import { aiErrorMessage } from './aiErrorMessage'

/**
 * The AI-draft banner — mockup 13's violet "AI draft — review required" panel,
 * mirroring the exact visual treatment of the existing auditPending/
 * pushPending banners in ScheduleBuilderPage (same full-width strip, same
 * "info line + action" shape) rather than inventing a new pattern.
 *
 * Shown whenever `schedule.aiDraftMeta` is non-null. Purely informational
 * plus a "regenerate with instructions" action — CLAUDE.md/spec §13: never a
 * publish shortcut of its own. Publish stays the existing PublishModal flow.
 */
export function AiDraftBanner({
  weekId,
  meta,
  lang,
  onGenerated,
}: {
  weekId: string
  meta: AiDraftMeta
  lang: string
  onGenerated: () => Promise<void>
}): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()

  const [instructions, setInstructions] = useState('')
  const [regenerating, setRegenerating] = useState(false)
  const [instructionsError, setInstructionsError] = useState<string | null>(null)

  const generatedAt = toJsDate(meta.generatedAt)
  const invalidCount = meta.invalidShiftCount ?? 0

  async function handleRegenerate(): Promise<void> {
    const trimmed = instructions.trim()
    // A fresh "Generate with AI" click has no text box at all — this box is
    // specifically "regenerate BECAUSE of this feedback," so empty text here
    // is never allowed (distinct from a from-scratch generation, which needs
    // no instructions at all).
    if (!trimmed) {
      setInstructionsError(t('scheduleBuilder.ai.banner.instructionsRequired'))
      return
    }
    setInstructionsError(null)
    setRegenerating(true)
    try {
      await generateAiSchedule(weekId, trimmed)
      toast.show({ tone: 'success', message: t('scheduleBuilder.ai.toast.regenerated') })
      setInstructions('')
      await onGenerated()
    } catch (err) {
      toast.show({ tone: 'error', message: aiErrorMessage(t, err) })
    } finally {
      setRegenerating(false)
    }
  }

  return (
    <div className="flex shrink-0 flex-col gap-4 border-b border-line bg-[#8B5CF61A] px-8 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-100 text-violet-600"
            aria-hidden="true"
          >
            <SparklesIcon className="h-5 w-5" />
          </span>
          <div>
            <p className="text-body font-semibold text-ink">{t('scheduleBuilder.ai.banner.title')}</p>
            <p className="mt-0.5 text-meta text-ink-muted">{meta.promptSummary}</p>
            <p className="mt-1 text-chip text-ink-muted">
              {generatedAt
                ? t('scheduleBuilder.ai.banner.provenance', {
                    date: formatDate(generatedAt, { dateStyle: 'medium', timeStyle: 'short' }, lang),
                    provider: meta.provider,
                    model: meta.model,
                  })
                : t('scheduleBuilder.ai.banner.subtitle')}
            </p>
          </div>
        </div>

        {invalidCount > 0 ? (
          <span className="flex shrink-0 items-center gap-2 rounded-control border border-warning bg-warning-tint px-3 py-1.5 text-chip font-semibold text-warning">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="h-3.5 w-3.5" aria-hidden="true">
              <path d="M10.3 3.4 2.6 17a1.5 1.5 0 0 0 1.3 2.2h16.2a1.5 1.5 0 0 0 1.3-2.2L13.7 3.4a1.5 1.5 0 0 0-3.4 0Z" />
              <path d="M12 9v4M12 16.3h.01" />
            </svg>
            {t('scheduleBuilder.ai.banner.invalidCount', { count: invalidCount })}
          </span>
        ) : null}
      </div>

      <div className="max-w-xl">
        <label htmlFor="ai-regenerate-instructions" className="mb-1.5 block text-chip font-semibold text-ink">
          {t('scheduleBuilder.ai.banner.regenerateLabel')}
        </label>
        <textarea
          id="ai-regenerate-instructions"
          value={instructions}
          onChange={(e) => {
            setInstructions(e.target.value)
            if (instructionsError) setInstructionsError(null)
          }}
          placeholder={t('scheduleBuilder.ai.banner.regeneratePlaceholder')}
          rows={2}
          disabled={regenerating}
          className="w-full resize-none rounded-control border border-line bg-page px-3 py-2 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
        />
        {instructionsError ? (
          <p className="mt-1 text-chip font-medium text-danger">{instructionsError}</p>
        ) : null}
        <Button
          className="mt-2"
          variant="secondary"
          disabled={regenerating}
          icon={<SparklesIcon className="h-4 w-4 text-violet-600" />}
          onClick={() => void handleRegenerate()}
        >
          {regenerating
            ? t('scheduleBuilder.ai.banner.regenerating')
            : t('scheduleBuilder.ai.banner.regenerateButton')}
        </Button>
      </div>
    </div>
  )
}

function toJsDate(value: unknown): Date | null {
  if (value && typeof value === 'object' && 'toDate' in value) {
    return (value as { toDate(): Date }).toDate()
  }
  return null
}

function SparklesIcon({ className }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className={className} aria-hidden="true">
      <path d="M12 3v3.5M12 17.5V21M4.5 12H8M16 12h3.5M6.8 6.8l2.1 2.1M15.1 15.1l2.1 2.1M17.2 6.8l-2.1 2.1M8.9 15.1l-2.1 2.1" />
    </svg>
  )
}
