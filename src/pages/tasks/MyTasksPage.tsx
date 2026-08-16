import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { RequirePermission } from '@/components/guards/RouteGuards'
import { Card, EmptyState, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth/AuthProvider'
import { formatDate, formatPercent } from '@/lib/format'
import { completeTaskInstance } from '@/lib/tasks/taskActions'
import { uploadTaskPhoto } from '@/lib/tasks/taskPhotoUpload'
import type { TaskInstance } from '@/types/models'

import { SlidersHorizontalIcon } from './icons'
import { TaskCard } from './TaskCard'
import { taskErrorMessage } from './taskErrors'
import { groupByCadence, todayIsoRestaurant, todayProgress } from './shared'
import { useMyTasksData } from './useMyTasksData'

/**
 * My Tasks — spec §10, mockup 27. Every instance ever assigned to the
 * employee plus unclaimed pool instances in their department, grouped purely
 * by cadence (see `shared.ts`'s `groupByCadence` for why period isn't used).
 */
export function MyTasksPage(): JSX.Element {
  return (
    <RequirePermission permission="tasks.complete">
      <MyTasksScreen />
    </RequirePermission>
  )
}

function MyTasksScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()
  const { employee } = useAuth()
  const data = useMyTasksData(employee)
  const [busyId, setBusyId] = useState<string | null>(null)

  const photoProofEnabled = data.settings?.featureFlags.taskPhotoProof ?? false
  const todayIso = todayIsoRestaurant()
  const progress = todayProgress(data.instances, todayIso)
  const groups = groupByCadence(data.instances)
  const isEmpty = groups.today.length === 0 && groups.week.length === 0 && groups.month.length === 0

  async function handleComplete(instance: TaskInstance) {
    if (busyId) return
    setBusyId(instance.id)
    try {
      await completeTaskInstance({ instanceId: instance.id })
      toast.show({ tone: 'success', message: t('tasks.myTasks.toastCompleted') })
      void data.reload()
    } catch (err) {
      toast.show({ tone: 'error', message: taskErrorMessage(t, err) })
    } finally {
      setBusyId(null)
    }
  }

  async function handlePhotoSelected(instance: TaskInstance, file: File) {
    if (busyId || !employee) return
    setBusyId(instance.id)
    try {
      const photoPath = await uploadTaskPhoto(employee.id, instance.id, file)
      await completeTaskInstance({ instanceId: instance.id, photoPath })
      toast.show({ tone: 'success', message: t('tasks.myTasks.toastCompleted') })
      void data.reload()
    } catch {
      toast.show({ tone: 'error', message: t('tasks.myTasks.photoUploadError') })
    } finally {
      setBusyId(null)
    }
  }

  if (data.loading) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-4">
        <div className="h-20 animate-skeleton rounded-card-lg bg-app" />
        <div className="h-24 animate-skeleton rounded-card-lg bg-app" />
        <div className="h-24 animate-skeleton rounded-card-lg bg-app" />
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 pb-4">
      <header className="flex items-center justify-between">
        <h1 className="text-title font-semibold leading-tight text-ink">{t('tasks.myTasks.title')}</h1>
        {/* Mockup 27's filter icon — rendered for visual parity; filtering
            behavior isn't part of this task's scope. */}
        <button type="button" aria-label={t('tasks.myTasks.filterButton')} className="p-2 text-ink-muted">
          <SlidersHorizontalIcon className="h-5 w-5" />
        </button>
      </header>

      <Card>
        <div className="flex items-center justify-between">
          <span className="text-body font-semibold text-ink">
            {t('tasks.myTasks.progress', { done: progress.done, total: progress.total })}
          </span>
          <span className="tabular text-meta font-semibold text-ink">
            {formatPercent(progress.fraction, lang, 0)}
          </span>
        </div>
        <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-success" style={{ width: `${progress.fraction * 100}%` }} />
        </div>
        <p className="mt-3 text-chip text-ink-muted">
          {formatDate(new Date(), { weekday: 'long', month: 'short', day: 'numeric' }, lang)}
        </p>
      </Card>

      {isEmpty ? (
        <EmptyState
          illustration="tasks"
          title={t('tasks.myTasks.emptyTitle')}
          body={t('tasks.myTasks.emptyBody')}
        />
      ) : (
        <>
          <Group titleKey="tasks.myTasks.groupToday" count={groups.today.length}>
            {groups.today.map((instance) => (
              <TaskCard
                key={instance.id}
                instance={instance}
                photoProofEnabled={photoProofEnabled}
                busy={busyId === instance.id}
                onComplete={(i) => void handleComplete(i)}
                onPhotoSelected={(i, file) => void handlePhotoSelected(i, file)}
              />
            ))}
          </Group>

          <Group titleKey="tasks.myTasks.groupWeek" count={groups.week.length}>
            {groups.week.map((instance) => (
              <TaskCard
                key={instance.id}
                instance={instance}
                photoProofEnabled={photoProofEnabled}
                busy={busyId === instance.id}
                onComplete={(i) => void handleComplete(i)}
                onPhotoSelected={(i, file) => void handlePhotoSelected(i, file)}
              />
            ))}
          </Group>

          <Group titleKey="tasks.myTasks.groupMonth" count={groups.month.length}>
            {groups.month.map((instance) => (
              <TaskCard
                key={instance.id}
                instance={instance}
                photoProofEnabled={photoProofEnabled}
                busy={busyId === instance.id}
                onComplete={(i) => void handleComplete(i)}
                onPhotoSelected={(i, file) => void handlePhotoSelected(i, file)}
              />
            ))}
          </Group>

          <footer className="pt-2 text-center">
            <p className="text-chip text-ink-muted">{t('tasks.myTasks.footerNote')}</p>
          </footer>
        </>
      )}
    </div>
  )
}

/** One cadence-bucket section (mockup 27's "TODAY" / "THIS WEEK" / "THIS MONTH" group headers). Renders nothing when empty. */
function Group({ titleKey, count, children }: { titleKey: string; count: number; children: ReactNode }): JSX.Element | null {
  const { t } = useTranslation()
  if (count === 0) return null
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-chip font-semibold uppercase tracking-widest text-ink-muted">
        {t(titleKey)} <span className="opacity-50">{count}</span>
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

export default MyTasksPage
