import { useCallback, useEffect, useState } from 'react'

import { listCurrentPolicies, listMySignatures } from '@/lib/db'
import type { Employee, Policy, Signature } from '@/types/models'

/**
 * HR hub (spec §12, Phase 4): the current version of every policy the
 * signed-in employee can read, plus every signature they have ever
 * submitted — the list screen cross-references the two (via
 * `findSignatureForTarget`, `src/lib/db/signatures.ts`) to decide "signed",
 * "needs signature", or "needs re-signing" (a signature bound to an older
 * `policyVersion` than the current one) per policy. Same shape as
 * `pages/tasks/useMyTasksData.ts`.
 */
export function useHrHubData(employee: Employee | null) {
  const [policies, setPolicies] = useState<Policy[]>([])
  const [signatures, setSignatures] = useState<Signature[]>([])
  const [loading, setLoading] = useState(true)

  // Returns the freshly fetched pair too — a caller that needs the up-to-date
  // list RIGHT AFTER an await (e.g. computing "still needs signature" the
  // instant a signature is submitted) cannot rely on `signatures`/`policies`
  // from this closure, since the state update those setters schedule isn't
  // visible until the next render.
  const reload = useCallback(async () => {
    if (!employee) return { policies: [] as Policy[], signatures: [] as Signature[] }
    setLoading(true)
    try {
      const [pols, sigs] = await Promise.all([listCurrentPolicies(), listMySignatures(employee.id)])
      setPolicies(pols)
      setSignatures(sigs)
      return { policies: pols, signatures: sigs }
    } finally {
      setLoading(false)
    }
  }, [employee])

  useEffect(() => {
    void reload()
  }, [reload])

  return { policies, signatures, loading, reload }
}
