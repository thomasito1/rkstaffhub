import { useCallback, useEffect, useState } from 'react'

import { listMyTaskInstances, subscribeAppSettings } from '@/lib/db'
import type { AppSettings, Employee, TaskInstance } from '@/types/models'

/**
 * "My Tasks" (spec §10, mockup 27): every instance ever assigned to me plus
 * unclaimed pool instances in my department (`listMyTaskInstances`), and the
 * live app settings — needed only for `featureFlags.taskPhotoProof`, which
 * gates the whole photo-proof mechanic globally regardless of the
 * per-instance `requiresPhoto` flag.
 */
export function useMyTasksData(employee: Employee | null) {
  const [instances, setInstances] = useState<TaskInstance[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [loading, setLoading] = useState(true)

  // Live settings — an admin flipping taskPhotoProof must take effect without a reload.
  useEffect(() => {
    return subscribeAppSettings(setSettings)
  }, [])

  const reload = useCallback(async () => {
    if (!employee) return
    setLoading(true)
    try {
      setInstances(await listMyTaskInstances(employee.id, employee.department))
    } finally {
      setLoading(false)
    }
  }, [employee])

  useEffect(() => {
    void reload()
  }, [reload])

  return { instances, settings, loading, reload }
}
