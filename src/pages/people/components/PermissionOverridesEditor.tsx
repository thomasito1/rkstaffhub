import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  PERMISSION_KEYS,
  type AccessRole,
  type PermissionKey,
} from '@/types/models'

/**
 * Per-person permission overrides — mockup 04, card E; spec §4.
 *
 * Effective permission = `override ?? roleDefault`. A row therefore has three
 * states, not two:
 *
 *   Inherit — no override stored; the role default applies and keeps applying
 *             if an Owner later edits Settings → Permissions.
 *   Allow   — override `true`.
 *   Deny    — override `false`.
 *
 * Inherit is NOT the same as "Allow when the default allows": storing the
 * value freezes it against future matrix edits, which is exactly what an
 * override is for and exactly what you do not want by accident. Clearing a row
 * back to Inherit deletes the key rather than writing `false`.
 *
 * KEY NAMES: mockup 04 renders invented labels ("Edit own punches", "View
 * labor reports"). Permission keys are behavior, so per CLAUDE.md's conflict
 * rule the spec §4 list in `PERMISSION_KEYS` wins; the mockup is a layout
 * reference only. Labels come from `permissionKeys.*` in the locale files.
 *
 * SECURITY: this only decides what to show and what to write. firestore.rules
 * re-derives the same answer server-side.
 */

type RowState = 'inherit' | 'allow' | 'deny'

export interface PermissionOverridesEditorProps {
  /** The target employee's stored overrides. */
  value: Partial<Record<PermissionKey, boolean>>
  /** The role-default row for the TARGET's access role, from permissions/roleDefaults. */
  roleDefaults: Partial<Record<PermissionKey, boolean>>
  /** Shown next to the heading so the defaults on screen are attributable. */
  targetRole: AccessRole
  onChange: (next: Partial<Record<PermissionKey, boolean>>) => void
  /** True when the viewer lacks `permissions.manage`. */
  readOnly?: boolean
}

const STATES: readonly RowState[] = ['inherit', 'allow', 'deny'] as const

function stateOf(value: boolean | undefined): RowState {
  if (value === undefined) return 'inherit'
  return value ? 'allow' : 'deny'
}

export function PermissionOverridesEditor({
  value,
  roleDefaults,
  targetRole,
  onChange,
  readOnly = false,
}: PermissionOverridesEditorProps): JSX.Element {
  const { t } = useTranslation()

  // Rows opened during this session that have no stored override yet. Without
  // this, setting a row back to Inherit would make it vanish mid-edit.
  const [openedKeys, setOpenedKeys] = useState<PermissionKey[]>([])
  const [adding, setAdding] = useState(false)

  const visibleKeys = useMemo(() => {
    const shown = new Set<PermissionKey>([
      ...(Object.keys(value) as PermissionKey[]),
      ...openedKeys,
    ])
    return PERMISSION_KEYS.filter((key) => shown.has(key))
  }, [value, openedKeys])

  const remainingKeys = useMemo(
    () => PERMISSION_KEYS.filter((key) => !visibleKeys.includes(key)),
    [visibleKeys],
  )

  function setRow(key: PermissionKey, next: RowState): void {
    const draft: Partial<Record<PermissionKey, boolean>> = { ...value }
    if (next === 'inherit') delete draft[key]
    else draft[key] = next === 'allow'
    onChange(draft)
  }

  function openRow(key: string): void {
    if (key === '') return
    setAdding(false)
    setOpenedKeys((current) =>
      current.includes(key as PermissionKey)
        ? current
        : [...current, key as PermissionKey],
    )
  }

  return (
    <section className="rounded-card border border-line bg-page p-6">
      <div className="mb-6">
        <h2 className="text-section font-semibold text-ink">
          {t('people.overrides.title')}
        </h2>
        <p className="mt-1 text-chip text-ink-muted">
          {t('people.overrides.subtitle', { role: t(`roles.${targetRole}`) })}
        </p>
      </div>

      {visibleKeys.length === 0 ? (
        <p className="rounded-control border border-dashed border-line px-4 py-6 text-center text-meta text-ink-muted">
          {t('people.overrides.none')}
        </p>
      ) : (
        <ul className="space-y-4">
          {visibleKeys.map((key) => {
            const current = stateOf(value[key])
            const isOverridden = current !== 'inherit'
            const defaultAllows = roleDefaults[key] ?? false
            const label = t(`permissionKeys.${key}`)

            return (
              <li
                key={key}
                className={[
                  'flex flex-wrap items-center justify-between gap-3',
                  isOverridden ? '-mx-3 rounded-control bg-primary-tint p-3' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <p
                    className={[
                      'truncate text-meta text-ink',
                      isOverridden ? 'font-semibold' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {label}
                  </p>
                  {isOverridden ? (
                    <span className="shrink-0 rounded-sm bg-primary px-1.5 text-micro font-bold uppercase tracking-wide text-white">
                      {t('people.overrides.badge')}
                    </span>
                  ) : null}
                </div>

                <p className="shrink-0 text-chip text-ink-muted">
                  {t('people.overrides.roleDefault', {
                    value: defaultAllows
                      ? t('people.overrides.allow')
                      : t('people.overrides.deny'),
                  })}
                </p>

                <div
                  role="radiogroup"
                  aria-label={t('people.overrides.groupLabel', { permission: label })}
                  className="flex shrink-0 rounded-md border border-line bg-gray-100 p-0.5"
                >
                  {STATES.map((state) => {
                    const selected = current === state
                    return (
                      <button
                        key={state}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={readOnly}
                        onClick={() => setRow(key, state)}
                        className={[
                          'rounded-sm px-2 py-0.5 text-micro font-bold transition-colors duration-hover',
                          'disabled:cursor-not-allowed disabled:opacity-60',
                          selected && state === 'inherit'
                            ? 'border border-line bg-page text-ink shadow-sm'
                            : '',
                          selected && state === 'allow' ? 'bg-primary text-white' : '',
                          selected && state === 'deny' ? 'bg-danger text-white' : '',
                          selected ? '' : 'text-ink-muted',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {t(`people.overrides.${state}`)}
                      </button>
                    )
                  })}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {!readOnly && remainingKeys.length > 0 ? (
        <div className="mt-6">
          {adding ? (
            <>
              <label
                htmlFor="override-add"
                className="mb-1 block text-chip font-medium text-ink-muted"
              >
                {t('people.overrides.pickPermission')}
              </label>
              <select
                id="override-add"
                defaultValue=""
                onChange={(e) => openRow(e.target.value)}
                className="h-10 w-full rounded-control border border-line bg-page px-3 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="">
                  {t('people.overrides.pickPermissionPlaceholder')}
                </option>
                {remainingKeys.map((key) => (
                  <option key={key} value={key}>
                    {t(`permissionKeys.${key}`)}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="text-meta font-semibold text-primary hover:underline"
            >
              {t('people.overrides.addOverride')}
            </button>
          )}
        </div>
      ) : null}

      {readOnly ? (
        <p className="mt-4 text-chip text-ink-muted">
          {t('people.overrides.readOnlyNote')}
        </p>
      ) : null}
    </section>
  )
}

export default PermissionOverridesEditor
