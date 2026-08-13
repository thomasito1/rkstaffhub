import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Avatar, Button, EmptyState, Pill, useToast } from '@/components/ui'
import { useAuth } from '@/lib/auth/AuthProvider'
import { getEmployeeCompensation, listShiftRoles, updateEmployee } from '@/lib/db'
import { formatCurrency, formatDate } from '@/lib/format'
import { setLanguage, SUPPORTED_LANGUAGES, type Language } from '@/i18n'
import type { Employee, ShiftRole } from '@/types/models'

import { ShiftRoleChips } from './components/ShiftRolesEditor'

/**
 * The staff view of their own profile — mockup 03.
 *
 * WHAT AN EMPLOYEE MAY SEE ABOUT THEMSELVES (spec §17): their own rate — yes,
 * confirmed. Not their scheduling notes, which are written *about* them by
 * managers, and not their permission overrides as an editable thing.
 *
 * `getEmployeeCompensation()` returns `null` for "absent OR refused". Even for
 * yourself that is never rendered as `$0` — a blank rate on your own profile
 * would read as "I am paid nothing", which is worse than "we can't show this
 * right now". It renders an explicit notice instead.
 *
 * Roles and skill levels are READ ONLY here (`shiftRoles` is on the list of
 * fields firestore.rules forbids a person to change on themselves), with the
 * mockup's "set by your manager" note.
 *
 * The documents card and the standing/ladder widget are Phase 4 (spec §19).
 * They render as the card shell the mockup draws with a "later phase" empty
 * state — no disciplinary feature is built here.
 */

interface EditDraft {
  preferredName: string
  phone: string
  street: string
  city: string
  state: string
  zip: string
  emergencyName: string
  emergencyPhone: string
}

function draftFrom(employee: Employee): EditDraft {
  return {
    preferredName: employee.preferredName ?? '',
    phone: employee.phone ?? '',
    street: employee.address?.street ?? '',
    city: employee.address?.city ?? '',
    state: employee.address?.state ?? '',
    zip: employee.address?.zip ?? '',
    emergencyName: employee.emergencyContact?.name ?? '',
    emergencyPhone: employee.emergencyContact?.phone ?? '',
  }
}

function formatIsoDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const date = new Date(`${iso}T00:00:00`)
  return Number.isNaN(date.getTime()) ? '' : formatDate(date)
}

// ── card primitives (mockup 03) ──────────────────────────────────────────────

function StackCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="rounded-card border border-line bg-page p-4">
      <div className="mb-4">
        <h2 className="text-meta font-semibold text-ink">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-chip text-ink-muted">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  )
}

function ReadRow({
  label,
  value,
  numeric = false,
  last = false,
}: {
  label: string
  value: string
  numeric?: boolean
  last?: boolean
}): JSX.Element {
  return (
    <div className={last ? '' : 'border-b border-line pb-3'}>
      <p className="text-chip font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </p>
      <p
        className={['mt-0.5 text-meta text-ink', numeric ? 'tabular' : '']
          .filter(Boolean)
          .join(' ')}
      >
        {value === '' ? '—' : value}
      </p>
    </div>
  )
}

const INPUT_CLASS =
  'h-10 w-full rounded-control border border-line bg-page px-3 text-meta text-ink ' +
  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary'

