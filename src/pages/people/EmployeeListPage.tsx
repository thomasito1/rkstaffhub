import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import {
  Avatar,
  Button,
  EmptyState,
  FilterBar,
  FilterSelect,
  KebabMenu,
  Modal,
  Pill,
  SearchInput,
  Table,
  TableCell,
  TableHead,
  TableRow,
  useToast,
} from '@/components/ui'
import { Can } from '@/components/guards/RouteGuards'
import { useAuth } from '@/lib/auth/AuthProvider'
import {
  archiveEmployee,
  createEmployee,
  listEmployees,
  listShiftRoles,
  nextEmployeeNumber,
} from '@/lib/db'
import type {
  Department,
  Employee,
  EmployeeStatus,
  EmploymentType,
  ShiftRole,
} from '@/types/models'

import { ShiftRoleChips } from './components/ShiftRolesEditor'

/**
 * Employee roster — spec §3, §19 Phase 0.
 *
 * There is no mockup for this screen, so it is assembled from the established
 * admin-table pattern (mockup 09): page header + actions, a filter row, then a
 * bordered table panel with 56px rows and a right-aligned kebab.
 *
 * COST NOTE: rows come from `listEmployees()`, which deliberately does NOT read
 * `employees/{id}/private/*`. Every row therefore has `hourlyRate: null` — that
 * is by design, not missing data, which is why this table has no pay column.
 * Adding one would cost 35 extra document reads per page view and would leak
 * nothing anyway, because the rules deny those documents. Pay lives on the
 * profile screen, gated there.
 *
 * The whole roster (all statuses) is fetched once and filtered in memory: ~35
 * documents, and it lets the status filter flip to Archived without a refetch.
 */

const DEPARTMENTS: readonly Department[] = ['FOH', 'BOH', 'Admin'] as const

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

const ALL = 'all'

function statusTone(status: EmployeeStatus): 'approved' | 'pending' | 'neutral' | 'draft' {
  if (status === 'active') return 'approved'
  if (status === 'pending') return 'pending'
  if (status === 'inactive') return 'neutral'
  return 'draft'
}

function displayName(e: Employee): string {
  const first = e.preferredName?.trim() ? e.preferredName : e.firstName
  return `${first} ${e.lastName}`.trim()
}

