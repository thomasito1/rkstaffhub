import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { useToast } from '@/components/ui'
import { syncQueuedPunches } from '@/lib/offlineQueue/punchQueue'

/**
 * Spec §15: a queued punch syncs automatically once connectivity returns,
 * and the outcome (synced / dropped / still queued) is surfaced to the
 * employee — a `dropped` item means the punch could not go through at all,
 * which needs to be said plainly rather than silently vanishing.
 */
export function useOfflineQueueSync(onSynced: () => void) {
  const { t } = useTranslation()
  const toast = useToast()
  const syncing = useRef(false)

  const runSync = useCallback(async () => {
    if (syncing.current) return
    syncing.current = true
    try {
      const result = await syncQueuedPunches()

      if (result.synced.length === 1) {
        toast.show({ tone: 'success', message: t('clock.offline.syncedOne') })
      } else if (result.synced.length > 1) {
        toast.show({
          tone: 'success',
          message: t('clock.offline.syncedMany', { count: result.synced.length }),
        })
      }

      for (const dropped of result.dropped) {
        const key =
          dropped.code === 'punch/already-open'
            ? 'clock.offline.droppedAlreadyOpen'
            : dropped.code === 'punch/no-open-punch'
              ? 'clock.offline.droppedNoOpenPunch'
              : 'clock.offline.droppedGeneric'
        toast.show({ tone: 'error', message: t(key) })
      }

      if (result.synced.length > 0 || result.dropped.length > 0) onSynced()
    } finally {
      syncing.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t])

  useEffect(() => {
    void runSync()
    window.addEventListener('online', runSync)
    return () => window.removeEventListener('online', runSync)
  }, [runSync])

  return { runSync }
}