function EditRow({
  id,
  label,
  value,
  onChange,
  numeric = false,
}: {
  id: string
  label: string
  value: string
  onChange: (next: string) => void
  numeric?: boolean
}): JSX.Element {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-chip font-medium uppercase tracking-wide text-ink-muted"
      >
        {label}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={numeric ? `${INPUT_CLASS} tabular` : INPUT_CLASS}
      />
    </div>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────

export function MyProfilePage(): JSX.Element {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const { employee, user, status } = useAuth()
  const fieldId = useId()

  const [catalog, setCatalog] = useState<ShiftRole[]>([])
  const [rate, setRate] = useState<
    { state: 'loading' } | { state: 'unavailable' } | {
      state: 'visible'
      hourlyRate: number | null
      salaryAmount: number | null
      salaryPeriod: 'weekly' | 'monthly' | null
    }
  >({ state: 'loading' })

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<EditDraft | null>(null)
  const [saving, setSaving] = useState(false)

  const employeeId = employee?.id ?? ''

  const loadRate = useCallback(async () => {
    if (employeeId === '') return
    setRate({ state: 'loading' })
    try {
      const comp = await getEmployeeCompensation(employeeId)
      // `null` is "absent OR refused" — indistinguishable by design. Never $0.
      setRate(
        comp === null
          ? { state: 'unavailable' }
          : {
              state: 'visible',
              hourlyRate: comp.hourlyRate,
              salaryAmount: comp.salaryAmount,
              salaryPeriod: comp.salaryPeriod,
            },
      )
    } catch {
      setRate({ state: 'unavailable' })
    }
  }, [employeeId])

  useEffect(() => {
    void loadRate()
  }, [loadRate])

  useEffect(() => {
    void listShiftRoles()
      .then(setCatalog)
      .catch(() => setCatalog([]))
  }, [])

  const providers = useMemo(() => {
    const ids = new Set((user?.providerData ?? []).map((p) => p.providerId))
    return {
      google: ids.has('google.com'),
      password: ids.has('password'),
      googleEmail:
        (user?.providerData ?? []).find((p) => p.providerId === 'google.com')?.email ??
        '',
    }
  }, [user])

  if (status === 'loading') {
    return (
      <div className="mx-auto max-w-lg" role="status">
        <div className="h-40 animate-skeleton rounded-card-lg border border-line bg-app" />
        <p className="sr-only">{t('app.loading')}</p>
      </div>
    )
  }

  if (!employee) {
    return (
      <div className="mx-auto max-w-lg">
        <EmptyState
          illustration="search"
          title={t('auth.notLinkedTitle')}
          body={t('auth.notLinkedBody')}
        />
      </div>
    )
  }

  const shiftRoles = employee.shiftRoles ?? []
  const fullName = `${employee.firstName} ${employee.lastName}`.trim()

  function startEditing(): void {
    if (!employee) return
    setDraft(draftFrom(employee))
    setEditing(true)
  }

  function cancelEditing(): void {
    setDraft(null)
    setEditing(false)
  }

  async function save(): Promise<void> {
    if (!employee || !draft) return
    setSaving(true)
    try {
      // Only fields firestore.rules lets a person change on themselves —
      // never accessRole, status, employmentType, shiftRoles or employeeNumber.
      await updateEmployee(employee.id, {
        preferredName: draft.preferredName.trim() === '' ? null : draft.preferredName.trim(),
        phone: draft.phone.trim() === '' ? null : draft.phone.trim(),
        address:
          [draft.street, draft.city, draft.state, draft.zip].every(
            (part) => part.trim() === '',
          )
            ? null
            : {
                street: draft.street.trim(),
                city: draft.city.trim(),
                state: draft.state.trim(),
                zip: draft.zip.trim(),
              },
        emergencyContact:
          draft.emergencyName.trim() === '' && draft.emergencyPhone.trim() === ''
            ? null
            : {
                name: draft.emergencyName.trim(),
                phone: draft.emergencyPhone.trim(),
              },
      })
      toast.show({ tone: 'success', message: t('people.toast.saved') })
      setEditing(false)
      setDraft(null)
    } catch {
      toast.show({ tone: 'error', message: t('people.toast.saveFailed') })
    } finally {
      setSaving(false)
    }
  }

  async function chooseLanguage(lang: Language): Promise<void> {
    if (!employee || employee.language === lang) return
    setLanguage(lang)
    try {
      await updateEmployee(employee.id, { language: lang })
    } catch {
      toast.show({ tone: 'error', message: t('people.toast.saveFailed') })
    }
  }

  function setField<K extends keyof EditDraft>(key: K, value: EditDraft[K]): void {
    setDraft((d) => (d === null ? d : { ...d, [key]: value }))
  }

  const addressText = employee.address
    ? [
        employee.address.street,
        [
          employee.address.city,
          [employee.address.state, employee.address.zip].filter(Boolean).join(' ').trim(),
        ]
          .filter((part) => part !== '')
          .join(', '),
      ]
        .filter((part) => part !== '')
        .join(', ')
    : ''

  return (
    <div className="mx-auto max-w-lg pb-8">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h1 className="text-title font-semibold tracking-tight text-ink">
          {t('people.my.title')}
        </h1>
        {editing ? (
          <div className="flex gap-2">
            <Button onClick={cancelEditing} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving}>
              {saving ? t('people.profile.saving') : t('common.save')}
            </Button>
          </div>
        ) : (
          <Button onClick={startEditing}>{t('common.edit')}</Button>
        )}
      </div>

      {/* ── header band ─────────────────────────────────────────────────── */}
      <section className="mb-4 flex flex-col items-center rounded-card border border-line bg-page px-4 pb-4 pt-6">
        <Avatar
          firstName={employee.firstName}
          lastName={employee.lastName}
          photoUrl={employee.photoUrl}
          size={80}
        />
        <h2 className="mt-3 text-title font-semibold text-ink">{fullName}</h2>
        <p className="tabular mt-0.5 text-meta text-ink-muted">
          {t('people.my.identity', {
            number: employee.employeeNumber,
            date: formatIsoDate(employee.hireDate),
          })}
        </p>
        <ShiftRoleChips catalog={catalog} value={shiftRoles} className="mt-4 justify-center" />
        <p className="mb-2 mt-3 text-chip text-ink-muted">{t('people.my.rolesNote')}</p>
      </section>

      <div className="space-y-4">
        {/* Card A — personal information */}
        <StackCard title={t('people.personal.title')}>
          {editing && draft ? (
            <div className="space-y-4">
              <EditRow
                id={`${fieldId}-preferred`}
                label={t('people.fields.preferredName')}
                value={draft.preferredName}
                onChange={(v) => setField('preferredName', v)}
              />
              <ReadRow label={t('auth.email')} value={employee.email} />
              <EditRow
                id={`${fieldId}-phone`}
                label={t('people.fields.phone')}
                value={draft.phone}
                onChange={(v) => setField('phone', v)}
                numeric
              />
              <EditRow
                id={`${fieldId}-street`}
                label={t('people.fields.street')}
                value={draft.street}
                onChange={(v) => setField('street', v)}
              />
              <div className="grid grid-cols-3 gap-2">
                <EditRow
                  id={`${fieldId}-city`}
                  label={t('people.fields.city')}
                  value={draft.city}
                  onChange={(v) => setField('city', v)}
                />
                <EditRow
                  id={`${fieldId}-state`}
                  label={t('people.fields.state')}
                  value={draft.state}
                  onChange={(v) => setField('state', v)}
                />
                <EditRow
                  id={`${fieldId}-zip`}
                  label={t('people.fields.zip')}
                  value={draft.zip}
                  onChange={(v) => setField('zip', v)}
                  numeric
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <ReadRow
                label={t('people.fields.preferredName')}
                value={employee.preferredName ?? ''}
              />
              <ReadRow label={t('auth.email')} value={employee.email} />
              <ReadRow label={t('people.fields.phone')} value={employee.phone ?? ''} numeric />
              <ReadRow label={t('people.fields.address')} value={addressText} last />
            </div>
          )}
        </StackCard>

        {/* Card B — emergency contact */}
        <StackCard title={t('people.emergency.title')}>
          {editing && draft ? (
            <div className="space-y-4">
              <EditRow
                id={`${fieldId}-ename`}
                label={t('people.fields.contactName')}
                value={draft.emergencyName}
                onChange={(v) => setField('emergencyName', v)}
              />
              <EditRow
                id={`${fieldId}-ephone`}
                label={t('people.fields.phone')}
                value={draft.emergencyPhone}
                onChange={(v) => setField('emergencyPhone', v)}
                numeric
              />
            </div>
          ) : (
            <div className="space-y-4">
              <ReadRow
                label={t('people.fields.contactName')}
                value={employee.emergencyContact?.name ?? ''}
              />
              <ReadRow
                label={t('people.fields.phone')}
                value={employee.emergencyContact?.phone ?? ''}
                numeric
                last
              />
            </div>
          )}
        </StackCard>

        {/* Card — my pay (spec §17: own rate = yes) */}
        <StackCard title={t('people.my.payTitle')} subtitle={t('people.my.paySubtitle')}>
          {rate.state === 'loading' ? (
            <div className="h-10 animate-skeleton rounded-control bg-app" role="status">
              <span className="sr-only">{t('app.loading')}</span>
            </div>
          ) : rate.state === 'unavailable' ? (
            <div className="rounded-control border border-line bg-app p-4">
              <p className="text-meta font-semibold text-ink">
                {t('people.my.payUnavailableTitle')}
              </p>
              <p className="mt-0.5 text-chip text-ink-muted">
                {t('people.my.payUnavailableBody')}
              </p>
            </div>
          ) : rate.salaryAmount !== null ? (
            <p className="tabular text-title font-semibold text-ink">
              {formatCurrency(rate.salaryAmount, i18n.language)}{' '}
              <span className="text-meta font-normal text-ink-muted">
                {rate.salaryPeriod === 'monthly'
                  ? t('people.my.perMonth')
                  : t('people.my.perWeek')}
              </span>
            </p>
          ) : rate.hourlyRate !== null ? (
            <p className="tabular text-title font-semibold text-ink">
              {formatCurrency(rate.hourlyRate, i18n.language)}{' '}
              <span className="text-meta font-normal text-ink-muted">
                {t('people.my.perHour')}
              </span>
            </p>
          ) : (
            <p className="text-meta text-ink-muted">{t('people.my.payNotSet')}</p>
          )}
        </StackCard>

        {/* Card C — login methods */}
        <StackCard title={t('people.login.title')}>
          <div className="space-y-5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-meta font-medium text-ink">{t('people.login.google')}</p>
                <p className="truncate text-chip text-ink-muted">
                  {providers.googleEmail === '' ? employee.email : providers.googleEmail}
                </p>
              </div>
              <Pill tone={providers.google ? 'approved' : 'draft'}>
                {providers.google ? t('people.login.linked') : t('people.login.notLinked')}
              </Pill>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
              <p className="text-meta font-medium text-ink">
                {t('people.login.emailPassword')}
              </p>
              <Pill tone={providers.password ? 'approved' : 'draft'}>
                {providers.password
                  ? t('people.login.linked')
                  : t('people.login.notLinked')}
              </Pill>
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line pt-4 opacity-45">
              <p className="text-meta font-medium text-ink">{t('people.login.phoneOtp')}</p>
              <Pill tone="draft">{t('common.comingSoon')}</Pill>
            </div>
          </div>
        </StackCard>

        {/* Card D — language */}
        <StackCard title={t('common.language')}>
          <div
            role="radiogroup"
            aria-label={t('common.language')}
            className="mb-2 flex rounded-control bg-gray-100 p-1"
          >
            {SUPPORTED_LANGUAGES.map((lang) => {
              const selected = (employee.language ?? 'en') === lang
              return (
                <button
                  key={lang}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => void chooseLanguage(lang)}
                  className={[
                    'flex-1 rounded-md py-1.5 text-meta transition-colors duration-hover',
                    selected
                      ? 'bg-page font-semibold text-ink shadow-sm'
                      : 'font-medium text-ink-muted hover:text-ink',
                  ].join(' ')}
                >
                  {lang === 'es' ? t('common.spanish') : t('common.english')}
                </button>
              )
            })}
          </div>
          <p className="text-chip text-ink-muted">{t('people.my.languageNote')}</p>
        </StackCard>

        {/* Card E — my documents (Phase 4 shell) */}
        <StackCard title={t('people.my.documentsTitle')}>
          <EmptyState
            illustration="tasks"
            title={t('people.my.documentsEmptyTitle')}
            body={t('placeholder.phaseNote', { phase: 4 })}
          />
        </StackCard>

        {/* Card F — my standing (Phase 4 shell, ladder widget) */}
        <StackCard
          title={t('people.my.standingTitle')}
          subtitle={t('people.my.standingSubtitle')}
        >
          <EmptyState
            illustration="trades"
            title={t('people.my.standingEmptyTitle')}
            body={t('placeholder.phaseNote', { phase: 4 })}
          />
        </StackCard>
      </div>
    </div>
  )
}

export default MyProfilePage
