import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import {
  Avatar,
  Button,
  EmptyState,
  Modal,
  Pill,
  useToast,
} from '@/components/ui'
import { Can } from '@/components/guards/RouteGuards'
import { useAuth } from '@/lib/auth/AuthProvider'
import {
  archiveEmployee,
  getEmployee,
  getEmployeeAdmin,
  getEmployeeCompensation,
  listShiftRoles,
  updateEmployee,
  type EmployeeAdmin,
  type EmployeeCompensation,
} from '@/lib/db'
import { formatDate } from '@/lib/format'
import type {
  Employee,
  EmployeeShiftRole,
  EmployeeStatus,
  EmploymentType,
  PermissionKey,
  ShiftRole,
} from '@/types/models'

import { DisciplineLadderWidget } from './components/DisciplineLadderWidget'
import { PermissionOverridesEditor } from './components/PermissionOverridesEditor'
import { ShiftRoleChips, ShiftRolesEditor } from './components/ShiftRolesEditor'

/**
 * Admin view of one employee — mockup 04.
 *
 * ─── THE BELOW-LEVEL RULE (spec §4) ─────────────────────────────────────────
 *
 * `getEmployeeCompensation()` and `getEmployeeAdmin()` return `null` for BOTH
 * "the document is not there" and "the rules refused you". They are
 * indistinguishable by design — a denial must not be a side channel that tells
 * you a rate exists.
 *
 * So `null` is never rendered as data. It is never `$0`, never "—", never an
 * empty editable input. It renders a restricted notice that says which rule
 * stopped you. Concretely:
 *
 *   pay section      shown only when `can('employees.editPay') && canAccess(target)`
 *   admin section    shown only when `canAccess(target)`   (scheduling notes)
 *   overrides editor shown only when `can('permissions.manage')`
 *
 * `canAccess` implements "strictly below your level": a Manager opening another
 * Manager sees the profile, the roles and the employment basics, but the pay
 * card and the scheduling-notes card are restricted notices. EQUAL RANK FAILS.
 * Owners bypass. Everyone always passes for themselves.
 *
 * The private documents are re-read here (rather than trusting the assembled
 * values from `getEmployee`) ONLY on the permitted path, so that a server-side
 * denial the client did not predict still lands on the restricted notice
 * instead of silently rendering "no rate on file". Two extra document reads on
 * one screen for one person; the roster deliberately pays no such cost.
 *
 * SECURITY: none of this authorizes anything. firestore.rules is the boundary.
 */

type Gated<T> =
  | { state: 'visible'; value: T }
  /** Blocked before we asked — the viewer lacks the permission key. */
  | { state: 'no-permission' }
  /** Blocked before we asked — the target is at or above the viewer's rank. */
  | { state: 'below-level' }
  /** We asked and got `null`: absent, or refused by the rules. Do not guess. */
  | { state: 'unavailable' }

type TabId = 'details' | 'schedule' | 'punches' | 'documents' | 'disciplinary'

const LATER_PHASE: Record<Exclude<TabId, 'details'>, number> = {
  schedule: 1,
  punches: 2,
  documents: 4,
  disciplinary: 4,
}

const EMPLOYMENT_TYPES: readonly EmploymentType[] = [
  'hourly-tipped',
  'hourly',
  'salaried-weekly',
  'salaried-monthly',
  'non-clocking',
] as const

const STATUSES: readonly EmployeeStatus[] = [
  'active',
  'pending',
  'inactive',
  'archived',
] as const

function isSalaried(type: EmploymentType): boolean {
  return type === 'salaried-weekly' || type === 'salaried-monthly'
}

function statusTone(status: EmployeeStatus): 'approved' | 'pending' | 'neutral' | 'draft' {
  if (status === 'active') return 'approved'
  if (status === 'pending') return 'pending'
  if (status === 'inactive') return 'neutral'
  return 'draft'
}

