import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Papa from 'papaparse'

import {
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
import type { PillTone } from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import {
  createTaskDefinition,
  listEmployees,
  listShiftRoles,
  listTaskDefinitions,
  listTaskInstancesForPeriod,
  setTaskDefinitionActive,
  updateTaskDefinition,
} from '@/lib/db'
import { RESTAURANT_TZ } from '@/lib/format'
import type {
  Department,
  Employee,
  ShiftRole,
  TaskAssignTo,
  TaskCadence,
  TaskDefinition,
  TaskInstance,
  TaskInstanceStatus,
} from '@/types/models'

/**
 * Settings → Tasks — mockup 28's Definitions table (bilingual title columns,
 * cadence/assigned-to chips, photo-proof glyph, active toggle, kebab) plus
 * two tabs the mockup only draws as inactive nav labels: Completion and
 * Archive. No mockup content exists for either, so both are new design work
 * within the existing tokens rather than a replication (same footing as
 * ShiftTemplatesPage's own layout).
 *
 * Gated on `tasks.manage` — firestore.rules ties BOTH read and write of the
 * `tasks` collection to this permission, so nothing here can ever run for a
 * viewer who lacks it (unlike `schedule.edit`-gated ShiftTemplatesPage, which
 * still reads shiftTemplates as a signed-in user gate).
 *
 * A definition is deactivated, never deleted — `taskInstances` reference
 * `taskDefId` (see db/tasks.ts's file header), the same lifecycle shiftRoles
 * uses and not shiftTemplates' plain-delete one. The kebab's only action is
 * that toggle, gated by a plain confirm — no cross-reference warning, unlike
 * RolesHierarchyPage's coverage-cycle/invalidated-shift checks: nothing else
 * needs to be told a task definition just went inactive.
 */

const DEPARTMENTS: readonly Department[] = ['FOH', 'BOH', 'Admin'] as const
const CADENCES: readonly TaskCadence[] = ['per-shift', 'daily', 'weekly', 'monthly'] as const
const ASSIGN_TO_TYPES: readonly TaskAssignTo['type'][] = ['role', 'department', 'employee'] as const
const ALL = 'all'

type Tab = 'definitions' | 'completion' | 'archive'

const CADENCE_TONE: Record<TaskCadence, PillTone> = {
  'per-shift': 'published',
  daily: 'approved',
  weekly: 'pending',
  monthly: 'draft',
}

const STATUS_TONE: Record<TaskInstanceStatus, PillTone> = {
  open: 'pending',
  done: 'approved',
  missed: 'declined',
}

const FIELD_CLASS =
  'h-10 w-full rounded-control border border-line bg-page px-3 text-meta text-ink ' +
  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary'

function todayIsoRestaurant(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: RESTAURANT_TZ }).format(new Date())
}

function employeeDisplayName(e: Pick<Employee, 'firstName' | 'lastName' | 'preferredName'>): string {
  const first = e.preferredName?.trim() ? e.preferredName : e.firstName
  return `${first} ${e.lastName}`.trim()
}

/** The department(s) a definition's assignment touches — used only for the Department filter, never persisted. */
function departmentsForDefinition(
  def: TaskDefinition,
  rolesById: Map<string, ShiftRole>,
  employeesById: Map<string, Employee>,
): Set<Department> {
  const set = new Set<Department>()
  if (def.assignTo.type === 'department') {
    for (const id of def.assignTo.ids) {
      if (id === 'FOH' || id === 'BOH' || id === 'Admin') set.add(id)
    }
  } else if (def.assignTo.type === 'role') {
    for (const id of def.assignTo.ids) {
      const role = rolesById.get(id)
      if (role) set.add(role.department)
    }
  } else {
    for (const id of def.assignTo.ids) {
      const emp = employeesById.get(id)
      if (emp) set.add(emp.department)
    }
  }
  return set
}

export function TaskManagerPage(): JSX.Element {
  return (
    <RequirePermission permission="tasks.manage">
      <TaskManagerScreen />
    </RequirePermission>
  )
}

function TaskManagerScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()

  const [tab, setTab] = useState<Tab>('definitions')
  const [definitions, setDefinitions] = useState<TaskDefinition[]>([])
  const [roles, setRoles] = useState<ShiftRole[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [todayInstances, setTodayInstances] = useState<TaskInstance[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const [modalTarget, setModalTarget] = useState<TaskDefinition | 'new' | null>(null)
  const [toggleTarget, setToggleTarget] = useState<TaskDefinition | null>(null)
  const [toggling, setToggling] = useState(false)

  const [departmentFilter, setDepartmentFilter] = useState(ALL)
  const [cadenceFilter, setCadenceFilter] = useState(ALL)
  const [roleFilter, setRoleFilter] = useState(ALL)
  const [search, setSearch] = useState('')
  const [activeOnly, setActiveOnly] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const [defs, roleCatalog, employeeCatalog, instances] = await Promise.all([
        listTaskDefinitions(),
        listShiftRoles(),
        listEmployees(),
        listTaskInstancesForPeriod(todayIsoRestaurant()),
      ])
      setDefinitions(defs)
      setRoles(roleCatalog)
      setEmployees(employeeCatalog)
      setTodayInstances(instances)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const rolesById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles])
  const employeesById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees])

  const roleName = useCallback(
    (r: ShiftRole) => (lang.startsWith('es') && r.nameEs ? r.nameEs : r.name),
    [lang],
  )
  const taskTitle = useCallback(
    (def: TaskDefinition) => (lang.startsWith('es') && def.titleEs ? def.titleEs : def.title),
    [lang],
  )

  const sortedActiveRoles = useMemo(
    () => roles.filter((r) => r.active).sort((a, b) => a.sortOrder - b.sortOrder),
    [roles],
  )

  const matchesFilters = useCallback(
    (def: TaskDefinition): boolean => {
      if (departmentFilter !== ALL && !departmentsForDefinition(def, rolesById, employeesById).has(departmentFilter as Department)) {
        return false
      }
      if (cadenceFilter !== ALL && def.cadence !== cadenceFilter) return false
      if (roleFilter !== ALL && !(def.assignTo.type === 'role' && def.assignTo.ids.includes(roleFilter))) return false
      const needle = search.trim().toLowerCase()
      if (needle) {
        const haystack = `${def.title} ${def.titleEs}`.toLowerCase()
        if (!haystack.includes(needle)) return false
      }
      return true
    },
    [departmentFilter, cadenceFilter, roleFilter, search, rolesById, employeesById],
  )

  const definitionRows = useMemo(() => {
    const base = activeOnly ? definitions.filter((d) => d.active) : definitions
    return base.filter(matchesFilters)
  }, [definitions, activeOnly, matchesFilters])

  const archiveRows = useMemo(() => definitions.filter((d) => !d.active), [definitions])

  const todayStats = useMemo(() => {
    const total = todayInstances.length
    const completed = todayInstances.filter((i) => i.status === 'done').length
    const missed = todayInstances.filter((i) => i.status === 'missed')
    const photoPending = todayInstances.filter((i) => i.requiresPhoto && i.status === 'done' && Boolean(i.photoPath))
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0
    return { total, completed, missed, photoPending, percent }
  }, [todayInstances])

  const filtersApplied =
    departmentFilter !== ALL || cadenceFilter !== ALL || roleFilter !== ALL || search.trim() !== ''

  function clearFilters(): void {
    setDepartmentFilter(ALL)
    setCadenceFilter(ALL)
    setRoleFilter(ALL)
    setSearch('')
  }

  async function handleToggleConfirmed(): Promise<void> {
    if (!toggleTarget) return
    const nextActive = !toggleTarget.active
    setToggling(true)
    try {
      await setTaskDefinitionActive(toggleTarget.id, nextActive)
      toast.show({
        tone: 'success',
        message: t(nextActive ? 'settings.tasks.toast.activated' : 'settings.tasks.toast.deactivated', {
          title: taskTitle(toggleTarget),
        }),
      })
      setToggleTarget(null)
      await load()
    } catch {
      toast.show({ tone: 'error', message: t('settings.tasks.toast.toggleFailed') })
    } finally {
      setToggling(false)
    }
  }

  function handleExportCsv(): void {
    let csvRows: Record<string, string>[]
    if (tab === 'completion') {
      csvRows = todayInstances.map((inst) => {
        const assignee = inst.assigneeEmployeeId ? employeesById.get(inst.assigneeEmployeeId) : null
        return {
          [t('settings.tasks.completion.columns.task')]: inst.title,
          [t('settings.tasks.completion.columns.assignee')]: assignee
            ? employeeDisplayName(assignee)
            : t('settings.tasks.completion.unclaimed'),
          [t('settings.tasks.completion.columns.status')]: t(`settings.tasks.status.${inst.status}`),
          [t('settings.tasks.completion.columns.department')]: t(`departments.${inst.department}`),
        }
      })
    } else {
      const rows = tab === 'archive' ? archiveRows : definitionRows
      csvRows = rows.map((def) => ({
        [t('settings.tasks.columns.taskEn')]: def.title,
        [t('settings.tasks.columns.taskEs')]: def.titleEs,
        [t('settings.tasks.columns.cadence')]: t(`settings.tasks.cadence.${def.cadence}`),
        [t('settings.tasks.columns.assignedTo')]: assignToSummary(def, rolesById, employeesById, t),
        [t('settings.tasks.columns.photoProof')]: def.requiresPhoto ? t('common.yes') : t('common.no'),
        [t('settings.tasks.columns.active')]: def.active ? t('common.yes') : t('common.no'),
      }))
    }
    const csv = Papa.unparse(csvRows)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tasks_${tab}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const TABS: { key: Tab; labelKey: string }[] = [
    { key: 'definitions', labelKey: 'settings.tasks.tabs.definitions' },
    { key: 'completion', labelKey: 'settings.tasks.tabs.completion' },
    { key: 'archive', labelKey: 'settings.tasks.tabs.archive' },
  ]

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">{t('settings.tasks.title')}</h1>
          <p className="mt-0.5 text-meta text-ink-muted">{t('settings.tasks.subtitle')}</p>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={handleExportCsv}>{t('settings.tasks.export')}</Button>
          <Button variant="primary" onClick={() => setModalTarget('new')}>
            {t('settings.tasks.newTask')}
          </Button>
        </div>
      </div>

      <nav className="mb-8 flex gap-8 border-b border-line">
        {TABS.map((tabDef) => (
          <button
            key={tabDef.key}
            type="button"
            onClick={() => setTab(tabDef.key)}
            className={[
              'border-b-2 pb-4 text-meta font-semibold transition-colors duration-hover',
              tab === tabDef.key ? 'border-primary text-ink' : 'border-transparent text-ink-muted hover:text-ink',
            ].join(' ')}
          >
            {t(tabDef.labelKey)}
          </button>
        ))}
      </nav>

      {loading ? (
        <div className="flex flex-col gap-1 rounded-card border border-line bg-page p-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-skeleton rounded-lg bg-app" />
          ))}
        </div>
      ) : loadError ? (
        <div className="rounded-card border border-line bg-page p-6 text-center">
          <p className="text-meta text-ink-muted">{t('settings.tasks.errorBody')}</p>
          <Button className="mt-3" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : tab === 'definitions' ? (
        <>
          <FilterBar className="mb-6">
            <FilterSelect
              label={t('filters.department')}
              value={departmentFilter}
              onChange={setDepartmentFilter}
              options={[
                { value: ALL, label: t('filters.allDepartments') },
                ...DEPARTMENTS.map((d) => ({ value: d, label: t(`departments.${d}`) })),
              ]}
            />
            <FilterSelect
              label={t('settings.tasks.filters.cadence')}
              value={cadenceFilter}
              onChange={setCadenceFilter}
              options={[
                { value: ALL, label: t('settings.tasks.filters.allCadences') },
                ...CADENCES.map((c) => ({ value: c, label: t(`settings.tasks.cadence.${c}`) })),
              ]}
            />
            <FilterSelect
              label={t('settings.tasks.filters.assignedTo')}
              value={roleFilter}
              onChange={setRoleFilter}
              options={[
                { value: ALL, label: t('filters.allRoles') },
                ...sortedActiveRoles.map((r) => ({ value: r.id, label: roleName(r) })),
              ]}
            />
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t('settings.tasks.filters.searchPlaceholder')}
            />
            <label className="ml-auto flex items-center gap-2 text-meta font-medium text-ink">
              {t('settings.tasks.filters.activeOnly')}
              <Switch
                checked={activeOnly}
                onChange={setActiveOnly}
                label={t('settings.tasks.filters.activeOnly')}
              />
            </label>
          </FilterBar>

          {definitionRows.length === 0 ? (
            <EmptyState
              illustration="tasks"
              title={filtersApplied ? t('empty.noResults') : t('settings.tasks.emptyTitle')}
              body={filtersApplied ? t('empty.noResultsBody') : t('settings.tasks.emptyBody')}
              action={filtersApplied ? <Button onClick={clearFilters}>{t('common.clearFilters')}</Button> : undefined}
            />
          ) : (
            <Table>
              <DefinitionsHeader t={t} />
              {definitionRows.map((def) => (
                <DefinitionRow
                  key={def.id}
                  def={def}
                  rolesById={rolesById}
                  employeesById={employeesById}
                  lang={lang}
                  t={t}
                  onEdit={() => setModalTarget(def)}
                  onToggleRequest={() => setToggleTarget(def)}
                />
              ))}
            </Table>
          )}
        </>
      ) : tab === 'completion' ? (
        <>
          <div className="mb-8 grid grid-cols-1 gap-6 md:grid-cols-3">
            <div className="rounded-card border border-line bg-page p-5">
              <h3 className="mb-2 text-micro font-semibold uppercase tracking-wider text-ink-muted">
                {t('settings.tasks.completion.completedToday')}
              </h3>
              <p className="tabular mb-3 text-[34px] font-semibold leading-none text-ink">
                {todayStats.completed} / {todayStats.total}
              </p>
              <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-line">
                <div className="h-full rounded-full bg-success" style={{ width: `${todayStats.percent}%` }} />
              </div>
              <p className="text-chip text-ink-muted">
                {t('settings.tasks.completion.percentComplete', { percent: todayStats.percent })}
              </p>
            </div>

            <div className="rounded-card border border-line bg-page p-5">
              <h3 className="mb-2 text-micro font-semibold uppercase tracking-wider text-ink-muted">
                {t('settings.tasks.completion.missedToday')}
              </h3>
              <p className="tabular mb-3 text-[34px] font-semibold leading-none text-danger">
                {todayStats.missed.length}
              </p>
              <p className="text-chip text-ink-muted">
                {todayStats.missed.length > 0
                  ? todayStats.missed.map((i) => i.title).join(', ')
                  : t('settings.tasks.completion.noneMissed')}
              </p>
            </div>

            <div className="rounded-card border border-line bg-page p-5">
              <h3 className="mb-2 text-micro font-semibold uppercase tracking-wider text-ink-muted">
                {t('settings.tasks.completion.photoProofPending')}
              </h3>
              <p className="tabular mb-3 text-[34px] font-semibold leading-none text-warning">
                {todayStats.photoPending.length}
              </p>
              <p className="text-chip text-ink-muted">{t('settings.tasks.completion.awaitingReview')}</p>
            </div>
          </div>

          {todayInstances.length === 0 ? (
            <EmptyState
              illustration="tasks"
              title={t('settings.tasks.completion.emptyTitle')}
              body={t('settings.tasks.completion.emptyBody')}
            />
          ) : (
            <Table>
              <TableHead>
                <TableCell className="flex-1">{t('settings.tasks.completion.columns.task')}</TableCell>
                <TableCell className="w-48">{t('settings.tasks.completion.columns.assignee')}</TableCell>
                <TableCell className="w-32">{t('settings.tasks.completion.columns.status')}</TableCell>
                <TableCell className="w-28">{t('settings.tasks.completion.columns.department')}</TableCell>
              </TableHead>
              {todayInstances.map((inst) => (
                <TableRow key={inst.id}>
                  <TableCell className="flex-1">
                    <span className="truncate text-meta font-medium text-ink">{inst.title}</span>
                  </TableCell>
                  <TableCell className="w-48">
                    {inst.assigneeEmployeeId && employeesById.get(inst.assigneeEmployeeId) ? (
                      <span className="truncate text-meta text-ink">
                        {employeeDisplayName(employeesById.get(inst.assigneeEmployeeId) as Employee)}
                      </span>
                    ) : (
                      <span className="text-meta italic text-ink-muted">
                        {t('settings.tasks.completion.unclaimed')}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="w-32">
                    <Pill tone={STATUS_TONE[inst.status]}>{t(`settings.tasks.status.${inst.status}`)}</Pill>
                  </TableCell>
                  <TableCell className="w-28">
                    <Pill tone="neutral">{t(`departments.${inst.department}`)}</Pill>
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          )}
        </>
      ) : archiveRows.length === 0 ? (
        <EmptyState
          illustration="tasks"
          title={t('settings.tasks.archive.emptyTitle')}
          body={t('settings.tasks.archive.emptyBody')}
        />
      ) : (
        <Table>
          <DefinitionsHeader t={t} />
          {archiveRows.map((def) => (
            <DefinitionRow
              key={def.id}
              def={def}
              rolesById={rolesById}
              employeesById={employeesById}
              lang={lang}
              t={t}
              onEdit={() => setModalTarget(def)}
              onToggleRequest={() => setToggleTarget(def)}
            />
          ))}
        </Table>
      )}

      {modalTarget !== null ? (
        <TaskModal
          definition={modalTarget === 'new' ? null : modalTarget}
          roles={roles}
          employees={employees}
          onClose={() => setModalTarget(null)}
          onSaved={() => {
            setModalTarget(null)
            void load()
          }}
        />
      ) : null}

      <Modal
        open={toggleTarget !== null}
        onClose={() => setToggleTarget(null)}
        title={t(
          toggleTarget?.active ? 'settings.tasks.deactivateConfirm.title' : 'settings.tasks.activateConfirm.title',
        )}
        footer={
          <>
            <Button onClick={() => setToggleTarget(null)} disabled={toggling}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={toggleTarget?.active ? 'danger' : 'primary'}
              disabled={toggling}
              onClick={() => void handleToggleConfirmed()}
            >
              {t(toggleTarget?.active ? 'settings.tasks.deactivate' : 'settings.tasks.activate')}
            </Button>
          </>
        }
      >
        <p className="text-meta text-ink">
          {t(
            toggleTarget?.active ? 'settings.tasks.deactivateConfirm.body' : 'settings.tasks.activateConfirm.body',
            { title: toggleTarget ? taskTitle(toggleTarget) : '' },
          )}
        </p>
      </Modal>
    </div>
  )
}

function assignToSummary(
  def: TaskDefinition,
  rolesById: Map<string, ShiftRole>,
  employeesById: Map<string, Employee>,
  t: TFunction,
): string {
  if (def.assignTo.type === 'role') {
    return def.assignTo.ids.map((id) => rolesById.get(id)?.name ?? id).join('; ')
  }
  if (def.assignTo.type === 'department') {
    return def.assignTo.ids.map((id) => t(`departments.${id}`)).join('; ')
  }
  return def.assignTo.ids
    .map((id) => {
      const emp = employeesById.get(id)
      return emp ? employeeDisplayName(emp) : id
    })
    .join('; ')
}

function DefinitionsHeader({ t }: { t: TFunction }): JSX.Element {
  return (
    <TableHead>
      <TableCell className="min-w-[160px] flex-1">{t('settings.tasks.columns.taskEn')}</TableCell>
      <TableCell className="min-w-[160px] flex-1">{t('settings.tasks.columns.taskEs')}</TableCell>
      <TableCell className="w-28">{t('settings.tasks.columns.cadence')}</TableCell>
      <TableCell className="w-48">{t('settings.tasks.columns.assignedTo')}</TableCell>
      <TableCell className="w-24 justify-center">{t('settings.tasks.columns.photoProof')}</TableCell>
      <TableCell className="w-16 justify-center">{t('settings.tasks.columns.active')}</TableCell>
      <TableCell className="w-10" />
    </TableHead>
  )
}

function AssignedToChips({
  assignTo,
  rolesById,
  employeesById,
  lang,
  t,
}: {
  assignTo: TaskAssignTo
  rolesById: Map<string, ShiftRole>
  employeesById: Map<string, Employee>
  lang: string
  t: TFunction
}): JSX.Element {
  if (assignTo.type === 'role') {
    return (
      <div className="flex flex-wrap gap-1">
        {assignTo.ids.map((id) => {
          const role = rolesById.get(id)
          if (!role) {
            return (
              <Pill key={id} tone="neutral">
                {id}
              </Pill>
            )
          }
          return (
            <span
              key={id}
              className="inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-1 text-chip font-semibold uppercase tracking-tight"
              style={{ backgroundColor: `${role.color}1A`, color: role.color }}
            >
              {lang.startsWith('es') && role.nameEs ? role.nameEs : role.name}
            </span>
          )
        })}
      </div>
    )
  }
  if (assignTo.type === 'department') {
    return (
      <div className="flex flex-wrap gap-1">
        {assignTo.ids.map((id) => (
          <Pill key={id} tone="neutral">
            {t(`departments.${id}`)}
          </Pill>
        ))}
      </div>
    )
  }
  return (
    <div className="flex flex-wrap gap-1">
      {assignTo.ids.map((id) => {
        const emp = employeesById.get(id)
        return (
          <Pill key={id} tone="neutral">
            {emp ? employeeDisplayName(emp) : id}
          </Pill>
        )
      })}
    </div>
  )
}

function CameraIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M3 8a2 2 0 0 1 2-2h1.5l1-1.5h5l1 1.5H16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <circle cx="10.5" cy="12.5" r="3" />
    </svg>
  )
}

