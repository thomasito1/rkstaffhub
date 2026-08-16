import type { ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Card, Pill } from '@/components/ui'
import { formatDate, formatTime } from '@/lib/format'
import type { TaskInstance } from '@/types/models'

import { CameraIcon, CheckIcon } from './icons'
import { effectiveRequiresPhoto, toDateOrNull } from './shared'

/**
 * One task card (mockup 27). Four visual states: open (unchecked, tappable
 * checkbox), open + photo-required (checkbox inert, completion via the
 * dashed photo-capture area instead), done (filled teal check, struck-through
 * title, "Done …" line, 55% opacity per the mockup), and missed (muted/grey —
 * not in the mockup, spec §10 just says "flag as missed", so this uses the
 * same dimmed treatment as done plus a neutral "Missed" pill instead of a due
 * chip, and no interaction).
 */
export function TaskCard({
  instance,
  photoProofEnabled,
  busy,
  onComplete,
  onPhotoSelected,
}: {
  instance: TaskInstance
  photoProofEnabled: boolean
  busy: boolean
  onComplete: (instance: TaskInstance) => void
  onPhotoSelected: (instance: TaskInstance, file: File) => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language

  const done = instance.status === 'done'
  const missed = instance.status === 'missed'
  const dimmed = done || missed
  const needsPhoto = instance.status === 'open' && effectiveRequiresPhoto(instance, photoProofEnabled)
  const departmentLabel = t(`departments.${instance.department}`)

  const completedAt = toDateOrNull(instance.completedAt)
  const isTodayCadence = instance.cadence === 'per-shift' || instance.cadence === 'daily'
  const doneLabel = completedAt
    ? isTodayCadence
      ? t('tasks.myTasks.doneAtTime', { time: formatTime(completedAt, lang) })
      : t('tasks.myTasks.doneOnDate', { date: formatDate(completedAt, { month: 'short', day: 'numeric' }, lang) })
    : null

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) onPhotoSelected(instance, file)
  }

  return (
    <Card className={`flex items-start gap-4 ${dimmed ? 'opacity-55' : ''}`}>
      {done ? (
        <div className="mt-0.5 flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg bg-success">
          <CheckIcon className="h-4 w-4 text-white" />
        </div>
      ) : missed ? (
        <div className="mt-0.5 h-[26px] w-[26px] shrink-0 rounded-lg border-2 border-line bg-app" aria-hidden="true" />
      ) : (
        <button
          type="button"
          disabled={busy || needsPhoto}
          aria-label={t('tasks.myTasks.markDone', { title: instance.title })}
          onClick={() => onComplete(instance)}
          className="mt-0.5 h-[26px] w-[26px] shrink-0 rounded-lg border-2 border-line disabled:cursor-default"
        />
      )}

      <div className="min-w-0 flex-1">
        <p className={`text-body font-semibold leading-tight ${done ? 'text-ink-muted line-through' : 'text-ink'}`}>
          {lang.startsWith('es') && instance.titleEs ? instance.titleEs : instance.title}
        </p>
        <p className="mt-1 text-chip text-ink-muted">{departmentLabel}</p>

        {done || missed ? (
          missed ? (
            <div className="mt-2">
              <Pill tone="draft">{t('tasks.myTasks.missedChip')}</Pill>
            </div>
          ) : doneLabel ? (
            <p className="mt-2 text-chip text-ink-muted">{doneLabel}</p>
          ) : null
        ) : needsPhoto ? (
          <div className="mt-2">
            <Pill tone="approved" className="gap-1">
              <CameraIcon className="h-3 w-3" />
              {t('tasks.myTasks.photoRequiredChip')}
            </Pill>
          </div>
        ) : instance.dueRule ? (
          <div className="mt-2">
            <Pill tone="pending">{t('tasks.myTasks.dueChip', { dueRule: instance.dueRule })}</Pill>
          </div>
        ) : null}

        {needsPhoto ? (
          <label className="mt-4 flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1 rounded-control border-2 border-dashed border-line active:bg-app">
            <CameraIcon className="h-6 w-6 text-ink-muted" />
            <span className="text-meta text-ink-muted">{t('tasks.myTasks.takePhotoPrompt')}</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              disabled={busy}
              onChange={handleFileChange}
              className="hidden"
            />
          </label>
        ) : null}
      </div>
    </Card>
  )
}
