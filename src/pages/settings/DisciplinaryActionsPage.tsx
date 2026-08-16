import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { Avatar, Button, EmptyState, Modal, Pill, type PillTone, useToast } from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import { useAuth } from '@/lib/auth/AuthProvider'
import {
  getDisciplinaryLadder,
  getSignature,
  listCurrentPolicies,
  listEmployees,
  listShiftRoles,
  listViewableDisciplinaryActions,
} from '@/lib/db'
import { HrActionRejected, issueDisciplinaryAction, recordRefusedToSign } from '@/lib/hr/hrActions'
import { computeLadderPosition, type LadderStepLike } from '@/lib/hr/disciplinaryLadder'
import { disciplinaryActionErrorMessage } from '@/pages/hr/hrErrors'
import { InfoIcon } from '@/pages/hr/icons'
import { formatDate, RESTAURANT_TZ } from '@/lib/format'
import { displayName, roleLabel } from './shiftsAndTipsShared'
import type {
  DisciplinaryAction,
  DisciplinaryActionStatus,
  DisciplinaryActionType,
  DisciplinaryLadder,
  Employee,
  Policy,
  ShiftRole,
  Signature,
} from '@/types/models'

/**
 * Settings → Discipline — spec §4/§12/§17, Phase 4. The MOST sensitive data
 * class in this app (Rafa's ruling).
 *
 * SHAPE: "pick an employee, see their history" (mirrors `EmployeeListPage` →
 * profile drill-down), not a flat global feed — a flat feed would need an
 * unbounded `list` query firestore.rules cannot prove safe. Every read here
 * goes through `listViewableDisciplinaryActions` (`src/lib/db/
 * disciplinaryActionsAdmin.ts`), which pins the ONE query shape
 * `tests/rules/disciplinary.rules.test.ts` actually allows —
 * `where('employeeAccessRole', 'in', viewableDisciplineRoles(...))` — then
 * this screen filters that broad, role-bounded set down to one employee at a
 * time client-side.
 *
 * NO MOCKUP EXISTS for a bare "pick an employee" affordance (mockup 31
 * arrives with an employee already selected, and its own top nav/rail chrome
 * is the FULL standalone-mockup app shell this codebase's real
 * `SettingsShell` already supersedes — same adaptation `PolicyLibraryPage`
 * made for mockup 29). What IS replicated from mockup 31: the "you're
 * viewing below-level records" banner, the New disciplinary action form's
 * fields/layout, the ladder widget, and the recent-actions row treatment.
 *
 * TWO PATHS FOR AN ISSUED ACTION, one launched from here and one NOT:
 *   (a) Signing — `submitSignature('disciplinaryAction', ...)` (functions/
 *       src/signatures.ts) only succeeds when the CALLER is the action's own
 *       `employeeId`. An admin session can never complete it for someone
 *       else — that is enforced server-side, not a UI choice — so this
 *       screen shows "Awaiting the employee's own signature" rather than a
 *       button that would always fail. The real signing screen
 *       (`DisciplinarySignatureScreen`) lives on the employee's OWN profile.
 *   (b) Refused to sign — `recordRefusedToSign` — the manager/admin who was
 *       physically present for the refusal calls this themselves, witnessed.
 *       Fully wired here.
 *
 * MOCKUP CONFLICT NOTED (CLAUDE.md's conflict rule — flagging, not silently
 * deviating): mockup 31 puts "Refused to sign" as a TOGGLE inside the SAME
 * create form (so refusal is captured in one sitting) and has a "Save as
 * draft" text button. `issueDisciplinaryAction` always creates `status:
 * 'issued'` — there is no server-side "create as draft" path — so "Save as
 * draft" is omitted rather than wired to a callable that doesn't exist. The
 * refusal TOGGLE is kept (visual + one-sitting UX matches the mockup): under
 * the hood it chains `issueDisciplinaryAction` then immediately
 * `recordRefusedToSign`, since the backend genuinely models these as two
 * separate, both-audited mutations.
 */

