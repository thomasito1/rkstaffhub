import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/ui'
import { useAuth } from '@/lib/auth/AuthProvider'
import { getDisciplinaryLadder, listMyDisciplinaryActions, listViewableDisciplinaryActions } from '@/lib/db'
import { computeLadderPosition, type LadderActionLike } from '@/lib/hr/disciplinaryLadder'
import type { DisciplinaryLadder } from '@/types/models'

/**
 * Profile ladder widget — spec §12's own guardrail #5 ("Escalation ladder is
 * config: thresholds + EN/ES consequence copy in disciplinaryLadder, profile
 * widget computes from logged actions"). No dedicated mockup exists for this
 * exact widget (checked `.superdesign/export` and `.superdesign/pending`);
 * styled to match this app's existing profile-card vocabulary (bordered
 * `rounded-control` blocks, `text-chip`/`text-meta` type scale) rather than
 * mockup 31's full desktop ladder, which is the ADMIN screen's own widget for
 * a DIFFERENT (below-level) employee mid-issuance — this widget is compact,
 * for a profile page, and read-only.
 *
 * Deliberately self-contained: it fetches its own data and computes its own
 * position rather than asking each profile page to thread `actions`/`ladder`
 * through their own already-busy `load()` functions.
 *
 * `isSelf` decides the READ PATH, not just the label — see
 * `src/lib/db/disciplinaryActionsAdmin.ts`'s header for exactly why a
 * same-shape-looking `employeeId ==` query works for "my own record" but
 * fails outright for "someone else's below-level record" under
 * firestore.rules (a Firestore `list` is all-or-nothing; only a query
 * constrained by `employeeAccessRole` is provably safe for a non-self read).
 *
 * Renders NOTHING (not an empty state, not an error) when `enabled` is
 * false — the caller (`EmployeeProfilePage`) already computes "is this
 * viewer allowed to know this widget exists for this target at all" (below-
 * level AND `discipline.view`) and this component must never render a
 * restricted-but-visible shell for a peer/above target, matching this
 * app's own "never invite a doomed request" rule.
 */
export function DisciplineLadderWidget({
  employeeId,
  isSelf,
  enabled = true,
}: {
  employeeId: string
  isSelf: boolean
  enabled?: boolean
}): JSX.Element | null {
  const { t, i18n } = useTranslation()
  const { employee: viewer } = useAuth()
  const lang = i18n.language

  const [loading, setLoading] = useState(true)
  const [actions, setActions] = useState<LadderActionLike[]>([])
  const [ladder, setLadder] = useState<DisciplinaryLadder | null>(null)

  useEffect(() => {
    if (!enabled || employeeId === '') {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const [rawActions, ladderConfig] = await Promise.all([
          isSelf
            ? listMyDisciplinaryActions(employeeId)
            : listViewableDisciplinaryActions({ accessRole: viewer?.accessRole ?? 'staff' }).then((all) =>
                all.filter((a) => a.employeeId === employeeId),
              ),
          getDisciplinaryLadder(),
        ])
        if (cancelled) return
        setActions(rawActions.map((a) => ({ type: a.type, status: a.status })))
        setLadder(ladderConfig)
      } catch {
        if (!cancelled) {
          setActions([])
          setLadder(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [employeeId, isSelf, enabled, viewer?.accessRole])

  if (!enabled) return null

  if (loading) {
    return (
      <div className="space-y-3" role="status">
        <div className="h-4 w-40 animate-skeleton rounded bg-app" />
        <div className="h-16 animate-skeleton rounded-control bg-app" />
        <span className="sr-only">{t('app.loading')}</span>
      </div>
    )
  }

  const { actionCount, currentStep, nextStep } = computeLadderPosition(actions, ladder?.steps ?? [])

  if (ladder === null || ladder.steps.length === 0) {
    return (
      <EmptyState
        illustration="trades"
        title={t('people.discipline.emptyTitle')}
        body={t('people.discipline.noLadderConfigured')}
      />
    )
  }

  if (actionCount === 0) {
    return (
      <EmptyState
        illustration="trades"
        title={t('people.discipline.emptyTitle')}
        body={t('people.discipline.emptyBody')}
      />
    )
  }

  return (
    <div className="space-y-4">
      <p className="tabular text-meta text-ink">
        {t('people.discipline.actionsCount', { count: actionCount })}
      </p>

      <div className="rounded-control border border-line bg-app p-4">
        <p className="text-chip font-semibold uppercase tracking-wide text-ink-muted">
          {currentStep ? t('people.discipline.currentStepLabel') : t('people.discipline.belowFirstStep')}
        </p>
        {currentStep ? (
          <p className="mt-1 text-meta font-semibold text-ink">{t(`discipline.types.${currentStep.type}`)}</p>
        ) : null}
      </div>

      {nextStep ? (
        <div className="rounded-control border border-dashed border-line p-4">
          <p className="text-chip font-semibold uppercase tracking-wide text-ink-muted">
            {t('people.discipline.nextStepLabel')}
          </p>
          <p className="mt-1 text-meta text-ink">
            {lang.startsWith('es') ? nextStep.consequenceTextEs : nextStep.consequenceText}
          </p>
        </div>
      ) : (
        <p className="text-chip text-ink-muted">{t('people.discipline.topOfLadder')}</p>
      )}
    </div>
  )
}

export default DisciplineLadderWidget