/** "2025-03-04" → a locale-formatted date. Empty and malformed values render blank. */
function formatIsoDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(`${iso}T00:00:00`)
  return Number.isNaN(date.getTime()) ? '' : formatDate(date)
}

function moneyToNumber(raw: string): number | null | 'invalid' {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  const n = Number(trimmed.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n) || n < 0) return 'invalid'
  return n
}

// ── small local primitives (mockup 04) ───────────────────────────────────────

function Card({ children }: { children: ReactNode }): JSX.Element {
  return <section className="rounded-card border border-line bg-page">{children}</section>
}

function CardHeader({
  title,
  badge,
}: {
  title: string
  badge?: string
}): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line p-6">
      <h2 className="text-section font-semibold text-ink">{title}</h2>
      {badge ? (
        <span className="rounded bg-gray-100 px-2 py-0.5 text-micro font-bold uppercase text-ink-muted">
          {badge}
        </span>
      ) : null}
    </div>
  )
}

function Field({
  label,
  value,
  numeric = false,
}: {
  label: string
  value: string
  numeric?: boolean
}): JSX.Element {
  return (
    <div>
      <p className="mb-1 text-chip font-medium text-ink-muted">{label}</p>
      <p className={['text-meta text-ink', numeric ? 'tabular' : ''].filter(Boolean).join(' ')}>
        {value === '' ? '—' : value}
      </p>
    </div>
  )
}

function LockIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="mt-0.5 h-5 w-5 shrink-0 text-ink-muted"
      aria-hidden="true"
    >
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

/**
 * The ONLY thing rendered where a restricted value would otherwise go. Never a
 * zero, never a blank input — the reader must be able to tell "hidden from you"
 * apart from "not recorded".
 */
function RestrictedNotice({
  title,
  body,
}: {
  title: string
  body: string
}): JSX.Element {
  return (
    <div className="flex gap-3 rounded-control border border-line bg-app p-4">
      <LockIcon />
      <div>
        <p className="text-meta font-semibold text-ink">{title}</p>
        <p className="mt-0.5 text-chip text-ink-muted">{body}</p>
      </div>
    </div>
  )
}