const ACTION_TYPES: DisciplinaryActionType[] = [
  'verbal-warning',
  'written-warning',
  'writeup',
  'final-warning',
  'suspension',
  'termination-note',
]

const STATUS_TONE: Record<DisciplinaryActionStatus, PillTone> = {
  draft: 'draft',
  issued: 'pending',
  signed: 'approved',
  'refused-to-sign': 'declined',
}

const NARRATIVE_MAX = 2000

function todayIsoRestaurant(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: RESTAURANT_TZ }).format(new Date())
}

function isoDateToDisplay(iso: string, lang: string): string {
  if (!iso) return '—'
  return formatDate(new Date(`${iso}T00:00:00`), { dateStyle: 'medium' }, lang)
}

export function DisciplinaryActionsPage(): JSX.Element {
  return (
    <RequirePermission permission="discipline.view">
      <DisciplinaryActionsScreen />
    </RequirePermission>
  )
}

function DisciplinaryActionsScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()
  const { employee: viewer, can, canAccess } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [roleCatalog, setRoleCatalog] = useState<ShiftRole[]>([])
  const [policies, setPolicies] = useState<Policy[]>([])
  const [allActions, setAllActions] = useState<DisciplinaryAction[]>([])
  const [ladder, setLadder] = useState<DisciplinaryLadder | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(
    () => searchParams.get('employeeId'),
  )
  const [search, setSearch] = useState('')
  const [refuseTarget, setRefuseTarget] = useState<DisciplinaryAction | null>(null)
  const [signatureById, setSignatureById] = useState<Map<string, Signature>>(new Map())

  const canIssue = can('discipline.issue')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const [people, roles, pols, actions, ladderConfig] = await Promise.all([
        listEmployees({ status: 'active' }),
        listShiftRoles(),
        listCurrentPolicies(),
        listViewableDisciplinaryActions({ accessRole: viewer?.accessRole ?? 'staff' }),
        getDisciplinaryLadder(),
      ])
      setEmployees(people)
      setRoleCatalog(roles)
      setPolicies(pols)
      setAllActions(actions)
      setLadder(ladderConfig)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [viewer?.accessRole])

  useEffect(() => {
    void load()
  }, [load])

  const roleMap = useMemo(() => new Map(roleCatalog.map((r) => [r.id, r])), [roleCatalog])

  const belowLevelEmployees = useMemo(
    () =>
      employees
        .filter((e) => e.id !== viewer?.id && canAccess({ id: e.id, accessRole: e.accessRole }))
        .sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [employees, canAccess, viewer?.id],
  )

  const visibleEmployees = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (needle === '') return belowLevelEmployees
    return belowLevelEmployees.filter((e) =>
      [displayName(e), e.employeeNumber].join(' ').toLowerCase().includes(needle),
    )
  }, [belowLevelEmployees, search])

  const selectedEmployee = belowLevelEmployees.find((e) => e.id === selectedEmployeeId) ?? null

  const selectedEmployeeActions = useMemo(
    () =>
      selectedEmployeeId
        ? allActions.filter((a) => a.employeeId === selectedEmployeeId).sort((a, b) => b.date.localeCompare(a.date))
        : [],
    [allActions, selectedEmployeeId],
  )

  // Signed actions carry their PDF/email tracking on the SIGNATURE doc, not
  // on the DisciplinaryAction doc itself (models.ts's own note on
  // `DisciplinaryAction.pdfStoragePath` — that field is refusal-only). Fetch
  // the handful for the currently-selected employee only.
  useEffect(() => {
    const signedIds = selectedEmployeeActions
      .filter((a) => a.status === 'signed' && a.signatureId)
      .map((a) => a.signatureId as string)
    if (signedIds.length === 0) {
      setSignatureById(new Map())
      return
    }
    let cancelled = false
    void Promise.all(signedIds.map((id) => getSignature(id))).then((sigs) => {
      if (cancelled) return
      const next = new Map<string, Signature>()
      sigs.forEach((s) => {
        if (s) next.set(s.id, s)
      })
      setSignatureById(next)
    })
    return () => {
      cancelled = true
    }
  }, [selectedEmployeeActions])

  const ladderPosition = useMemo(
    () =>
      computeLadderPosition(
        selectedEmployeeActions.map((a) => ({ type: a.type, status: a.status })),
        ladder?.steps ?? [],
      ),
    [selectedEmployeeActions, ladder],
  )

  function selectEmployee(id: string): void {
    setSelectedEmployeeId(id)
    const next = new URLSearchParams(searchParams)
    next.set('employeeId', id)
    setSearchParams(next, { replace: true })
  }

  async function handleRefuse(action: DisciplinaryAction, witnessEmployeeId: string): Promise<void> {
    try {
      await recordRefusedToSign(action.id, witnessEmployeeId)
      toast.show({ tone: 'success', message: t('settings.discipline.toast.refused') })
      setRefuseTarget(null)
      await load()
    } catch (err) {
      toast.show({ tone: 'error', message: disciplinaryActionErrorMessage(t, err) })
    }
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6">
        <h1 className="text-title-lg font-semibold tracking-tight text-ink">{t('settings.discipline.title')}</h1>
        <p className="mt-0.5 text-meta text-ink-muted">{t('settings.discipline.subtitle')}</p>
      </div>

      <div className="mb-6 flex items-center gap-3 rounded-card border border-line bg-page p-3">
        <InfoIcon className="h-4 w-4 shrink-0 text-ink-muted" />
        <span className="text-chip text-ink-muted">{t('settings.discipline.viewingNotice')}</span>
      </div>

      {loadError ? (
        <EmptyState
          illustration="search"
          title={t('settings.discipline.errorTitle')}
          body={t('settings.discipline.errorBody')}
          action={<Button onClick={() => void load()}>{t('common.retry')}</Button>}
        />
      ) : (
        <div className="grid grid-cols-12 items-start gap-6">
          <div className="col-span-12 lg:col-span-3">
            <EmployeePickerList
              employees={visibleEmployees}
              roleMap={roleMap}
              lang={lang}
              selectedId={selectedEmployeeId}
              onSelect={selectEmployee}
              search={search}
              onSearch={setSearch}
              loading={loading}
            />
          </div>

          <div className="col-span-12 lg:col-span-9">
            {!selectedEmployee ? (
              <EmptyState
                illustration="search"
                title={t('settings.discipline.emptySelectionTitle')}
                body={t('settings.discipline.emptySelectionBody')}
              />
            ) : (
              <div className="grid grid-cols-12 items-start gap-6">
                {canIssue ? (
                  <div className="col-span-12 lg:col-span-7">
                    <IssueActionForm
                      key={selectedEmployee.id}
                      employee={selectedEmployee}
                      roleMap={roleMap}
                      lang={lang}
                      policies={policies}
                      witnessCandidates={employees.filter((e) => e.id !== selectedEmployee.id)}
                      priorCount={ladderPosition.actionCount}
                      onIssued={() => void load()}
                    />
                  </div>
                ) : null}

                <div className={canIssue ? 'col-span-12 flex flex-col gap-6 lg:col-span-5' : 'col-span-12 flex flex-col gap-6'}>
                  <section className="rounded-card border border-line bg-page">
                    <div className="border-b border-line p-4">
                      <h3 className="text-section font-semibold text-ink">
                        {t('settings.discipline.ladder.title', { name: displayName(selectedEmployee) })}
                      </h3>
                      <p className="mt-0.5 text-chip text-ink-muted">{t('settings.discipline.ladder.subtitle')}</p>
                    </div>
                    <div className="p-4">
                      <LadderSummary steps={ladder?.steps ?? []} position={ladderPosition} lang={lang} t={t} />
                    </div>
                  </section>

                  <section className="rounded-card border border-line bg-page">
                    <div className="border-b border-line p-4">
                      <h3 className="text-section font-semibold text-ink">{t('settings.discipline.history.title')}</h3>
                    </div>
                    {selectedEmployeeActions.length === 0 ? (
                      <p className="p-4 text-meta text-ink-muted">{t('settings.discipline.history.empty')}</p>
                    ) : (
                      <div className="flex flex-col">
                        {selectedEmployeeActions.map((action, idx) => (
                          <HistoryRow
                            key={action.id}
                            action={action}
                            signature={action.signatureId ? signatureById.get(action.signatureId) ?? null : null}
                            lang={lang}
                            bordered={idx > 0}
                            canIssue={canIssue}
                            onRefuse={() => setRefuseTarget(action)}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {refuseTarget ? (
        <RefuseToSignModal
          action={refuseTarget}
          employeeName={selectedEmployee ? displayName(selectedEmployee) : ''}
          witnessCandidates={employees.filter((e) => e.id !== refuseTarget.employeeId)}
          onClose={() => setRefuseTarget(null)}
          onConfirm={(witnessId) => void handleRefuse(refuseTarget, witnessId)}
        />
      ) : null}
    </div>
  )
}

// ── employee picker (left column) ───────────────────────────────────────────

function EmployeePickerList({
  employees,
  roleMap,
  lang,
  selectedId,
  onSelect,
  search,
  onSearch,
  loading,
}: {
  employees: Employee[]
  roleMap: Map<string, ShiftRole>
  lang: string
  selectedId: string | null
  onSelect: (id: string) => void
  search: string
  onSearch: (value: string) => void
  loading: boolean
}): JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="rounded-card border border-line bg-page">
      <div className="border-b border-line p-3">
        <input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t('settings.discipline.searchEmployeesPlaceholder')}
          aria-label={t('settings.discipline.searchEmployeesPlaceholder')}
          className="h-9 w-full rounded-control border border-line bg-page px-3 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      {loading ? (
        <div className="flex flex-col gap-1 p-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-skeleton rounded-lg bg-app" />
          ))}
        </div>
      ) : employees.length === 0 ? (
        <p className="p-4 text-chip text-ink-muted">{t('settings.discipline.noBelowLevelEmployees')}</p>
      ) : (
        <ul className="max-h-[600px] overflow-y-auto p-1">
          {employees.map((e) => {
            const label = roleLabel(e, roleMap, lang, (level) => t('people.levelShort', { level }))
            const selected = e.id === selectedId
            return (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => onSelect(e.id)}
                  aria-current={selected ? 'true' : undefined}
                  className={[
                    'flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors duration-hover',
                    selected ? 'bg-primary-tint' : 'hover:bg-app',
                  ].join(' ')}
                >
                  <Avatar firstName={e.firstName} lastName={e.lastName} photoUrl={e.photoUrl} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-meta font-semibold text-ink">{displayName(e)}</span>
                    <span className="block truncate text-chip text-ink-muted">{label || t(`employmentTypes.${e.employmentType}`)}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ── ladder summary (right column, top) ──────────────────────────────────────

function LadderSummary({
  steps,
  position,
  lang,
  t,
}: {
  steps: LadderStepLike[]
  position: ReturnType<typeof computeLadderPosition>
  lang: string
  t: (key: string, opts?: Record<string, unknown>) => string
}): JSX.Element {
  if (steps.length === 0) {
    return <p className="text-meta text-ink-muted">{t('settings.discipline.ladder.empty')}</p>
  }
  if (position.actionCount === 0) {
    return <p className="text-meta text-ink-muted">{t('settings.discipline.ladder.noActions')}</p>
  }

  return (
    <div className="space-y-4">
      <p className="tabular text-meta text-ink">
        {t('people.discipline.actionsCount', { count: position.actionCount })}
      </p>
      <div className="rounded-control border border-line bg-app p-3">
        <p className="text-chip font-semibold uppercase tracking-wide text-ink-muted">
          {position.currentStep ? t('settings.discipline.ladder.atStep') : t('settings.discipline.ladder.belowFirstStep')}
        </p>
        {position.currentStep ? (
          <p className="mt-1 text-meta font-semibold text-ink">{t(`discipline.types.${position.currentStep.type}`)}</p>
        ) : null}
      </div>
      {position.nextStep ? (
        <div className="rounded-control border border-dashed border-line p-3">
          <p className="text-chip font-semibold uppercase tracking-wide text-ink-muted">{t('settings.discipline.ladder.nextStep')}</p>
          <p className="mt-1 text-meta text-ink">
            {lang.startsWith('es') ? position.nextStep.consequenceTextEs : position.nextStep.consequenceText}
          </p>
        </div>
      ) : (
        <p className="text-chip text-ink-muted">{t('settings.discipline.ladder.topOfLadder')}</p>
      )}
    </div>
  )
}

// ── history row (right column, bottom) ──────────────────────────────────────

function HistoryRow({
  action,
  signature,
  lang,
  bordered,
  canIssue,
  onRefuse,
}: {
  action: DisciplinaryAction
  signature: Signature | null
  lang: string
  bordered: boolean
  canIssue: boolean
  onRefuse: () => void
}): JSX.Element {
  const { t } = useTranslation()

  const emailInfo =
    action.status === 'refused-to-sign'
      ? { emailedTo: action.emailedTo, emailPending: action.emailPending }
      : action.status === 'signed' && signature
        ? { emailedTo: signature.emailedTo, emailPending: signature.emailPending }
        : null

  return (
    <div className={['p-4', bordered ? 'border-t border-line' : ''].filter(Boolean).join(' ')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-meta font-semibold text-ink">{t(`discipline.types.${action.type}`)}</p>
          <p className="tabular text-chip text-ink-muted">{isoDateToDisplay(action.date, lang)}</p>
        </div>
        <Pill tone={STATUS_TONE[action.status]}>{t(`discipline.status.${action.status}`)}</Pill>
      </div>

      {action.status === 'issued' ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-chip text-ink-muted">{t('settings.discipline.history.awaitingSignature')}</p>
          {canIssue ? (
            <Button onClick={onRefuse}>{t('settings.discipline.history.recordRefusal')}</Button>
          ) : null}
        </div>
      ) : null}

      {emailInfo ? (
        <p className="mt-2 text-chip text-ink-muted">
          {emailInfo.emailedTo
            ? t('settings.discipline.history.emailedTo', { email: emailInfo.emailedTo })
            : emailInfo.emailPending
              ? t('settings.discipline.history.emailPendingNotice')
              : null}
        </p>
      ) : null}
    </div>
  )
}

// ── issue new action form ───────────────────────────────────────────────────

function IssueActionForm({
  employee,
  roleMap,
  lang,
  policies,
  witnessCandidates,
  priorCount,
  onIssued,
}: {
  employee: Employee
  roleMap: Map<string, ShiftRole>
  lang: string
  policies: Policy[]
  witnessCandidates: Employee[]
  priorCount: number
  onIssued: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const fieldId = useId()

  const [type, setType] = useState<DisciplinaryActionType | null>(null)
  const [date, setDate] = useState(todayIsoRestaurant())
  const [policyRefs, setPolicyRefs] = useState<string[]>([])
  const [narrative, setNarrative] = useState('')
  const [refused, setRefused] = useState(false)
  const [witnessEmployeeId, setWitnessEmployeeId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const roleLine = roleLabel(employee, roleMap, lang, (level) => t('people.levelShort', { level }))

  function resetForm(): void {
    setType(null)
    setDate(todayIsoRestaurant())
    setPolicyRefs([])
    setNarrative('')
    setRefused(false)
    setWitnessEmployeeId('')
    setError(null)
  }

  function togglePolicy(id: string): void {
    setPolicyRefs((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]))
  }

  async function handleSubmit(): Promise<void> {
    setError(null)
    if (!type) {
      setError(t('settings.discipline.form.errors.typeRequired'))
      return
    }
    if (!date) {
      setError(t('settings.discipline.form.errors.dateRequired'))
      return
    }
    if (narrative.trim() === '') {
      setError(t('settings.discipline.form.errors.narrativeRequired'))
      return
    }
    if (refused && witnessEmployeeId === '') {
      setError(t('settings.discipline.form.errors.witnessRequired'))
      return
    }

    setSaving(true)
    try {
      const { actionId } = await issueDisciplinaryAction({
        employeeId: employee.id,
        type,
        date,
        policyRefs,
        narrative: narrative.trim(),
      })
      if (refused) {
        await recordRefusedToSign(actionId, witnessEmployeeId)
        toast.show({ tone: 'success', message: t('settings.discipline.toast.refused') })
      } else {
        toast.show({ tone: 'success', message: t('settings.discipline.toast.issued') })
      }
      resetForm()
      onIssued()
    } catch (err) {
      if (err instanceof HrActionRejected) {
        setError(disciplinaryActionErrorMessage(t, err))
      } else {
        setError(t('hr.sign.error.generic'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-card border border-line bg-page">
      <div className="border-b border-line p-6">
        <h2 className="text-section font-semibold text-ink">{t('settings.discipline.form.title')}</h2>
      </div>

      <div className="flex flex-col gap-6 p-6">
        <div>
          <p className="mb-2 text-chip font-medium text-ink-muted">{t('settings.discipline.form.employeeLabel')}</p>
          <div className="flex items-center gap-3 rounded-control border border-line bg-app p-3">
            <Avatar firstName={employee.firstName} lastName={employee.lastName} photoUrl={employee.photoUrl} size={28} />
            <div>
              <p className="text-meta font-semibold text-ink">{displayName(employee)}</p>
              <p className="text-chip text-ink-muted">{roleLine}</p>
            </div>
          </div>
          {priorCount > 0 ? (
            <p className="mt-2 text-chip text-ink-muted">
              {t('settings.discipline.form.priorCountNote', { count: priorCount, name: displayName(employee) })}
            </p>
          ) : null}
        </div>

        <div>
          <p className="mb-2 text-chip font-medium text-ink-muted">{t('settings.discipline.form.typeLabel')}</p>
          <div className="flex flex-wrap gap-2">
            {ACTION_TYPES.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setType(v)}
                aria-pressed={type === v}
                className={[
                  'h-10 rounded-lg border px-4 text-chip font-semibold transition-colors duration-hover',
                  type === v ? 'border-primary bg-primary text-white' : 'border-line bg-page text-ink hover:bg-app',
                ].join(' ')}
              >
                {t(`discipline.types.${v}`)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label htmlFor={`${fieldId}-date`} className="mb-2 block text-chip font-medium text-ink-muted">
            {t('settings.discipline.form.dateLabel')}
          </label>
          <input
            id={`${fieldId}-date`}
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="tabular h-10 w-full rounded-control border border-line bg-page px-3 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {policies.length > 0 ? (
          <div>
            <p className="mb-2 text-chip font-medium text-ink-muted">{t('settings.discipline.form.policyRefsLabel')}</p>
            <div className="flex min-h-[42px] flex-wrap gap-2 rounded-control border border-line bg-page p-2">
              {policyRefs.map((id) => {
                const policy = policies.find((p) => p.id === id)
                if (!policy) return null
                return (
                  <span key={id} className="inline-flex items-center gap-1.5 rounded bg-app px-2 py-1 text-chip font-medium text-ink">
                    {lang.startsWith('es') && policy.titleEs ? policy.titleEs : policy.title}
                    <button type="button" onClick={() => togglePolicy(id)} aria-label={t('common.remove')} className="text-ink-muted hover:text-ink">
                      ×
                    </button>
                  </span>
                )
              })}
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) togglePolicy(e.target.value)
                }}
                aria-label={t('settings.discipline.form.addPolicy')}
                className="h-7 rounded border-none bg-transparent text-chip font-semibold text-primary focus:outline-none"
              >
                <option value="">{t('settings.discipline.form.addPolicy')}</option>
                {policies
                  .filter((p) => !policyRefs.includes(p.id))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {lang.startsWith('es') && p.titleEs ? p.titleEs : p.title}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        ) : null}

        <div>
          <label htmlFor={`${fieldId}-narrative`} className="mb-2 block text-chip font-medium text-ink-muted">
            {t('settings.discipline.form.narrativeLabel')}
          </label>
          <textarea
            id={`${fieldId}-narrative`}
            rows={6}
            maxLength={NARRATIVE_MAX}
            value={narrative}
            onChange={(e) => setNarrative(e.target.value)}
            className="w-full rounded-control border border-line bg-page p-3 text-meta leading-relaxed text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <p className="tabular mt-1 text-right text-chip text-ink-muted">
            {t('settings.discipline.form.narrativeCount', { count: narrative.length, max: NARRATIVE_MAX })}
          </p>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-line pt-4">
          <div>
            <p className="text-meta font-medium text-ink">{t('settings.discipline.form.refusedToggleTitle')}</p>
            <p className="text-chip text-ink-muted">{t('settings.discipline.form.refusedToggleBody')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={refused}
            onClick={() => setRefused((v) => !v)}
            className={[
              'relative h-6 w-10 shrink-0 rounded-full transition-colors duration-hover',
              refused ? 'bg-primary' : 'bg-gray-100 ring-1 ring-inset ring-line',
            ].join(' ')}
          >
            <span
              className={[
                'absolute top-0.5 h-5 w-5 rounded-full bg-page shadow transition-transform duration-hover',
                refused ? 'translate-x-4' : 'translate-x-0.5',
              ].join(' ')}
            />
          </button>
        </div>

        {refused ? (
          <div>
            <label htmlFor={`${fieldId}-witness`} className="mb-2 block text-chip font-medium text-ink-muted">
              {t('settings.discipline.form.witnessLabel')}
            </label>
            <select
              id={`${fieldId}-witness`}
              value={witnessEmployeeId}
              onChange={(e) => setWitnessEmployeeId(e.target.value)}
              className="h-10 w-full rounded-control border border-line bg-page px-3 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">{t('settings.discipline.form.witnessPlaceholder')}</option>
              {witnessCandidates.map((w) => (
                <option key={w.id} value={w.id}>
                  {displayName(w)}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {error ? <p className="text-chip font-medium text-danger">{error}</p> : null}
      </div>

      <div className="flex items-center justify-end gap-3 border-t border-line p-6">
        <Button onClick={resetForm} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={() => void handleSubmit()} disabled={saving}>
          {saving
            ? t('settings.discipline.form.submitting')
            : refused
              ? t('settings.discipline.form.submitRefused')
              : t('settings.discipline.form.submit')}
        </Button>
      </div>
    </section>
  )
}

// ── refuse-to-sign modal (from an existing issued action's history row) ────

function RefuseToSignModal({
  action,
  employeeName,
  witnessCandidates,
  onClose,
  onConfirm,
}: {
  action: DisciplinaryAction
  employeeName: string
  witnessCandidates: Employee[]
  onClose: () => void
  onConfirm: (witnessEmployeeId: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const [witnessEmployeeId, setWitnessEmployeeId] = useState('')
  const [error, setError] = useState<string | null>(null)

  function confirm(): void {
    if (witnessEmployeeId === '') {
      setError(t('settings.discipline.form.errors.witnessRequired'))
      return
    }
    onConfirm(witnessEmployeeId)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('settings.discipline.refuseModal.title')}
      subtitle={t('settings.discipline.refuseModal.body', { name: employeeName, type: t(`discipline.types.${action.type}`) })}
      footer={
        <>
          <Button onClick={onClose}>{t('settings.discipline.refuseModal.cancel')}</Button>
          <Button variant="primary" onClick={confirm}>
            {t('settings.discipline.refuseModal.confirm')}
          </Button>
        </>
      }
    >
      <label htmlFor="refuse-witness" className="mb-1 block text-chip font-medium text-ink-muted">
        {t('settings.discipline.refuseModal.witnessLabel')}
      </label>
      <select
        id="refuse-witness"
        value={witnessEmployeeId}
        onChange={(e) => setWitnessEmployeeId(e.target.value)}
        className="h-10 w-full rounded-control border border-line bg-page px-3 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      >
        <option value="">{t('settings.discipline.form.witnessPlaceholder')}</option>
        {witnessCandidates.map((w) => (
          <option key={w.id} value={w.id}>
            {displayName(w)}
          </option>
        ))}
      </select>
      {error ? <p className="mt-2 text-chip font-medium text-danger">{error}</p> : null}
    </Modal>
  )
}

export default DisciplinaryActionsPage
