import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { EmployeeShiftRole, ShiftRole, SkillLevel } from '@/types/models'

/**
 * Shift roles & skill levels editor — mockup 04, card D.
 *
 * One card per assigned role: color dot, role name, "Primary role" badge, a
 * remove button, and an L1/L2/L3 picker. Levels mean L1 trainee · L2
 * independent · L3 can train others (spec §6/§7 — `requiredSkillLevel` on a
 * shift is compared against these).
 *
 * ROLE COLOURS are runtime values from `shiftRoles/{id}.color` (admin-editable,
 * spec §6), so they are applied as inline styles. Tailwind cannot express a
 * dynamic colour — see the note at the top of tailwind.config.js.
 *
 * Read-only mode is a real mode, not a disabled form: a manager without
 * `employees.rankSkills` still needs to SEE what someone is ranked at.
 */

const LEVELS: readonly SkillLevel[] = [1, 2, 3] as const

export interface ShiftRolesEditorProps {
  /** The full `shiftRoles` catalog, for names, colours and the add picker. */
  catalog: ShiftRole[]
  value: EmployeeShiftRole[]
  onChange?: (next: EmployeeShiftRole[]) => void
  /** True when the viewer may not change rankings. */
  readOnly?: boolean
}

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

export function ShiftRolesEditor({
  catalog,
  value,
  onChange,
  readOnly = false,
}: ShiftRolesEditorProps): JSX.Element {
  const { t, i18n } = useTranslation()
  const [adding, setAdding] = useState(false)

  const isSpanish = i18n.language.startsWith('es')
  const nameOf = (role: ShiftRole): string => (isSpanish ? role.nameEs : role.name)

  const catalogById = useMemo(
    () => new Map(catalog.map((r) => [r.id, r])),
    [catalog],
  )

  const unassigned = useMemo(
    () =>
      catalog.filter(
        (r) => r.active && !value.some((assigned) => assigned.roleId === r.id),
      ),
    [catalog, value],
  )

  function emit(next: EmployeeShiftRole[]): void {
    onChange?.(next)
  }

  function setLevel(roleId: string, skillLevel: SkillLevel): void {
    emit(value.map((r) => (r.roleId === roleId ? { ...r, skillLevel } : r)))
  }

  function setPrimary(roleId: string): void {
    emit(value.map((r) => ({ ...r, isPrimary: r.roleId === roleId })))
  }

  function remove(roleId: string): void {
    const kept = value.filter((r) => r.roleId !== roleId)
    // Never leave a person with roles but no primary — the schedule builder
    // and the roster chips both lead with it.
    const next = kept.some((r) => r.isPrimary)
      ? kept
      : kept.map((r, index) => (index === 0 ? { ...r, isPrimary: true } : r))
    emit(next)
  }

  function add(roleId: string): void {
    if (roleId === '') return
    setAdding(false)
    emit([
      ...value,
      { roleId, skillLevel: 1, isPrimary: value.length === 0 },
    ])
  }

  return (
    <section className="rounded-card border border-line bg-page p-6">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-section font-semibold text-ink">
          {t('people.shiftRoles.title')}
        </h2>
        {!readOnly && unassigned.length > 0 ? (
          <button
            type="button"
            onClick={() => setAdding((open) => !open)}
            aria-expanded={adding}
            className="text-meta font-semibold text-primary hover:underline"
          >
            {t('people.shiftRoles.addRole')}
          </button>
        ) : null}
      </div>

      {adding && !readOnly ? (
        <div className="mb-4">
          <label
            htmlFor="shift-roles-add"
            className="mb-1 block text-chip font-medium text-ink-muted"
          >
            {t('people.shiftRoles.pickRole')}
          </label>
          <select
            id="shift-roles-add"
            defaultValue=""
            onChange={(e) => add(e.target.value)}
            className="h-10 w-full rounded-control border border-line bg-page px-3 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          >
            <option value="">{t('people.shiftRoles.pickRolePlaceholder')}</option>
            {unassigned.map((role) => (
              <option key={role.id} value={role.id}>
                {nameOf(role)}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {value.length === 0 ? (
        <p className="rounded-control border border-dashed border-line px-4 py-6 text-center text-meta text-ink-muted">
          {t('people.shiftRoles.none')}
        </p>
      ) : (
        <ul className="space-y-3">
          {value.map((assigned) => {
            const role = catalogById.get(assigned.roleId)
            const label = role ? nameOf(role) : assigned.roleId
            const groupLabel = t('people.shiftRoles.levelForRole', { role: label })

            return (
              <li
                key={assigned.roleId}
                className="rounded-control border border-line p-4"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {/* Runtime colour → inline style. A role that is no longer
                        in the catalog gets the neutral token instead. */}
                    {role ? (
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: role.color }}
                        aria-hidden="true"
                      />
                    ) : (
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full bg-ink-muted"
                        aria-hidden="true"
                      />
                    )}
                    <span className="truncate text-meta font-semibold text-ink">
                      {label}
                    </span>
                    {assigned.isPrimary ? (
                      <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-micro font-medium text-ink-muted">
                        {t('people.shiftRoles.primary')}
                      </span>
                    ) : !readOnly ? (
                      <button
                        type="button"
                        onClick={() => setPrimary(assigned.roleId)}
                        className="shrink-0 text-micro font-semibold text-primary hover:underline"
                      >
                        {t('people.shiftRoles.makePrimary')}
                      </button>
                    ) : null}
                  </div>

                  {!readOnly ? (
                    <button
                      type="button"
                      onClick={() => remove(assigned.roleId)}
                      aria-label={t('people.shiftRoles.removeRole', { role: label })}
                      className="shrink-0 rounded-control p-1 text-ink-muted transition-colors duration-hover hover:text-danger"
                    >
                      <TrashIcon />
                    </button>
                  ) : null}
                </div>

                <div
                  role="radiogroup"
                  aria-label={groupLabel}
                  className="flex gap-1"
                >
                  {LEVELS.map((level) => {
                    const selected = assigned.skillLevel === level
                    return (
                      <button
                        key={level}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={readOnly}
                        onClick={() => setLevel(assigned.roleId, level)}
                        className={[
                          'tabular flex h-8 w-10 items-center justify-center rounded text-chip font-bold',
                          'transition-colors duration-hover disabled:cursor-default',
                          selected
                            ? 'bg-primary text-white'
                            : 'bg-gray-100 text-ink-muted',
                        ].join(' ')}
                      >
                        {t('people.levelShort', { level })}
                      </button>
                    )
                  })}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <p className="mt-4 text-chip italic text-ink-muted">
        {t('people.shiftRoles.legend')}
      </p>

      {readOnly ? (
        <p className="mt-2 text-chip text-ink-muted">
          {t('people.shiftRoles.readOnlyNote')}
        </p>
      ) : null}
    </section>
  )
}

/** Compact read-only chips — the header band on both profile screens. */
export function ShiftRoleChips({
  catalog,
  value,
  className = '',
}: {
  catalog: ShiftRole[]
  value: EmployeeShiftRole[]
  className?: string
}): JSX.Element | null {
  const { t, i18n } = useTranslation()
  const isSpanish = i18n.language.startsWith('es')
  const byId = useMemo(() => new Map(catalog.map((r) => [r.id, r])), [catalog])

  if (value.length === 0) return null

  return (
    <div className={['flex flex-wrap gap-2', className].filter(Boolean).join(' ')}>
      {value.map((assigned) => {
        const role = byId.get(assigned.roleId)
        const label = role ? (isSpanish ? role.nameEs : role.name) : assigned.roleId
        const text = `${label} · ${t('people.levelShort', { level: assigned.skillLevel })}`
        const shell =
          'inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-chip font-semibold'

        // Role colours are admin-editable at runtime (spec §6), so they can only
        // be inline styles. A role missing from the catalog falls back to tokens.
        return role ? (
          <span
            key={assigned.roleId}
            style={{
              color: role.color,
              backgroundColor: `${role.color}1A`,
              borderColor: `${role.color}33`,
            }}
            className={shell}
          >
            {text}
          </span>
        ) : (
          <span
            key={assigned.roleId}
            className={`${shell} border-line bg-app text-ink-muted`}
          >
            {text}
          </span>
        )
      })}
    </div>
  )
}

export default ShiftRolesEditor
