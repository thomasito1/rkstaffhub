import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Modal, Pill, useToast } from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import { addDaysToIsoDate } from '@/lib/deadlines'
import {
  listEmployees,
  listShifts,
  listShiftRoles,
  reorderShiftRoles,
  roleIdFromName,
  setCanCoverRoleIds,
  setShiftRoleActive,
  upsertShiftRole,
} from '@/lib/db'
import { weekIdFor } from '@/lib/format'
import { findCoverageCycle, findInvalidatedShifts, type RoleNode } from '@/lib/scheduling/roleHierarchy'
import type { Department, Employee, ShiftRole } from '@/types/models'

/**
 * Settings → Roles & hierarchy — mockup 32's layout, with one deliberate
 * deviation already ruled on (PROGRESS.md "Accepted spec deviations" A2):
 * NO "minimum skill level to cover" control. Coverage direction
 * (`canCoverRoleIds`, declared on the covering role) and skill level (on the
 * SHIFT, `requiredSkillLevel`) are the only two axes spec §7 defines — the
 * mockup's pill selector phrases coverage from the wrong direction and was
 * ruled a layout reference only on that one point.
 *
 * Reordering uses up/down buttons rather than the mockup's drag handle — no
 * drag-and-drop library is in the stack, and `reorderShiftRoles()` (already
 * built) just needs an ordered id list, which buttons produce as well as a
 * drag gesture does.
 */

const DEPARTMENTS: readonly Department[] = ['FOH', 'BOH', 'Admin'] as const

const SWATCHES = [
  '#F5A623', '#64748B', '#8B5CF6', '#F97316', '#06B6D4', '#22C55E', '#EC4899',
  '#14B8A6', '#A16207', '#7B4B2A', '#B45309', '#92400E', '#78716C', '#57534E',
] as const

export function RolesHierarchyPage(): JSX.Element {
  return (
    <RequirePermission permission="settings.manage">
      <RolesHierarchyScreen />
    </RequirePermission>
  )
}

function RolesHierarchyScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()

  const [roles, setRoles] = useState<ShiftRole[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [newRoleOpen, setNewRoleOpen] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const [r, e] = await Promise.all([listShiftRoles(), listEmployees({ status: 'active' })])
      setRoles(r)
      setEmployees(e)
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const sortedRoles = useMemo(
    () => [...roles].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [roles],
  )

  const employeeCountByRole = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of employees) {
      for (const sr of e.shiftRoles) m.set(sr.roleId, (m.get(sr.roleId) ?? 0) + 1)
    }
    return m
  }, [employees])

  const roleName = useCallback(
    (r: ShiftRole) => (lang.startsWith('es') && r.nameEs ? r.nameEs : r.name),
    [lang],
  )

  async function move(role: ShiftRole, dir: -1 | 1): Promise<void> {
    const idx = sortedRoles.findIndex((r) => r.id === role.id)
    const swapIdx = idx + dir
    if (swapIdx < 0 || swapIdx >= sortedRoles.length) return
    const reordered = [...sortedRoles]
    const tmp = reordered[idx]
    reordered[idx] = reordered[swapIdx] as ShiftRole
    reordered[swapIdx] = tmp as ShiftRole

    setBusyId(role.id)
    try {
      await reorderShiftRoles(reordered.map((r) => r.id))
      await load()
    } catch {
      toast.show({ tone: 'error', message: t('settings.roles.toast.reorderFailed') })
    } finally {
      setBusyId(null)
    }
  }

  async function toggleActive(role: ShiftRole): Promise<void> {
    setBusyId(role.id)
    const nextActive = !role.active
    try {
      await setShiftRoleActive(role.id, nextActive)
      toast.show({
        tone: 'success',
        message: t('settings.roles.toast.activeToggled', {
          role: roleName(role),
          state: t(nextActive ? 'settings.roles.active' : 'settings.roles.inactive'),
        }),
      })
      await load()
    } catch {
      toast.show({ tone: 'error', message: t('settings.roles.toast.activeToggleFailed') })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">
            {t('settings.roles.title')}
          </h1>
          <p className="mt-0.5 text-meta text-ink-muted">{t('settings.roles.subtitle')}</p>
        </div>
        <Button variant="primary" onClick={() => setNewRoleOpen(true)}>
          {t('settings.roles.newRole')}
        </Button>
      </div>

      <div className="mb-6 rounded-card border border-line bg-page p-4">
        <h2 className="text-meta font-semibold text-ink">{t('settings.roles.legend.title')}</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {(['l1', 'l2', 'l3'] as const).map((level, i) => (
            <div key={level} className="flex items-start gap-2">
              <span className="mt-0.5 flex h-5 w-6 shrink-0 items-center justify-center rounded bg-app text-[10px] font-bold text-ink">
                L{i + 1}
              </span>
              <p className="text-chip text-ink-muted">{t(`settings.roles.legend.${level}`)}</p>
            </div>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col gap-1 rounded-card border border-line bg-page p-1">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-16 animate-skeleton rounded-lg bg-app" />
          ))}
        </div>
      ) : loadError ? (
        <div className="rounded-card border border-line bg-page p-6 text-center">
          <p className="text-meta text-ink-muted">{t('settings.roles.errorBody')}</p>
          <Button className="mt-3" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-line bg-page">
          <div className="flex h-10 items-center gap-4 border-b border-line bg-app px-4 text-micro font-semibold uppercase text-ink-muted">
            <span className="w-16">{t('settings.roles.columns.order')}</span>
            <span className="flex-1">{t('settings.roles.columns.role')}</span>
            <span className="w-24">{t('settings.roles.columns.department')}</span>
            <span className="w-28">{t('settings.roles.columns.employees')}</span>
            <span className="w-56">{t('settings.roles.columns.canCover')}</span>
            <span className="w-24" />
          </div>

          {sortedRoles.map((role, index) => {
            const isExpanded = expandedId === role.id
            const busy = busyId === role.id
            const coverNames = role.canCoverRoleIds
              .map((id) => roles.find((r) => r.id === id))
              .filter((r): r is ShiftRole => r !== undefined)
              .map(roleName)

            return (
              <div key={role.id}>
                <div className="flex h-16 items-center gap-4 border-b border-line px-4 last:border-b-0">
                  <span className="flex w-16 items-center gap-1">
                    <button
                      type="button"
                      disabled={busy || index === 0}
                      aria-label={t('settings.roles.moveUp')}
                      onClick={() => void move(role, -1)}
                      className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-app disabled:opacity-30"
                    >
                      <Caret dir="up" />
                    </button>
                    <button
                      type="button"
                      disabled={busy || index === sortedRoles.length - 1}
                      aria-label={t('settings.roles.moveDown')}
                      onClick={() => void move(role, 1)}
                      className="flex h-6 w-6 items-center justify-center rounded text-ink-muted hover:bg-app disabled:opacity-30"
                    >
                      <Caret dir="down" />
                    </button>
                  </span>

                  <span className="flex flex-1 items-center gap-2 min-w-0">
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: role.color }}
                    />
                    <span className="truncate text-meta font-semibold text-ink">
                      {roleName(role)}
                    </span>
                    {!role.active ? <Pill tone="draft">{t('settings.roles.inactive')}</Pill> : null}
                  </span>

                  <span className="w-24">
                    <Pill tone="neutral">{t(`departments.${role.department}`)}</Pill>
                  </span>

                  <span className="tabular w-28 text-chip text-ink-muted">
                    {t('settings.roles.employeeCount', {
                      count: employeeCountByRole.get(role.id) ?? 0,
                    })}
                  </span>

                  <span className="w-56 truncate text-chip text-ink-muted">
                    {coverNames.length > 0 ? coverNames.join(', ') : t('settings.roles.coverage.none')}
                  </span>

                  <span className="flex w-24 items-center justify-end gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void toggleActive(role)}
                      className="text-chip font-medium text-ink-muted transition-colors duration-hover hover:text-ink disabled:opacity-40"
                    >
                      {t(role.active ? 'settings.roles.deactivate' : 'settings.roles.activate')}
                    </button>
                    <button
                      type="button"
                      aria-label={t(isExpanded ? 'settings.roles.collapse' : 'settings.roles.expand')}
                      aria-expanded={isExpanded}
                      onClick={() => setExpandedId(isExpanded ? null : role.id)}
                      className="flex h-8 w-8 items-center justify-center rounded text-ink-muted hover:bg-app"
                    >
                      <Caret dir={isExpanded ? 'up' : 'down'} />
                    </button>
                  </span>
                </div>

                {isExpanded ? (
                  <CoveragePanel
                    role={role}
                    allRoles={roles}
                    roleName={roleName}
                    onCancel={() => setExpandedId(null)}
                    onSaved={() => {
                      setExpandedId(null)
                      void load()
                    }}
                  />
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      <NewRoleModal
        open={newRoleOpen}
        existingIds={new Set(roles.map((r) => r.id))}
        onClose={() => setNewRoleOpen(false)}
        onCreated={() => {
          setNewRoleOpen(false)
          void load()
        }}
      />
    </div>
  )
}

/**
 * Expand-in-place coverage editor — mockup 32's "expanded Bartender row".
 * Save runs two independent checks before writing anything (spec change,
 * Rafa's ruling Aug 14 2026): a hard block for a coverage cycle (including
 * self-coverage, structurally impossible here since the role never lists
 * itself as an option, but checked anyway as a backstop), and a
 * confirm-with-warning if removing coverage would leave an already-
 * published, already-staffed shift held by someone no longer eligible for
 * it. The warning scan only runs when coverage actually SHRINKS — adding
 * coverage can never invalidate an existing assignment.
 */
function CoveragePanel({
  role,
  allRoles,
  roleName,
  onCancel,
  onSaved,
}: {
  role: ShiftRole
  allRoles: ShiftRole[]
  roleName: (r: ShiftRole) => string
  onCancel: () => void
  onSaved: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()

  const [selected, setSelected] = useState<Set<string>>(new Set(role.canCoverRoleIds))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmCount, setConfirmCount] = useState<number | null>(null)
  const [pendingSave, setPendingSave] = useState<string[] | null>(null)

  const otherRoles = useMemo(
    () => allRoles.filter((r) => r.id !== role.id).sort((a, b) => a.sortOrder - b.sortOrder),
    [allRoles, role.id],
  )

  function toggle(id: string): void {
    setError(null)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function commit(nextCoverIds: string[]): Promise<void> {
    setSaving(true)
    try {
      await setCanCoverRoleIds(role.id, nextCoverIds)
      toast.show({
        tone: 'success',
        message: t('settings.roles.toast.coverageSaved', { role: roleName(role) }),
      })
      onSaved()
    } catch {
      toast.show({ tone: 'error', message: t('settings.roles.toast.coverageFailed') })
    } finally {
      setSaving(false)
      setConfirmCount(null)
      setPendingSave(null)
    }
  }

  async function handleSave(): Promise<void> {
    setError(null)
    const nextCoverIds = [...selected]

    const roleNodes: RoleNode[] = allRoles.map((r) => ({ id: r.id, canCoverRoleIds: r.canCoverRoleIds }))
    const cycle = findCoverageCycle(roleNodes, role.id, nextCoverIds)
    if (cycle) {
      setError(
        t('settings.roles.coverage.cycle', {
          path: cycle.map((id) => allRoles.find((r) => r.id === id)?.name ?? id).join(' → '),
        }),
      )
      return
    }

    const removed = role.canCoverRoleIds.filter((id) => !selected.has(id))
    if (removed.length === 0) {
      await commit(nextCoverIds)
      return
    }

    setSaving(true)
    try {
      const canCoverRoleIds: Record<string, string[]> = {}
      for (const r of allRoles) canCoverRoleIds[r.id] = r.canCoverRoleIds

      const [employees, ...shiftsByWeek] = await Promise.all([
        listEmployees({ status: 'active' }),
        ...upcomingWeekIds().map((weekId) => listShifts(weekId)),
      ])
      const employeesById = new Map(employees.map((e) => [e.id, e]))
      const shifts = shiftsByWeek.flat()

      const affected = findInvalidatedShifts(shifts, employeesById, role.id, canCoverRoleIds, nextCoverIds)
      if (affected.length > 0) {
        setConfirmCount(affected.length)
        setPendingSave(nextCoverIds)
        setSaving(false)
        return
      }
      await commit(nextCoverIds)
    } catch {
      setSaving(false)
      toast.show({ tone: 'error', message: t('settings.roles.toast.coverageFailed') })
    }
  }

  return (
    <div
      className="border-b border-line bg-app p-4"
      style={{ borderLeft: `2px solid ${role.color}` }}
    >
      <h3 className="text-meta font-semibold text-ink">{t('settings.roles.coverage.title')}</h3>
      <p className="mt-0.5 text-chip text-ink-muted">
        {t('settings.roles.coverage.explainer', { role: roleName(role) })}
      </p>

      {otherRoles.length === 0 ? (
        <p className="mt-3 text-chip text-ink-muted">{t('settings.roles.coverage.noOtherRoles')}</p>
      ) : (
        <div className="mt-3 grid gap-1 sm:grid-cols-2">
          {otherRoles.map((r) => {
            const checked = selected.has(r.id)
            return (
              <label
                key={r.id}
                className={[
                  'flex items-center gap-2 rounded-control px-2 py-1.5 text-meta',
                  checked ? 'bg-success-tint text-ink' : 'text-ink',
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(r.id)}
                  className="h-4 w-4 rounded border-line text-primary focus:ring-primary"
                />
                <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
                {roleName(r)}
              </label>
            )
          })}
        </div>
      )}

      {error ? <p className="mt-3 text-chip font-medium text-danger">{error}</p> : null}

      <div className="mt-4 flex items-center gap-2">
        <Button variant="ghost" disabled={saving} onClick={onCancel}>
          {t('settings.roles.coverage.cancel')}
        </Button>
        <Button variant="primary" disabled={saving} onClick={() => void handleSave()}>
          {t('settings.roles.coverage.save')}
        </Button>
      </div>

      <Modal
        open={confirmCount !== null}
        onClose={() => {
          setConfirmCount(null)
          setPendingSave(null)
        }}
        title={t('settings.roles.coverage.confirmTitle')}
        footer={
          <>
            <Button onClick={() => { setConfirmCount(null); setPendingSave(null) }}>
              {t('settings.roles.coverage.confirmCancel')}
            </Button>
            <Button
              variant="danger"
              disabled={saving}
              onClick={() => pendingSave && void commit(pendingSave)}
            >
              {t('settings.roles.coverage.confirmProceed')}
            </Button>
          </>
        }
      >
        <p className="text-meta text-ink">
          {t('settings.roles.coverage.confirmBody', { count: confirmCount ?? 0 })}
        </p>
      </Modal>
    </div>
  )
}

/** Current week plus a near-term horizon — matches how far ahead a real week is ever published (spec §6: publish cadence is week-to-week). */
function upcomingWeekIds(): string[] {
  const start = weekIdFor(new Date())
  return Array.from({ length: 6 }, (_, i) => addDaysToIsoDate(start, i * 7))
}

function NewRoleModal({
  open,
  existingIds,
  onClose,
  onCreated,
}: {
  open: boolean
  existingIds: Set<string>
  onClose: () => void
  onCreated: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const nameFieldId = useId()
  const nameEsFieldId = useId()

  const [name, setName] = useState('')
  const [nameEs, setNameEs] = useState('')
  const [department, setDepartment] = useState<Department>('FOH')
  const [color, setColor] = useState<string>(SWATCHES[0])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName('')
      setNameEs('')
      setDepartment('FOH')
      setColor(SWATCHES[0])
      setError(null)
    }
  }, [open])

  const trimmedName = name.trim()
  const id = trimmedName ? roleIdFromName(trimmedName) : ''
  const valid = trimmedName !== '' && !existingIds.has(id)

  async function handleCreate(): Promise<void> {
    if (!valid) {
      setError(
        existingIds.has(id)
          ? t('settings.roles.newRoleModal.duplicate')
          : t('settings.roles.newRoleModal.nameRequired'),
      )
      return
    }
    setSaving(true)
    try {
      await upsertShiftRole({
        id,
        name: trimmedName,
        nameEs: nameEs.trim() || trimmedName,
        department,
        color,
        sortOrder: 999,
        active: true,
        canCoverRoleIds: [],
      })
      toast.show({ tone: 'success', message: t('settings.roles.toast.roleCreated', { role: trimmedName }) })
      onCreated()
    } catch {
      toast.show({ tone: 'error', message: t('settings.roles.toast.roleCreateFailed') })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('settings.roles.newRoleModal.title')}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void handleCreate()}>
            {t('settings.roles.newRoleModal.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor={nameFieldId} className="mb-1 block text-chip font-medium text-ink-muted">
            {t('settings.roles.newRoleModal.name')}
          </label>
          <input
            id={nameFieldId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-control border border-line bg-page px-3 py-2 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div>
          <label htmlFor={nameEsFieldId} className="mb-1 block text-chip font-medium text-ink-muted">
            {t('settings.roles.newRoleModal.nameEs')}
          </label>
          <input
            id={nameEsFieldId}
            value={nameEs}
            onChange={(e) => setNameEs(e.target.value)}
            className="w-full rounded-control border border-line bg-page px-3 py-2 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
        <div>
          <span className="mb-1 block text-chip font-medium text-ink-muted">
            {t('settings.roles.newRoleModal.department')}
          </span>
          <div className="flex gap-2">
            {DEPARTMENTS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDepartment(d)}
                className={[
                  'rounded-control border px-3 py-1.5 text-chip font-medium',
                  department === d
                    ? 'border-primary bg-primary-tint text-primary'
                    : 'border-line text-ink-muted hover:text-ink',
                ].join(' ')}
              >
                {t(`departments.${d}`)}
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="mb-1 block text-chip font-medium text-ink-muted">
            {t('settings.roles.newRoleModal.color')}
          </span>
          <div className="flex flex-wrap gap-2">
            {SWATCHES.map((swatch) => (
              <button
                key={swatch}
                type="button"
                aria-label={swatch}
                aria-pressed={color === swatch}
                onClick={() => setColor(swatch)}
                style={{ backgroundColor: swatch }}
                className={[
                  'h-7 w-7 rounded-full ring-2 ring-offset-2',
                  color === swatch ? 'ring-primary' : 'ring-transparent',
                ].join(' ')}
              />
            ))}
          </div>
        </div>
        {error ? <p className="text-chip font-medium text-danger">{error}</p> : null}
      </div>
    </Modal>
  )
}

function Caret({ dir }: { dir: 'up' | 'down' }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d={dir === 'up' ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
    </svg>
  )
}

export default RolesHierarchyPage