/** Compact switch — same button-only markup as EmployeeProfilePage's labeled `Toggle`, without the label wrapper, for use inline in a table cell or filter bar. */
function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
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
  )
}

function DefinitionRow({
  def,
  rolesById,
  employeesById,
  lang,
  t,
  onEdit,
  onToggleRequest,
}: {
  def: TaskDefinition
  rolesById: Map<string, ShiftRole>
  employeesById: Map<string, Employee>
  lang: string
  t: TFunction
  onEdit: () => void
  onToggleRequest: () => void
}): JSX.Element {
  return (
    <TableRow onClick={onEdit} className={!def.active ? 'opacity-55' : ''}>
      <TableCell className="min-w-[160px] flex-1">
        <span className="truncate text-meta font-medium text-ink">{def.title}</span>
      </TableCell>
      <TableCell className="min-w-[160px] flex-1">
        <span className="truncate text-meta text-ink-muted">{def.titleEs}</span>
      </TableCell>
      <TableCell className="w-28">
        <Pill tone={CADENCE_TONE[def.cadence]}>{t(`settings.tasks.cadence.${def.cadence}`)}</Pill>
      </TableCell>
      <TableCell className="w-48">
        <AssignedToChips assignTo={def.assignTo} rolesById={rolesById} employeesById={employeesById} lang={lang} t={t} />
      </TableCell>
      <TableCell className="w-24 justify-center">
        {def.requiresPhoto ? (
          <span className="text-success" aria-label={t('settings.tasks.columns.photoProof')}>
            <CameraIcon />
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        )}
      </TableCell>
      <TableCell className="w-16 justify-center">
        <div onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={def.active}
            onChange={() => onToggleRequest()}
            label={t(def.active ? 'settings.tasks.deactivate' : 'settings.tasks.activate')}
          />
        </div>
      </TableCell>
      <TableCell className="w-10" align="right">
        <div onClick={(e) => e.stopPropagation()}>
          <KebabMenu
            items={[
              {
                label: t(def.active ? 'settings.tasks.deactivate' : 'settings.tasks.activate'),
                onClick: onToggleRequest,
              },
            ]}
          />
        </div>
      </TableCell>
    </TableRow>
  )
}