function matchesSearch(e: Employee, needle: string): boolean {
  if (needle === '') return true
  const haystack = [
    e.firstName,
    e.lastName,
    e.preferredName ?? '',
    e.employeeNumber,
    e.email,
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

export interface EmployeeListPageProps {
  /** Route prefix these rows link into. Routing is wired by the app shell. */
  basePath?: string
}

export function EmployeeListPage({
  basePath = '/people',
}: EmployeeListPageProps): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const toast = useToast()
  const { can } = useAuth()

  const [employees, setEmployees] = useState<Employee[]>([])
  const [catalog, setCatalog] = useState<ShiftRole[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const [department, setDepartment] = useState<string>(ALL)
  const [role, setRole] = useState<string>(ALL)
  const [status, setStatus] = useState<string>('active')
  const [employmentType, setEmploymentType] = useState<string>(ALL)
  const [search, setSearch] = useState('')

  const [addOpen, setAddOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const [people, roles] = await Promise.all([listEmployees(), listShiftRoles()])
      setEmployees(people)
      setCatalog(roles)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const filtersApplied =
    department !== ALL ||
    role !== ALL ||
    employmentType !== ALL ||
    status !== 'active' ||
    search.trim() !== ''

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return employees.filter((e) => {
      if (department !== ALL && e.department !== department) return false
      if (status !== ALL && e.status !== status) return false
      if (employmentType !== ALL && e.employmentType !== employmentType) return false
      if (role !== ALL && !e.shiftRoles.some((r) => r.roleId === role)) return false
      return matchesSearch(e, needle)
    })
  }, [employees, department, status, employmentType, role, search])

  function clearFilters(): void {
    setDepartment(ALL)
    setRole(ALL)
    setStatus('active')
    setEmploymentType(ALL)
    setSearch('')
  }

  async function onArchive(employee: Employee): Promise<void> {
    try {
      await archiveEmployee(employee.id)
      toast.show({
        tone: 'success',
        message: t('people.toast.archived', { name: displayName(employee) }),
      })
      await load()
    } catch {
      toast.show({ tone: 'error', message: t('people.toast.archiveFailed') })
    }
  }

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">
            {t('people.list.title')}
          </h1>
          <p className="mt-0.5 text-meta text-ink-muted">{t('people.list.subtitle')}</p>
        </div>
        <Can permission="employees.edit">
          <div className="flex items-center gap-3">
            <Button onClick={() => navigate(`${basePath}/import`)}>
              {t('people.list.importCsv')}
            </Button>
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              {t('people.list.addEmployee')}
            </Button>
          </div>
        </Can>
      </div>

      <FilterBar className="mb-6">
        <FilterSelect
          label={t('filters.department')}
          value={department}
          onChange={setDepartment}
          options={[
            { value: ALL, label: t('filters.allDepartments') },
            ...DEPARTMENTS.map((d) => ({ value: d, label: t(`departments.${d}`) })),
          ]}
        />
        <FilterSelect
          label={t('filters.role')}
          value={role}
          onChange={setRole}
          options={[
            { value: ALL, label: t('filters.allRoles') },
            ...catalog.map((r) => ({ value: r.id, label: r.name })),
          ]}
        />
        <FilterSelect
          label={t('filters.type')}
          value={employmentType}
          onChange={setEmploymentType}
          options={[
            { value: ALL, label: t('filters.allTypes') },
            ...EMPLOYMENT_TYPES.map((v) => ({
              value: v,
              label: t(`employmentTypes.${v}`),
            })),
          ]}
        />
        <FilterSelect
          label={t('filters.status')}
          value={status}
          onChange={setStatus}
          options={[
            { value: ALL, label: t('filters.allStatuses') },
            ...STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })),
          ]}
        />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t('people.list.searchPlaceholder')}
        />
        <button
          type="button"
          onClick={clearFilters}
          className="ml-auto text-meta font-medium text-ink-muted transition-colors duration-hover hover:text-ink"
        >
          {t('common.clearFilters')}
        </button>
      </FilterBar>

      {loading ? (
        <>
          <p className="sr-only" role="status">
            {t('app.loading')}
          </p>
          <Table>
          <TableHead>
            <TableCell className="w-[280px]">{t('people.columns.employee')}</TableCell>
            <TableCell className="flex-1">{t('people.columns.roles')}</TableCell>
            <TableCell className="w-[150px]">{t('filters.department')}</TableCell>
            <TableCell className="w-[170px]">{t('people.columns.employmentType')}</TableCell>
            <TableCell className="w-[110px]">{t('filters.status')}</TableCell>
            <TableCell className="w-10" />
          </TableHead>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <TableRow key={i}>
              <TableCell className="w-[280px]">
                <span className="h-8 w-8 animate-skeleton rounded-full bg-app" />
                <span className="h-3 w-32 animate-skeleton rounded bg-app" />
              </TableCell>
              <TableCell className="flex-1">
                <span className="h-3 w-40 animate-skeleton rounded bg-app" />
              </TableCell>
              <TableCell className="w-[150px]">
                <span className="h-3 w-24 animate-skeleton rounded bg-app" />
              </TableCell>
              <TableCell className="w-[170px]">
                <span className="h-3 w-24 animate-skeleton rounded bg-app" />
              </TableCell>
              <TableCell className="w-[110px]">
                <span className="h-5 w-16 animate-skeleton rounded-full bg-app" />
              </TableCell>
              <TableCell className="w-10" />
            </TableRow>
          ))}
          </Table>
        </>
      ) : loadError ? (
        <EmptyState
          illustration="search"
          title={t('people.list.errorTitle')}
          body={t('people.list.errorBody')}
          action={<Button onClick={() => void load()}>{t('common.retry')}</Button>}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          illustration={filtersApplied ? 'search' : 'tasks'}
          title={
            filtersApplied ? t('empty.noResults') : t('people.list.emptyRosterTitle')
          }
          body={
            filtersApplied ? t('empty.noResultsBody') : t('people.list.emptyRosterBody')
          }
          action={
            filtersApplied ? (
              <Button onClick={clearFilters}>{t('common.clearFilters')}</Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <Table>
            <TableHead>
              <TableCell className="w-[280px]">{t('people.columns.employee')}</TableCell>
              <TableCell className="flex-1">{t('people.columns.roles')}</TableCell>
              <TableCell className="w-[150px]">{t('filters.department')}</TableCell>
              <TableCell className="w-[170px]">
                {t('people.columns.employmentType')}
              </TableCell>
              <TableCell className="w-[110px]">{t('filters.status')}</TableCell>
              <TableCell className="w-10" />
            </TableHead>

            {rows.map((employee) => {
              const name = displayName(employee)
              const menuItems: {
                label: string
                onClick: () => void
                danger?: boolean
              }[] = [
                {
                  label: t('people.list.viewProfile'),
                  onClick: () => navigate(`${basePath}/${employee.id}`),
                },
              ]
              // Archive, never delete (spec §18) — firestore.rules denies
              // employee deletes outright, so this is the only way out.
              if (can('employees.edit') && employee.status !== 'archived') {
                menuItems.push({
                  label: t('people.list.archive'),
                  danger: true,
                  onClick: () => {
                    void onArchive(employee)
                  },
                })
              }

              return (
                <TableRow
                  key={employee.id}
                  onClick={() => navigate(`${basePath}/${employee.id}`)}
                >
                  <TableCell className="w-[280px]">
                    <Avatar
                      firstName={employee.firstName}
                      lastName={employee.lastName}
                      photoUrl={employee.photoUrl}
                      size={32}
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-meta font-semibold text-ink">
                        {name}
                      </span>
                      <span className="tabular truncate text-chip text-ink-muted">
                        {t('people.employeeNumber', {
                          number: employee.employeeNumber,
                        })}
                      </span>
                    </span>
                  </TableCell>

                  <TableCell className="flex-1">
                    {employee.shiftRoles.length === 0 ? (
                      <span className="text-meta text-ink-muted">
                        {t('people.list.noRoles')}
                      </span>
                    ) : (
                      <ShiftRoleChips catalog={catalog} value={employee.shiftRoles} />
                    )}
                  </TableCell>

                  <TableCell className="w-[150px]">
                    <span className="truncate text-meta text-ink">
                      {t(`departments.${employee.department}`)}
                    </span>
                  </TableCell>

                  <TableCell className="w-[170px]">
                    <span className="truncate text-meta text-ink">
                      {t(`employmentTypes.${employee.employmentType}`)}
                    </span>
                  </TableCell>

                  <TableCell className="w-[110px]">
                    <Pill tone={statusTone(employee.status)}>
                      {t(`status.${employee.status}`)}
                    </Pill>
                  </TableCell>

                  <TableCell className="w-10" align="right">
                    {/* The row itself navigates; the menu must not. */}
                    <span
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <KebabMenu items={menuItems} />
                    </span>
                  </TableCell>
                </TableRow>
              )
            })}
          </Table>

          <p className="tabular mt-3 text-chip text-ink-muted">
            {t('people.list.count', { count: rows.length })}
          </p>
        </>
      )}

      <AddEmployeeModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreated={(id) => {
          setAddOpen(false)
          void load()
          navigate(`${basePath}/${id}`)
        }}
      />
    </div>
  )
}