function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}): JSX.Element {
  const labelId = useId()
  const descriptionId = useId()

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex min-w-0 flex-col">
        <span id={labelId} className="text-meta font-medium text-ink">
          {label}
        </span>
        {description ? (
          <p id={descriptionId} className="text-chip text-ink-muted">
            {description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={[
          'relative flex h-6 w-10 shrink-0 items-center rounded-full px-1',
          'transition-colors duration-hover disabled:cursor-not-allowed disabled:opacity-40',
          checked ? 'bg-primary' : 'bg-gray-100 ring-1 ring-inset ring-line',
        ].join(' ')}
      >
        <span
          aria-hidden="true"
          className={[
            'h-4 w-4 rounded-full bg-page shadow transition-transform duration-hover',
            checked ? 'translate-x-4' : 'translate-x-0',
            checked ? '' : 'ring-1 ring-line',
          ]
            .filter(Boolean)
            .join(' ')}
        />
      </button>
    </div>
  )
}

// ── draft ────────────────────────────────────────────────────────────────────

interface Draft {
  employmentType: EmploymentType
  status: EmployeeStatus
  clockRequired: boolean
  tipsRequired: boolean
  shiftRoles: EmployeeShiftRole[]
  hourlyRate: string
  salaryAmount: string
  salaryPeriod: 'weekly' | 'monthly' | null
  schedulingNotes: string
  permissionOverrides: Partial<Record<PermissionKey, boolean>>
}

function draftFrom(
  employee: Employee,
  compensation: EmployeeCompensation | null,
  admin: EmployeeAdmin | null,
): Draft {
  return {
    employmentType: employee.employmentType,
    status: employee.status,
    clockRequired: employee.clockRequired,
    tipsRequired: employee.tipsRequired,
    shiftRoles: employee.shiftRoles.map((r) => ({ ...r })),
    hourlyRate: compensation?.hourlyRate == null ? '' : String(compensation.hourlyRate),
    salaryAmount:
      compensation?.salaryAmount == null ? '' : String(compensation.salaryAmount),
    salaryPeriod: compensation?.salaryPeriod ?? null,
    schedulingNotes: admin?.schedulingNotes ?? '',
    permissionOverrides: { ...(admin?.permissionOverrides ?? {}) },
  }
}

// ── page ─────────────────────────────────────────────────────────────────────

export interface EmployeeProfilePageProps {
  /** Falls back to the `:employeeId` / `:id` route param. */
  employeeId?: string
  basePath?: string
}

export function EmployeeProfilePage({
  employeeId,
  basePath = '/people',
}: EmployeeProfilePageProps): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const toast = useToast()
  const { can, canAccess, roleDefaults } = useAuth()
  const params = useParams()
  const rateFieldId = useId()

  const id = employeeId ?? params.employeeId ?? params.id ?? ''

  const [employee, setEmployee] = useState<Employee | null>(null)
  const [catalog, setCatalog] = useState<ShiftRole[]>([])
  const [compensation, setCompensation] = useState<Gated<EmployeeCompensation>>({
    state: 'unavailable',
  })
  const [admin, setAdmin] = useState<Gated<EmployeeAdmin>>({ state: 'unavailable' })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [baseline, setBaseline] = useState<Draft | null>(null)

  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [saving, setSaving] = useState(false)
  const [rateError, setRateError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabId>('details')
  const [archiveOpen, setArchiveOpen] = useState(false)

  const load = useCallback(async () => {
    if (id === '') {
      setNotFound(true)
      setLoading(false)
      return
    }

    setLoading(true)
    setNotFound(false)

    let record: Employee | null = null
    try {
      const [loaded, roles] = await Promise.all([getEmployee(id), listShiftRoles()])
      record = loaded
      setCatalog(roles)
    } catch {
      // A failed profile read is not a permission story — the profile document
      // is readable by every signed-in employee. Treat it as "not there".
      setEmployee(null)
      setNotFound(true)
      setLoading(false)
      return
    }

    if (!record) {
      setEmployee(null)
      setNotFound(true)
      setLoading(false)
      return
    }
    setEmployee(record)

    const target = { id: record.id, accessRole: record.accessRole }
    const belowLevel = canAccess(target)

    // ── pay ──────────────────────────────────────────────────────────────
    let nextComp: Gated<EmployeeCompensation>
    if (!can('employees.editPay')) {
      nextComp = { state: 'no-permission' }
    } else if (!belowLevel) {
      nextComp = { state: 'below-level' }
    } else {
      try {
        const comp = await getEmployeeCompensation(record.id)
        nextComp =
          comp === null ? { state: 'unavailable' } : { state: 'visible', value: comp }
      } catch {
        nextComp = { state: 'unavailable' }
      }
    }
    setCompensation(nextComp)

    // ── scheduling notes + overrides ─────────────────────────────────────
    // firestore.rules gates private/admin on `employees.view` AND below-level.
    // Checking the permission here too keeps the UI's answer identical to the
    // server's — and stops a staff member who lands on this screen from
    // reading the scheduling notes written *about* them.
    let nextAdmin: Gated<EmployeeAdmin>
    if (!belowLevel) {
      nextAdmin = { state: 'below-level' }
    } else if (!can('employees.view')) {
      nextAdmin = { state: 'no-permission' }
    } else {
      try {
        const adminDoc = await getEmployeeAdmin(record.id)
        nextAdmin =
          adminDoc === null
            ? { state: 'unavailable' }
            : { state: 'visible', value: adminDoc }
      } catch {
        nextAdmin = { state: 'unavailable' }
      }
    }
    setAdmin(nextAdmin)

    const next = draftFrom(
      record,
      nextComp.state === 'visible' ? nextComp.value : null,
      nextAdmin.state === 'visible' ? nextAdmin.value : null,
    )
    setDraft(next)
    setBaseline(next)
    setLoading(false)
  }, [id, can, canAccess])

  useEffect(() => {
    void load()
  }, [load])

  const target = employee ? { id: employee.id, accessRole: employee.accessRole } : null
  const belowLevel = canAccess(target)
  const canEdit = can('employees.edit')
  const canEditPay = can('employees.editPay') && belowLevel
  const canRank = can('employees.rankSkills')
  const canManagePermissions = can('permissions.manage')

  const dirty = useMemo(
    () => draft !== null && baseline !== null && JSON.stringify(draft) !== JSON.stringify(baseline),
    [draft, baseline],
  )

  function set<K extends keyof Draft>(key: K, value: Draft[K]): void {
    setDraft((d) => (d === null ? d : { ...d, [key]: value }))
  }

  async function save(): Promise<void> {
    if (!employee || !draft || !baseline) return

    const patch: Partial<Employee> = {}

    if (canEdit) {
      if (draft.employmentType !== baseline.employmentType) {
        patch.employmentType = draft.employmentType
      }
      if (draft.status !== baseline.status) patch.status = draft.status
      if (draft.clockRequired !== baseline.clockRequired) {
        patch.clockRequired = draft.clockRequired
      }
      if (draft.tipsRequired !== baseline.tipsRequired) {
        patch.tipsRequired = draft.tipsRequired
      }
    }

    if (canRank && JSON.stringify(draft.shiftRoles) !== JSON.stringify(baseline.shiftRoles)) {
      patch.shiftRoles = draft.shiftRoles
    }

    // Pay is written ONLY when it was actually visible. A restricted viewer has
    // an empty draft for these fields; sending them would blank a real rate.
    if (canEditPay && compensation.state === 'visible') {
      const rate = moneyToNumber(draft.hourlyRate)
      const salary = moneyToNumber(draft.salaryAmount)
      if (rate === 'invalid' || salary === 'invalid') {
        setRateError(t('people.employment.rateInvalid'))
        return
      }
      if (draft.hourlyRate !== baseline.hourlyRate) patch.hourlyRate = rate
      if (draft.salaryAmount !== baseline.salaryAmount) patch.salaryAmount = salary
      if (draft.salaryPeriod !== baseline.salaryPeriod) patch.salaryPeriod = draft.salaryPeriod
    }
    setRateError(null)

    if (admin.state === 'visible' && draft.schedulingNotes !== baseline.schedulingNotes) {
      patch.schedulingNotes = draft.schedulingNotes
    }

    if (
      canManagePermissions &&
      admin.state === 'visible' &&
      JSON.stringify(draft.permissionOverrides) !==
        JSON.stringify(baseline.permissionOverrides)
    ) {
      patch.permissionOverrides = draft.permissionOverrides
    }

    if (Object.keys(patch).length === 0) return

    setSaving(true)
    try {
      await updateEmployee(employee.id, patch)
      toast.show({ tone: 'success', message: t('people.toast.saved') })
      await load()
    } catch {
      toast.show({ tone: 'error', message: t('people.toast.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  async function confirmArchive(): Promise<void> {
    if (!employee) return
    setArchiveOpen(false)
    try {
      await archiveEmployee(employee.id)
      toast.show({
        tone: 'success',
        message: t('people.toast.archived', { name: employee.firstName }),
      })
      await load()
    } catch {
      toast.show({ tone: 'error', message: t('people.toast.archiveFailed') })
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl" role="status">
        <div className="h-40 animate-skeleton rounded-card-lg border border-line bg-app" />
        <p className="sr-only">{t('app.loading')}</p>
      </div>
    )
  }

  if (notFound || !employee || !draft) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          illustration="search"
          title={t('people.profile.notFoundTitle')}
          body={t('people.profile.notFoundBody')}
          action={
            <Button onClick={() => navigate(basePath)}>
              {t('people.profile.backToRoster')}
            </Button>
          }
        />
      </div>
    )
  }

  const fullName = `${employee.firstName} ${employee.lastName}`.trim()
  const preferred = employee.preferredName?.trim() ?? ''
  const address = employee.address ? addressLine(employee.address) : ''

  return (
    <div className="mx-auto max-w-7xl">
      <nav aria-label={t('people.profile.breadcrumb')} className="mb-6 flex items-center gap-2 text-meta text-ink-muted">
        <Link to={basePath} className="transition-colors duration-hover hover:text-ink">
          {t('nav.people')}
        </Link>
        <span aria-hidden="true">/</span>
        <span className="font-medium text-ink">{fullName}</span>
      </nav>

      {/* ── header band ─────────────────────────────────────────────────── */}
      <section className="mb-8 rounded-card-lg border border-line bg-page p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex gap-6">
            <Avatar
              firstName={employee.firstName}
              lastName={employee.lastName}
              photoUrl={employee.photoUrl}
              size={80}
            />
            <div className="flex flex-col">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="text-title-lg font-semibold tracking-tight text-ink">
                  {fullName}
                </h1>
                <Pill tone={statusTone(employee.status)}>
                  {t(`status.${employee.status}`)}
                </Pill>
              </div>
              <p className="tabular mt-0.5 text-meta text-ink-muted">
                {t('people.profile.identity', {
                  number: employee.employeeNumber,
                  date: formatIsoDate(employee.hireDate),
                })}
              </p>
              <ShiftRoleChips
                catalog={catalog}
                value={employee.shiftRoles}
                className="mt-3"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            {canEdit && employee.status !== 'archived' ? (
              <Button onClick={() => setArchiveOpen(true)}>
                {t('people.profile.archiveEmployee')}
              </Button>
            ) : null}
            {canEdit || canRank || canManagePermissions ? (
              <Button
                variant="primary"
                disabled={!dirty || saving}
                onClick={() => void save()}
              >
                {saving ? t('people.profile.saving') : t('common.saveChanges')}
              </Button>
            ) : null}
          </div>
        </div>

        <nav
          aria-label={t('people.profile.sections')}
          className="mt-8 flex gap-8 overflow-x-auto border-b border-line"
        >
          {(['details', 'schedule', 'punches', 'documents', 'disciplinary'] as TabId[])
            .filter(
              (id_) =>
                id_ !== 'disciplinary' || (can('discipline.view') && belowLevel),
            )
            .map((id_) => (
              <button
                key={id_}
                type="button"
                aria-current={tab === id_ ? 'page' : undefined}
                onClick={() => setTab(id_)}
                className={[
                  'whitespace-nowrap border-b-2 pb-3.5 text-meta transition-colors duration-hover',
                  tab === id_
                    ? 'border-primary font-semibold text-primary'
                    : 'border-transparent font-medium text-ink-muted hover:text-ink',
                ].join(' ')}
              >
                {t(`people.tabs.${id_}`)}
              </button>
            ))}
        </nav>
      </section>

      {tab === 'disciplinary' ? (
        <div className="mx-auto max-w-3xl rounded-card border border-line bg-page p-6">
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-section font-semibold text-ink">{t('people.tabs.disciplinary')}</h2>
            <Can permission="discipline.issue">
              <Button onClick={() => navigate(`/settings/discipline?employeeId=${employee.id}`)}>
                {t('people.discipline.manageLink')}
              </Button>
            </Can>
          </div>
          <DisciplineLadderWidget
            employeeId={employee.id}
            isSelf={false}
            enabled={belowLevel && can('discipline.view')}
          />
        </div>
      ) : tab !== 'details' ? (
        <EmptyState
          illustration="calendar"
          title={t(`people.tabs.${tab}`)}
          body={t('placeholder.phaseNote', { phase: LATER_PHASE[tab] })}
        />
      ) : (
        <div className="grid grid-cols-12 gap-6">
          {/* ── left column ────────────────────────────────────────────── */}
          <div className="col-span-12 flex flex-col gap-6 lg:col-span-7">
            <Card>
              <CardHeader title={t('people.personal.title')} />
              <div className="grid grid-cols-1 gap-x-8 gap-y-6 p-6 sm:grid-cols-2">
                <Field label={t('people.fields.legalName')} value={fullName} />
                <Field label={t('people.fields.preferredName')} value={preferred} />
                <Field label={t('auth.email')} value={employee.email} />
                <Field label={t('people.fields.phone')} value={employee.phone ?? ''} numeric />
                <Field
                  label={t('people.fields.birthday')}
                  value={formatIsoDate(employee.birthday)}
                  numeric
                />
                <Field label={t('people.fields.address')} value={address} />
                <Field label={t('people.fields.pronouns')} value={employee.pronouns ?? ''} />
                <Field
                  label={t('common.language')}
                  value={
                    employee.language === 'es' ? t('common.spanish') : t('common.english')
                  }
                />
              </div>
            </Card>

            <Card>
              <CardHeader title={t('people.emergency.title')} />
              <div className="grid grid-cols-1 gap-8 p-6 sm:grid-cols-2">
                <Field
                  label={t('people.fields.contactName')}
                  value={employee.emergencyContact?.name ?? ''}
                />
                <Field
                  label={t('people.fields.phone')}
                  value={employee.emergencyContact?.phone ?? ''}
                  numeric
                />
              </div>
            </Card>

            <Card>
              <CardHeader
                title={t('people.employment.title')}
                badge={t('people.employment.adminOnly')}
              />
              <div className="space-y-6 p-6">
                <div className="grid grid-cols-1 gap-x-8 gap-y-6 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor={`${rateFieldId}-type`}
                      className="mb-2 block text-chip font-medium text-ink-muted"
                    >
                      {t('people.fields.employmentType')}
                    </label>
                    <select
                      id={`${rateFieldId}-type`}
                      value={draft.employmentType}
                      disabled={!canEdit}
                      onChange={(e) => {
                        // salaryPeriod is derived, never asked for twice.
                        const next = e.target.value as EmploymentType
                        setDraft((d) =>
                          d === null
                            ? d
                            : {
                                ...d,
                                employmentType: next,
                                salaryPeriod:
                                  next === 'salaried-weekly'
                                    ? 'weekly'
                                    : next === 'salaried-monthly'
                                      ? 'monthly'
                                      : null,
                              },
                        )
                      }}
                      className="h-10 w-full rounded-control border border-line bg-app px-3 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
                    >
                      {EMPLOYMENT_TYPES.map((v) => (
                        <option key={v} value={v}>
                          {t(`employmentTypes.${v}`)}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* PAY — the below-level rule lands here. */}
                  <div>
                    {compensation.state === 'visible' ? (
                      isSalaried(draft.employmentType) ? (
                        <>
                          <label
                            htmlFor={`${rateFieldId}-salary`}
                            className="mb-2 block text-chip font-medium text-ink-muted"
                          >
                            {t('people.fields.salaryAmount')}
                          </label>
                          <div className="relative">
                            <span
                              aria-hidden="true"
                              className="absolute left-3 top-1/2 -translate-y-1/2 text-meta text-ink-muted"
                            >
                              $
                            </span>
                            <input
                              id={`${rateFieldId}-salary`}
                              type="text"
                              inputMode="decimal"
                              value={draft.salaryAmount}
                              disabled={!canEditPay}
                              aria-invalid={rateError !== null}
                              aria-describedby={
                                rateError !== null ? `${rateFieldId}-error` : undefined
                              }
                              onChange={(e) => set('salaryAmount', e.target.value)}
                              className="tabular h-10 w-full rounded-control border border-line bg-page pl-7 pr-3 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60 aria-[invalid=true]:border-danger"
                            />
                          </div>
                          <p className="mt-1.5 text-chip text-ink-muted">
                            {t('people.employment.salaryHint')}
                          </p>
                        </>
                      ) : (
                        <>
                          <label
                            htmlFor={`${rateFieldId}-rate`}
                            className="mb-2 block text-chip font-medium text-ink-muted"
                          >
                            {t('people.fields.hourlyRate')}
                          </label>
                          <div className="relative">
                            <span
                              aria-hidden="true"
                              className="absolute left-3 top-1/2 -translate-y-1/2 text-meta text-ink-muted"
                            >
                              $
                            </span>
                            <input
                              id={`${rateFieldId}-rate`}
                              type="text"
                              inputMode="decimal"
                              value={draft.hourlyRate}
                              disabled={!canEditPay}
                              aria-invalid={rateError !== null}
                              aria-describedby={
                                rateError !== null ? `${rateFieldId}-error` : undefined
                              }
                              onChange={(e) => set('hourlyRate', e.target.value)}
                              className="tabular h-10 w-full rounded-control border border-line bg-page pl-7 pr-3 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60 aria-[invalid=true]:border-danger"
                            />
                          </div>
                          {draft.hourlyRate === '' ? (
                            <p className="mt-1.5 text-chip text-ink-muted">
                              {t('people.employment.noRateOnFile')}
                            </p>
                          ) : null}
                        </>
                      )
                    ) : (
                      <RestrictedNotice
                        title={t('people.pay.restrictedTitle')}
                        body={t(`people.pay.restricted.${compensation.state}`)}
                      />
                    )}
                    {rateError !== null ? (
                      <p id={`${rateFieldId}-error`} className="mt-1 text-chip text-danger">
                        {rateError}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-4 pt-2">
                  <Toggle
                    label={t('people.employment.clockRequired')}
                    description={t('people.employment.clockRequiredHint')}
                    checked={draft.clockRequired}
                    disabled={!canEdit}
                    onChange={(v) => set('clockRequired', v)}
                  />
                  <div className="border-t border-line pt-4">
                    <Toggle
                      label={t('people.employment.tipsRequired')}
                      description={t('people.employment.tipsRequiredHint')}
                      checked={draft.tipsRequired}
                      disabled={!canEdit}
                      onChange={(v) => set('tipsRequired', v)}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-x-8 gap-y-6 pt-2 sm:grid-cols-2">
                  <Field
                    label={t('people.fields.hireDate')}
                    value={formatIsoDate(employee.hireDate)}
                    numeric
                  />
                  <div>
                    <p className="mb-2 text-chip font-medium text-ink-muted" id={`${rateFieldId}-status`}>
                      {t('filters.status')}
                    </p>
                    <div
                      role="radiogroup"
                      aria-labelledby={`${rateFieldId}-status`}
                      className="inline-flex flex-wrap rounded-control border border-line bg-gray-100 p-1"
                    >
                      {STATUSES.map((s) => {
                        const selected = draft.status === s
                        return (
                          <button
                            key={s}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={!canEdit}
                            onClick={() => set('status', s)}
                            className={[
                              'rounded-md px-4 py-1 text-chip font-semibold transition-colors duration-hover',
                              'disabled:cursor-not-allowed disabled:opacity-60',
                              selected
                                ? 'border border-line bg-page text-ink shadow-sm'
                                : 'text-ink-muted hover:text-ink',
                            ].join(' ')}
                          >
                            {t(`status.${s}`)}
                          </button>
                        )
                      })}
                    </div>
                    <p className="mt-1.5 text-chip text-ink-muted">
                      {t('people.employment.archiveNote')}
                    </p>
                  </div>
                </div>
              </div>
            </Card>
          </div>

          {/* ── right column ───────────────────────────────────────────── */}
          <div className="col-span-12 flex flex-col gap-6 lg:col-span-5">
            <ShiftRolesEditor
              catalog={catalog}
              value={draft.shiftRoles}
              readOnly={!canRank}
              onChange={(next) => set('shiftRoles', next)}
            />

            {!canManagePermissions ? (
              <section className="rounded-card border border-line bg-page p-6">
                <h2 className="mb-4 text-section font-semibold text-ink">
                  {t('people.overrides.title')}
                </h2>
                <RestrictedNotice
                  title={t('people.overrides.restrictedTitle')}
                  body={t('people.overrides.restrictedBody')}
                />
              </section>
            ) : admin.state === 'visible' ? (
              <PermissionOverridesEditor
                value={draft.permissionOverrides}
                roleDefaults={roleDefaults[employee.accessRole] ?? {}}
                targetRole={employee.accessRole}
                onChange={(next) => set('permissionOverrides', next)}
              />
            ) : (
              <section className="rounded-card border border-line bg-page p-6">
                <h2 className="mb-4 text-section font-semibold text-ink">
                  {t('people.overrides.title')}
                </h2>
                <RestrictedNotice
                  title={t('people.admin.restrictedTitle')}
                  body={t(`people.admin.restricted.${admin.state}`)}
                />
              </section>
            )}

            <section className="rounded-card border border-line bg-page p-6">
              <h2 className="mb-4 text-section font-semibold text-ink">
                {t('people.login.title')}
              </h2>
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex min-w-0 flex-col">
                    <span className="text-meta font-medium text-ink">
                      {t('people.login.linkedAccounts')}
                    </span>
                    <span className="tabular text-chip text-ink-muted">
                      {t('people.login.linkedCount', {
                        count: employee.authUids.length,
                      })}
                    </span>
                  </div>
                  <Pill tone={employee.authUids.length > 0 ? 'approved' : 'pending'}>
                    {employee.authUids.length > 0
                      ? t('people.login.linked')
                      : t('people.login.notLinked')}
                  </Pill>
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-line pt-4 opacity-45">
                  <span className="text-meta font-medium text-ink">
                    {t('people.login.phoneOtp')}
                  </span>
                  <Pill tone="draft">{t('common.comingSoon')}</Pill>
                </div>
              </div>
              <p className="mt-4 text-chip text-ink-muted">
                {t('people.login.adminNote')}
              </p>
            </section>

            <section className="rounded-card border border-line bg-page p-6">
              <h2 className="mb-4 text-section font-semibold text-ink">
                {t('people.notes.title')}
              </h2>
              {admin.state === 'visible' ? (
                <>
                  <label htmlFor={`${rateFieldId}-notes`} className="sr-only">
                    {t('people.notes.title')}
                  </label>
                  <textarea
                    id={`${rateFieldId}-notes`}
                    value={draft.schedulingNotes}
                    disabled={!canEdit}
                    onChange={(e) => set('schedulingNotes', e.target.value)}
                    placeholder={t('people.notes.placeholder')}
                    className="h-24 w-full rounded-control border border-line bg-page p-3 text-meta text-ink placeholder:text-ink-muted focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
                  />
                  <p className="mt-3 text-chip font-medium text-success">
                    {t('people.notes.visibility')}
                  </p>
                </>
              ) : (
                <RestrictedNotice
                  title={t('people.admin.restrictedTitle')}
                  body={t(`people.admin.restricted.${admin.state}`)}
                />
              )}
            </section>
          </div>
        </div>
      )}

      <Modal
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        title={t('people.archiveModal.title')}
        subtitle={fullName}
        footer={
          <>
            <Button onClick={() => setArchiveOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={() => void confirmArchive()}>
              {t('people.archiveModal.confirm')}
            </Button>
          </>
        }
      >
        <p className="text-meta text-ink">{t('people.archiveModal.body')}</p>
      </Modal>
    </div>
  )
}

/** Spec §3 stores address as parts; the mockup renders one line. */
function addressLine(address: NonNullable<Employee['address']>): string {
  const { street, city, state, zip } = address
  const tail = [city, [state, zip].filter(Boolean).join(' ').trim()]
    .filter((part) => part !== '')
    .join(', ')
  return [street, tail].filter((part) => part !== '').join(', ')
}

export default EmployeeProfilePage
