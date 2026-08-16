import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Modal, useToast } from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import {
  createShiftTemplate,
  deleteShiftTemplate,
  listShiftRoles,
  listShiftTemplates,
  updateShiftTemplate,
  type NewShiftTemplateInput,
} from '@/lib/db'
import { WEEKDAY_KEYS } from '@/types/models'
import type {
  ShiftRole,
  ShiftTemplate,
  ShiftTemplateRequirement,
  SkillLevel,
  WeekdayKey,
} from '@/types/models'

/**
 * Settings → Shift templates — spec §3/§6's day-part headcount + skill
 * requirements. No mockup exists for this screen (checked `.superdesign/
 * export/` and `.superdesign/pending/` — neither has it), so the layout
 * below is new design work, not a replication: a day-grouped list (mirroring
 * `weekdays.long` order, the same grouping the builder itself uses) with a
 * create/edit modal for the day-part's fields and its requirement lines.
 *
 * Gated on `schedule.edit`, NOT `settings.manage` — firestore.rules'
 * `shiftTemplates` match block ties writes to `schedule.edit` (the same
 * permission that edits the schedule itself), deliberately different from
 * `shiftRoles`' `settings.manage` gate. Whoever builds the schedule should be
 * able to adjust what a day-part needs; this is a scheduling concern more
 * than a settings one, even though it lives under Settings in the nav.
 *
 * Deleting a template needs no cross-reference warning (unlike deactivating
 * a ShiftRole — see RolesHierarchyPage's sibling warning): nothing else
 * points at a templateId (no shift, punch or trade references one), so a
 * template is safe to hard-delete with only a plain confirm.
 */

const SKILL_LEVELS: SkillLevel[] = [1, 2, 3]

const FIELD_CLASS =
  'h-10 w-full rounded-control border border-line bg-page px-3 text-meta text-ink ' +
  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary'

export function ShiftTemplatesPage(): JSX.Element {
  return (
    <RequirePermission permission="schedule.edit">
      <ShiftTemplatesScreen />
    </RequirePermission>
  )
}

function ShiftTemplatesScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()

  const [templates, setTemplates] = useState<ShiftTemplate[]>([])
  const [roles, setRoles] = useState<ShiftRole[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [modalTarget, setModalTarget] = useState<ShiftTemplate | 'new' | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<ShiftTemplate | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      // ALL roles, not just active — an existing requirement line may
      // reference a role that has since been deactivated, and it must still
      // render a real name rather than a bare id (see RolesHierarchyPage's
      // sibling warning for the other half of this: deactivating a role a
      // template still requires).
      const [tpls, roleCatalog] = await Promise.all([listShiftTemplates(), listShiftRoles()])
      setTemplates(tpls)
      setRoles(roleCatalog)
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
  const roleName = useCallback(
    (roleId: string) => {
      const r = rolesById.get(roleId)
      if (!r) return roleId
      return lang.startsWith('es') && r.nameEs ? r.nameEs : r.name
    },
    [rolesById, lang],
  )

  const byDay = useMemo(() => {
    const map = new Map<WeekdayKey, ShiftTemplate[]>()
    for (const key of WEEKDAY_KEYS) map.set(key, [])
    for (const tpl of templates) {
      const list = map.get(tpl.dayOfWeek) ?? []
      list.push(tpl)
      map.set(tpl.dayOfWeek, list)
    }
    for (const list of map.values()) list.sort((a, b) => a.startTime.localeCompare(b.startTime))
    return map
  }, [templates])

  function requirementsSummary(reqs: ShiftTemplateRequirement[]): string {
    if (reqs.length === 0) return t('settings.shiftTemplates.noRequirements')
    return reqs
      .map((r) =>
        t('settings.shiftTemplates.requirementLine', {
          count: r.count,
          role: roleName(r.roleId),
          level: r.minSkillLevel,
        }),
      )
      .join(', ')
  }

  async function handleDelete(): Promise<void> {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteShiftTemplate(deleteTarget.id)
      toast.show({
        tone: 'success',
        message: t('settings.shiftTemplates.toast.deleted', { name: deleteTarget.name }),
      })
      setDeleteTarget(null)
      await load()
    } catch {
      toast.show({ tone: 'error', message: t('settings.shiftTemplates.toast.deleteFailed') })
    } finally {
      setDeleting(false)
    }
  }

  const hasAnyTemplates = templates.length > 0

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">
            {t('settings.shiftTemplates.title')}
          </h1>
          <p className="mt-0.5 text-meta text-ink-muted">{t('settings.shiftTemplates.subtitle')}</p>
        </div>
        <Button variant="primary" onClick={() => setModalTarget('new')}>
          {t('settings.shiftTemplates.newTemplate')}
        </Button>
      </div>

      {loading ? (
        <div className="flex flex-col gap-1 rounded-card border border-line bg-page p-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-skeleton rounded-lg bg-app" />
          ))}
        </div>
      ) : loadError ? (
        <div className="rounded-card border border-line bg-page p-6 text-center">
          <p className="text-meta text-ink-muted">{t('settings.shiftTemplates.errorBody')}</p>
          <Button className="mt-3" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : !hasAnyTemplates ? (
        <div className="rounded-card border border-line bg-page p-6 text-center">
          <p className="text-meta text-ink-muted">{t('settings.shiftTemplates.emptyBody')}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {WEEKDAY_KEYS.map((day) => {
            const dayTemplates = byDay.get(day) ?? []
            if (dayTemplates.length === 0) return null
            return (
              <div key={day}>
                <h2 className="mb-2 text-meta font-semibold text-ink">{t(`weekdays.long.${day}`)}</h2>
                <div className="overflow-hidden rounded-card border border-line bg-page">
                  {dayTemplates.map((tpl) => (
                    <div
                      key={tpl.id}
                      className="flex flex-wrap items-center gap-4 border-b border-line px-4 py-3 last:border-b-0"
                    >
                      <div className="w-40 shrink-0">
                        <p className="truncate text-meta font-semibold text-ink">{tpl.name}</p>
                        <p className="tabular text-chip text-ink-muted">
                          {tpl.startTime}–{tpl.endTime}
                        </p>
                      </div>
                      <p className="min-w-0 flex-1 text-chip text-ink-muted">
                        {requirementsSummary(tpl.requirements)}
                      </p>
                      <div className="flex shrink-0 items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setModalTarget(tpl)}
                          className="text-chip font-medium text-ink-muted transition-colors duration-hover hover:text-ink"
                        >
                          {t('common.edit')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleteTarget(tpl)}
                          className="text-chip font-medium text-danger transition-colors duration-hover hover:text-danger"
                        >
                          {t('common.delete')}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {modalTarget !== null ? (
        <TemplateModal
          template={modalTarget === 'new' ? null : modalTarget}
          roles={roles}
          templates={templates}
          onClose={() => setModalTarget(null)}
          onSaved={() => {
            setModalTarget(null)
            void load()
          }}
        />
      ) : null}

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t('settings.shiftTemplates.deleteConfirm.title')}
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)} disabled={deleting}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" disabled={deleting} onClick={() => void handleDelete()}>
              {t('common.delete')}
            </Button>
          </>
        }
      >
        <p className="text-meta text-ink">
          {t('settings.shiftTemplates.deleteConfirm.body', { name: deleteTarget?.name ?? '' })}
        </p>
      </Modal>
    </div>
  )
}

/** A fresh, never-saved requirement row needs a stable React key that isn't an empty roleId. */
let nextRowKey = 0

interface RequirementRow extends ShiftTemplateRequirement {
  key: number
}

function toRows(reqs: ShiftTemplateRequirement[]): RequirementRow[] {
  return reqs.map((r) => ({ ...r, key: nextRowKey++ }))
}

function TemplateModal({
  template,
  roles,
  templates,
  onClose,
  onSaved,
}: {
  template: ShiftTemplate | null
  roles: ShiftRole[]
  templates: ShiftTemplate[]
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()
  const nameFieldId = useId()

  const [name, setName] = useState(template?.name ?? '')
  const [dayOfWeek, setDayOfWeek] = useState<WeekdayKey>(template?.dayOfWeek ?? 'mon')
  const [startTime, setStartTime] = useState(template?.startTime ?? '11:00')
  const [endTime, setEndTime] = useState(template?.endTime ?? '15:00')
  const [rows, setRows] = useState<RequirementRow[]>(() => toRows(template?.requirements ?? []))
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Rafa's instruction: "Settings UI gets the variant affordance. Keep it
  // small." — a template with a non-null dateRange IS a seasonal variant, so
  // editing one re-opens with the toggle pre-checked and its fields filled.
  const [isVariant, setIsVariant] = useState(Boolean(template?.dateRange))
  const [profileKey, setProfileKey] = useState(template?.profileKey ?? '')
  const [variantStartDate, setVariantStartDate] = useState(template?.dateRange?.startDate ?? '')
  const [variantEndDate, setVariantEndDate] = useState(template?.dateRange?.endDate ?? '')
  const [seasonLabel, setSeasonLabel] = useState(template?.seasonLabel ?? '')

  // profileKey MUST match an existing base template's profileKey to override
  // anything, so this is a select populated from the DISTINCT profileKey
  // values already on file — never a freeform text input that could typo its
  // way into silently not overriding the base it was meant to replace.
  const profileKeyOptions = useMemo(() => {
    const labelByKey = new Map<string, string>()
    for (const tpl of templates) {
      const isBase = tpl.dateRange === null
      if (!labelByKey.has(tpl.profileKey) || isBase) {
        labelByKey.set(tpl.profileKey, `${tpl.name} (${t(`weekdays.short.${tpl.dayOfWeek}`)})`)
      }
    }
    return Array.from(labelByKey.entries())
      .map(([key, label]) => ({ key, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [templates, t])

  const roleName = useCallback(
    (role: ShiftRole) => (lang.startsWith('es') && role.nameEs ? role.nameEs : role.name),
    [lang],
  )

  const sortedRoles = useMemo(
    () => [...roles].sort((a, b) => a.sortOrder - b.sortOrder),
    [roles],
  )

  function addRow(): void {
    setRows((prev) => [
      ...prev,
      { key: nextRowKey++, roleId: sortedRoles[0]?.id ?? '', count: 1, minSkillLevel: 1 },
    ])
  }

  function removeRow(key: number): void {
    setRows((prev) => prev.filter((r) => r.key !== key))
  }

  function updateRow(key: number, patch: Partial<ShiftTemplateRequirement>): void {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  async function handleSave(): Promise<void> {
    setError(null)
    const trimmedName = name.trim()
    if (!trimmedName) {
      setError(t('settings.shiftTemplates.modal.nameRequired'))
      return
    }
    if (rows.some((r) => !r.roleId)) {
      setError(t('settings.shiftTemplates.modal.roleRequired'))
      return
    }
    if (isVariant) {
      if (!profileKey) {
        setError(t('settings.shiftTemplates.modal.variant.profileKeyRequired'))
        return
      }
      if (!variantStartDate || !variantEndDate) {
        setError(t('settings.shiftTemplates.modal.variant.datesRequired'))
        return
      }
      if (variantStartDate > variantEndDate) {
        setError(t('settings.shiftTemplates.modal.variant.dateOrderInvalid'))
        return
      }
    }

    const requirements: ShiftTemplateRequirement[] = rows.map((r) => ({
      roleId: r.roleId,
      count: Math.max(1, Math.round(r.count)),
      minSkillLevel: r.minSkillLevel,
    }))

    setSaving(true)
    try {
      if (template) {
        // Off is the common case: reset profileKey to the doc's own id so it
        // fully detaches from any variant group rather than lingering as an
        // orphaned "base" for a profileKey some other variant still targets.
        const variantPatch = isVariant
          ? {
              profileKey,
              dateRange: { startDate: variantStartDate, endDate: variantEndDate },
              seasonLabel: seasonLabel.trim() || null,
            }
          : { profileKey: template.id, dateRange: null, seasonLabel: null }
        await updateShiftTemplate(template.id, {
          name: trimmedName,
          dayOfWeek,
          startTime,
          endTime,
          requirements,
          ...variantPatch,
        })
        toast.show({ tone: 'success', message: t('settings.shiftTemplates.toast.updated', { name: trimmedName }) })
      } else {
        // Off omits profileKey from the create call entirely so
        // createShiftTemplate defaults it to the new doc's own id.
        const input: NewShiftTemplateInput = { name: trimmedName, dayOfWeek, startTime, endTime, requirements }
        if (isVariant) {
          input.profileKey = profileKey
          input.dateRange = { startDate: variantStartDate, endDate: variantEndDate }
          input.seasonLabel = seasonLabel.trim() || null
        } else {
          input.dateRange = null
          input.seasonLabel = null
        }
        await createShiftTemplate(input)
        toast.show({ tone: 'success', message: t('settings.shiftTemplates.toast.created', { name: trimmedName }) })
      }
      onSaved()
    } catch {
      toast.show({
        tone: 'error',
        message: t(
          template ? 'settings.shiftTemplates.toast.updateFailed' : 'settings.shiftTemplates.toast.createFailed',
        ),
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
      title={t(template ? 'settings.shiftTemplates.modal.editTitle' : 'settings.shiftTemplates.modal.newTitle')}
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
        <div>
          <label htmlFor={nameFieldId} className="mb-1 block text-chip font-medium text-ink-muted">
            {t('settings.shiftTemplates.modal.name')}
          </label>
          <input
            id={nameFieldId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('settings.shiftTemplates.modal.namePlaceholder')}
            className={FIELD_CLASS}
          />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="mb-1 block text-chip font-medium text-ink-muted">
              {t('settings.shiftTemplates.modal.dayOfWeek')}
            </label>
            <select
              value={dayOfWeek}
              onChange={(e) => setDayOfWeek(e.target.value as WeekdayKey)}
              className={FIELD_CLASS}
            >
              {WEEKDAY_KEYS.map((day) => (
                <option key={day} value={day}>
                  {t(`weekdays.long.${day}`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-chip font-medium text-ink-muted">
              {t('settings.shiftTemplates.modal.startTime')}
            </label>
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              className={`${FIELD_CLASS} tabular`}
            />
          </div>
          <div>
            <label className="mb-1 block text-chip font-medium text-ink-muted">
              {t('settings.shiftTemplates.modal.endTime')}
            </label>
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              className={`${FIELD_CLASS} tabular`}
            />
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-chip font-medium text-ink-muted">
              {t('settings.shiftTemplates.modal.requirementsTitle')}
            </span>
            <button
              type="button"
              onClick={addRow}
              className="text-chip font-semibold text-primary transition-colors duration-hover hover:text-primary/80"
            >
              {t('settings.shiftTemplates.modal.addRequirement')}
            </button>
          </div>

          {rows.length === 0 ? (
            <p className="text-chip text-ink-muted">{t('settings.shiftTemplates.modal.noRequirementsYet')}</p>
          ) : (
            <div className="space-y-2">
              {rows.map((row) => {
                const currentRoleKnown = sortedRoles.some((r) => r.id === row.roleId)
                return (
                  <div key={row.key} className="flex items-center gap-2">
                    <select
                      value={row.roleId}
                      onChange={(e) => updateRow(row.key, { roleId: e.target.value })}
                      className={`${FIELD_CLASS} flex-1`}
                      aria-label={t('settings.shiftTemplates.modal.role')}
                    >
                      {!currentRoleKnown && row.roleId ? (
                        <option value={row.roleId}>{row.roleId}</option>
                      ) : null}
                      {sortedRoles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {roleName(role)}
                          {!role.active ? ` (${t('settings.roles.inactive')})` : ''}
                        </option>
                      ))}
                    </select>
                    <input
                      type="number"
                      min={1}
                      value={row.count}
                      onChange={(e) => updateRow(row.key, { count: Number(e.target.value) || 1 })}
                      className={`${FIELD_CLASS} w-20 tabular`}
                      aria-label={t('settings.shiftTemplates.modal.count')}
                    />
                    <select
                      value={row.minSkillLevel}
                      onChange={(e) => updateRow(row.key, { minSkillLevel: Number(e.target.value) as SkillLevel })}
                      className={`${FIELD_CLASS} w-28`}
                      aria-label={t('settings.shiftTemplates.modal.minSkillLevel')}
                    >
                      {SKILL_LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {t('settings.shiftTemplates.modal.minLevelOption', { level })}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => removeRow(row.key)}
                      aria-label={t('settings.shiftTemplates.modal.removeRequirement')}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control text-ink-muted hover:bg-app hover:text-danger"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="border-t border-line pt-4">
          <label className="flex items-center gap-2 text-chip font-medium text-ink-muted">
            <input
              type="checkbox"
              checked={isVariant}
              onChange={(e) => setIsVariant(e.target.checked)}
              className="h-5 w-5 rounded border-line text-primary focus:ring-primary"
            />
            {t('settings.shiftTemplates.modal.variant.toggle')}
          </label>
          <p className="mt-1 text-chip text-ink-muted">{t('settings.shiftTemplates.modal.variant.helper')}</p>

          {isVariant ? (
            <div className="mt-3 space-y-3">
              <div>
                <label className="mb-1 block text-chip font-medium text-ink-muted">
                  {t('settings.shiftTemplates.modal.variant.profileKey')}
                </label>
                <select
                  value={profileKey}
                  onChange={(e) => setProfileKey(e.target.value)}
                  className={FIELD_CLASS}
                >
                  <option value="">{t('settings.shiftTemplates.modal.variant.profileKeyPlaceholder')}</option>
                  {profileKeyOptions.map((opt) => (
                    <option key={opt.key} value={opt.key}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-chip font-medium text-ink-muted">
                    {t('settings.shiftTemplates.modal.variant.startDate')}
                  </label>
                  <input
                    type="date"
                    value={variantStartDate}
                    onChange={(e) => setVariantStartDate(e.target.value)}
                    className={`${FIELD_CLASS} tabular`}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-chip font-medium text-ink-muted">
                    {t('settings.shiftTemplates.modal.variant.endDate')}
                  </label>
                  <input
                    type="date"
                    value={variantEndDate}
                    onChange={(e) => setVariantEndDate(e.target.value)}
                    className={`${FIELD_CLASS} tabular`}
                  />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-chip font-medium text-ink-muted">
                  {t('settings.shiftTemplates.modal.variant.seasonLabel')}
                </label>
                <input
                  value={seasonLabel}
                  onChange={(e) => setSeasonLabel(e.target.value)}
                  placeholder={t('settings.shiftTemplates.modal.variant.seasonLabelPlaceholder')}
                  className={FIELD_CLASS}
                />
              </div>
            </div>
          ) : null}
        </div>

        {error ? <p className="text-chip font-medium text-danger">{error}</p> : null}
      </div>
    </Modal>
  )
}

function TrashIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" />
    </svg>
  )
}

export default ShiftTemplatesPage