function TaskModal({
  definition,
  roles,
  employees,
  onClose,
  onSaved,
}: {
  definition: TaskDefinition | null
  roles: ShiftRole[]
  employees: Employee[]
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()
  const titleFieldId = useId()
  const titleEsFieldId = useId()
  const descriptionFieldId = useId()
  const descriptionEsFieldId = useId()
  const dueRuleFieldId = useId()

  const [title, setTitle] = useState(definition?.title ?? '')
  const [titleEs, setTitleEs] = useState(definition?.titleEs ?? '')
  const [description, setDescription] = useState(definition?.description ?? '')
  const [descriptionEs, setDescriptionEs] = useState(definition?.descriptionEs ?? '')
  const [cadence, setCadence] = useState<TaskCadence>(definition?.cadence ?? 'daily')
  const [assignToType, setAssignToType] = useState<TaskAssignTo['type']>(definition?.assignTo.type ?? 'role')
  const [assignToIds, setAssignToIds] = useState<Set<string>>(new Set(definition?.assignTo.ids ?? []))
  const [dueRule, setDueRule] = useState(definition?.dueRule ?? '')
  const [requiresPhoto, setRequiresPhoto] = useState(definition?.requiresPhoto ?? false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const roleName = useCallback(
    (r: ShiftRole) => (lang.startsWith('es') && r.nameEs ? r.nameEs : r.name),
    [lang],
  )

  const sortedRoles = useMemo(() => [...roles].sort((a, b) => a.sortOrder - b.sortOrder), [roles])
  const sortedEmployees = useMemo(
    () => [...employees].sort((a, b) => employeeDisplayName(a).localeCompare(employeeDisplayName(b))),
    [employees],
  )

  function toggleAssignId(id: string): void {
    setAssignToIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function changeAssignToType(type: TaskAssignTo['type']): void {
    setAssignToType(type)
    setAssignToIds(new Set())
  }

  async function handleSave(): Promise<void> {
    setError(null)
    const trimmedTitle = title.trim()
    const trimmedTitleEs = titleEs.trim()
    const trimmedDescription = description.trim()
    const trimmedDescriptionEs = descriptionEs.trim()
    const trimmedDueRule = dueRule.trim()

    if (!trimmedTitle || !trimmedTitleEs) {
      setError(t('settings.tasks.modal.titleRequired'))
      return
    }
    if (!trimmedDescription || !trimmedDescriptionEs) {
      setError(t('settings.tasks.modal.descriptionRequired'))
      return
    }
    if (!trimmedDueRule) {
      setError(t('settings.tasks.modal.dueRuleRequired'))
      return
    }
    if (assignToIds.size === 0) {
      setError(t('settings.tasks.modal.assignToRequired'))
      return
    }

    const assignTo: TaskAssignTo = { type: assignToType, ids: [...assignToIds] }

    setSaving(true)
    try {
      if (definition) {
        await updateTaskDefinition(definition.id, {
          title: trimmedTitle,
          titleEs: trimmedTitleEs,
          description: trimmedDescription,
          descriptionEs: trimmedDescriptionEs,
          cadence,
          assignTo,
          dueRule: trimmedDueRule,
          requiresPhoto,
        })
        toast.show({ tone: 'success', message: t('settings.tasks.toast.updated', { title: trimmedTitle }) })
      } else {
        await createTaskDefinition({
          title: trimmedTitle,
          titleEs: trimmedTitleEs,
          description: trimmedDescription,
          descriptionEs: trimmedDescriptionEs,
          cadence,
          assignTo,
          dueRule: trimmedDueRule,
          requiresPhoto,
        })
        toast.show({ tone: 'success', message: t('settings.tasks.toast.created', { title: trimmedTitle }) })
      }
      onSaved()
    } catch {
      toast.show({
        tone: 'error',
        message: t(definition ? 'settings.tasks.toast.updateFailed' : 'settings.tasks.toast.createFailed'),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={640}
      title={t(definition ? 'settings.tasks.modal.editTitle' : 'settings.tasks.modal.newTitle')}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void handleSave()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor={titleFieldId} className="mb-1 block text-chip font-medium text-ink-muted">
              {t('settings.tasks.modal.title')}
            </label>
            <input id={titleFieldId} value={title} onChange={(e) => setTitle(e.target.value)} className={FIELD_CLASS} />
          </div>
          <div>
            <label htmlFor={titleEsFieldId} className="mb-1 block text-chip font-medium text-ink-muted">
              {t('settings.tasks.modal.titleEs')}
            </label>
            <input
              id={titleEsFieldId}
              value={titleEs}
              onChange={(e) => setTitleEs(e.target.value)}
              className={FIELD_CLASS}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor={descriptionFieldId} className="mb-1 block text-chip font-medium text-ink-muted">
              {t('settings.tasks.modal.description')}
            </label>
            <textarea
              id={descriptionFieldId}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className={`${FIELD_CLASS} h-auto py-2`}
            />
          </div>
          <div>
            <label htmlFor={descriptionEsFieldId} className="mb-1 block text-chip font-medium text-ink-muted">
              {t('settings.tasks.modal.descriptionEs')}
            </label>
            <textarea
              id={descriptionEsFieldId}
              value={descriptionEs}
              onChange={(e) => setDescriptionEs(e.target.value)}
              rows={3}
              className={`${FIELD_CLASS} h-auto py-2`}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-chip font-medium text-ink-muted">
              {t('settings.tasks.modal.cadence')}
            </label>
            <select value={cadence} onChange={(e) => setCadence(e.target.value as TaskCadence)} className={FIELD_CLASS}>
              {CADENCES.map((c) => (
                <option key={c} value={c}>
                  {t(`settings.tasks.cadence.${c}`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={dueRuleFieldId} className="mb-1 block text-chip font-medium text-ink-muted">
              {t('settings.tasks.modal.dueRule')}
            </label>
            <input
              id={dueRuleFieldId}
              value={dueRule}
              onChange={(e) => setDueRule(e.target.value)}
              placeholder={t('settings.tasks.modal.dueRulePlaceholder')}
              className={FIELD_CLASS}
            />
          </div>
        </div>

        <div>
          <span className="mb-1 block text-chip font-medium text-ink-muted">{t('settings.tasks.modal.assignTo')}</span>
          <div className="mb-3 flex gap-2">
            {ASSIGN_TO_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => changeAssignToType(type)}
                className={[
                  'rounded-control border px-3 py-1.5 text-chip font-medium',
                  assignToType === type
                    ? 'border-primary bg-primary-tint text-primary'
                    : 'border-line text-ink-muted hover:text-ink',
                ].join(' ')}
              >
                {t(`settings.tasks.modal.assignToType.${type}`)}
              </button>
            ))}
          </div>

          {assignToType === 'department' ? (
            <div className="flex gap-2">
              {DEPARTMENTS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setAssignToIds(new Set([d]))}
                  className={[
                    'rounded-control border px-3 py-1.5 text-chip font-medium',
                    assignToIds.has(d)
                      ? 'border-primary bg-primary-tint text-primary'
                      : 'border-line text-ink-muted hover:text-ink',
                  ].join(' ')}
                >
                  {t(`departments.${d}`)}
                </button>
              ))}
            </div>
          ) : assignToType === 'role' ? (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-control border border-line p-2">
              {sortedRoles.map((role) => {
                const checked = assignToIds.has(role.id)
                return (
                  <label
                    key={role.id}
                    className={[
                      'flex items-center gap-2 rounded-control px-2 py-1.5 text-meta',
                      checked ? 'bg-success-tint text-ink' : 'text-ink',
                    ].join(' ')}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleAssignId(role.id)}
                      className="h-4 w-4 rounded border-line text-primary focus:ring-primary"
                    />
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: role.color }}
                    />
                    {roleName(role)}
                    {!role.active ? ` (${t('settings.roles.inactive')})` : ''}
                  </label>
                )
              })}
            </div>
          ) : (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-control border border-line p-2">
              {sortedEmployees.map((emp) => {
                const checked = assignToIds.has(emp.id)
                return (
                  <label
                    key={emp.id}
                    className={[
                      'flex items-center gap-2 rounded-control px-2 py-1.5 text-meta',
                      checked ? 'bg-success-tint text-ink' : 'text-ink',
                    ].join(' ')}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleAssignId(emp.id)}
                      className="h-4 w-4 rounded border-line text-primary focus:ring-primary"
                    />
                    {employeeDisplayName(emp)}
                    {emp.status !== 'active' ? ` (${t('status.inactive')})` : ''}
                  </label>
                )
              })}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-4 rounded-control border border-line px-3 py-2.5">
          <div className="flex flex-col">
            <span className="text-meta font-medium text-ink">{t('settings.tasks.modal.requiresPhoto')}</span>
            <span className="text-chip text-ink-muted">{t('settings.tasks.modal.requiresPhotoHint')}</span>
          </div>
          <Switch
            checked={requiresPhoto}
            onChange={setRequiresPhoto}
            label={t('settings.tasks.modal.requiresPhoto')}
          />
        </div>

        {error ? <p className="text-chip font-medium text-danger">{error}</p> : null}
      </div>
    </Modal>
  )
}

export default TaskManagerPage