// ── Add employee ─────────────────────────────────────────────────────────────

interface AddDraft {
  employeeNumber: string
  firstName: string
  lastName: string
  email: string
  department: Department
  employmentType: EmploymentType
}

const EMPTY_DRAFT: AddDraft = {
  employeeNumber: '',
  firstName: '',
  lastName: '',
  email: '',
  department: 'FOH',
  employmentType: 'hourly-tipped',
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/**
 * Minimal create form. Everything else about a person is edited on the profile
 * screen — this only collects what `createEmployee()` genuinely requires, so
 * onboarding someone is never blocked on data nobody has yet.
 *
 * New people are created as `pending`: they exist on the roster but have no
 * linked sign-in until the invite is accepted (spec §2).
 */
function AddEmployeeModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (id: string) => void
}): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const fieldId = useId()

  const [draft, setDraft] = useState<AddDraft>(EMPTY_DRAFT)
  const [errors, setErrors] = useState<Partial<Record<keyof AddDraft, string>>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setDraft(EMPTY_DRAFT)
    setErrors({})
    void nextEmployeeNumber()
      .then((number) => setDraft((d) => ({ ...d, employeeNumber: number })))
      .catch(() => {
        /* leave blank; the field is editable and validated */
      })
  }, [open])

  function set<K extends keyof AddDraft>(key: K, value: AddDraft[K]): void {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  function validate(): boolean {
    const next: Partial<Record<keyof AddDraft, string>> = {}
    if (draft.firstName.trim() === '') next.firstName = t('people.add.errors.firstName')
    if (draft.lastName.trim() === '') next.lastName = t('people.add.errors.lastName')
    if (!EMAIL_RE.test(draft.email.trim())) next.email = t('people.add.errors.email')
    if (draft.employeeNumber.trim() === '') {
      next.employeeNumber = t('people.add.errors.employeeNumber')
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  async function submit(): Promise<void> {
    if (!validate()) return
    setSaving(true)
    try {
      const id = await createEmployee({
        employeeNumber: draft.employeeNumber.trim(),
        firstName: draft.firstName.trim(),
        lastName: draft.lastName.trim(),
        email: draft.email.trim().toLowerCase(),
        department: draft.department,
        employmentType: draft.employmentType,
        status: 'pending',
      })
      toast.show({ tone: 'success', message: t('people.toast.created') })
      onCreated(id)
    } catch {
      toast.show({ tone: 'error', message: t('people.toast.createFailed') })
    } finally {
      setSaving(false)
    }
  }

  const inputClass =
    'h-10 w-full rounded-control border border-line bg-page px-3 text-meta text-ink ' +
    'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary ' +
    'aria-[invalid=true]:border-danger'

  function field(
    key: keyof AddDraft,
    label: string,
    input: (props: {
      id: string
      'aria-invalid': boolean
      'aria-describedby': string | undefined
    }) => JSX.Element,
  ): JSX.Element {
    const id = `${fieldId}-${key}`
    const errorId = `${id}-error`
    const message = errors[key]
    return (
      <div>
        <label htmlFor={id} className="mb-1 block text-chip font-medium text-ink-muted">
          {label}
        </label>
        {input({
          id,
          'aria-invalid': message !== undefined,
          'aria-describedby': message !== undefined ? errorId : undefined,
        })}
        {message !== undefined ? (
          <p id={errorId} className="mt-1 text-chip text-danger">
            {message}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('people.add.title')}
      subtitle={t('people.add.subtitle')}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving}>
            {saving ? t('people.add.saving') : t('people.add.create')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {field('firstName', t('people.fields.firstName'), (props) => (
          <input
            {...props}
            type="text"
            className={inputClass}
            value={draft.firstName}
            onChange={(e) => set('firstName', e.target.value)}
          />
        ))}
        {field('lastName', t('people.fields.lastName'), (props) => (
          <input
            {...props}
            type="text"
            className={inputClass}
            value={draft.lastName}
            onChange={(e) => set('lastName', e.target.value)}
          />
        ))}
        {field('email', t('auth.email'), (props) => (
          <input
            {...props}
            type="email"
            className={inputClass}
            value={draft.email}
            onChange={(e) => set('email', e.target.value)}
          />
        ))}
        {field('employeeNumber', t('people.fields.employeeNumber'), (props) => (
          <input
            {...props}
            type="text"
            inputMode="numeric"
            className={`${inputClass} tabular`}
            value={draft.employeeNumber}
            onChange={(e) => set('employeeNumber', e.target.value)}
          />
        ))}
        {field('department', t('filters.department'), (props) => (
          <select
            {...props}
            className={inputClass}
            value={draft.department}
            onChange={(e) => set('department', e.target.value as Department)}
          >
            {DEPARTMENTS.map((d) => (
              <option key={d} value={d}>
                {t(`departments.${d}`)}
              </option>
            ))}
          </select>
        ))}
        {field('employmentType', t('people.fields.employmentType'), (props) => (
          <select
            {...props}
            className={inputClass}
            value={draft.employmentType}
            onChange={(e) => set('employmentType', e.target.value as EmploymentType)}
          >
            {EMPLOYMENT_TYPES.map((v) => (
              <option key={v} value={v}>
                {t(`employmentTypes.${v}`)}
              </option>
            ))}
          </select>
        ))}
      </div>
      <p className="mt-4 text-chip text-ink-muted">{t('people.add.note')}</p>
    </Modal>
  )
}

export default EmployeeListPage
