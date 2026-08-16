import { useEffect, useState } from 'react'

import { listMyTaskInstances } from '@/lib/db'
import type { Employee } from '@/types/models'

/**
 * Real Tasks nav badge (spec §19 Phase 3 — see `AppShell.tsx`'s own comment
 * on why the old hardcoded `DEMO_BADGES` const is gone). Counts `status ===
 * 'open'` across everything `listMyTaskInstances` returns (mine + unclaimed
 * pool in my department), same scope "My Tasks" itself shows.
 */
export function useMyOpenTaskCount(employee: Employee | null): number {
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!employee) {
      setCount(0)
      return
    }
    let cancelled = false
    void listMyTaskInstances(employee.id, employee.department)
      .then((instances) => {
        if (!cancelled) setCount(instances.filter((i) => i.status === 'open').length)
      })
      .catch(() => {
        // Best-effort — a nav badge is never worth surfacing an error over.
      })
    return () => {
      cancelled = true
    }
  }, [employee])

  return count
}
