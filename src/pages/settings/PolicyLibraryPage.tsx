import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, EmptyState, Modal, Pill, type PillTone, useToast } from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import { createPolicyFamily, createPolicyVersion, listPolicies, type NewPolicyFamilyInput } from '@/lib/db'
import { formatDate } from '@/lib/format'
import type { Policy, PolicyCategory } from '@/types/models'

/**
 * Settings → Policy library — spec §12, Phase 4. No mockup exists for a
 * bare "management list + create/version modal" shape at this codebase's
 * actual complexity level: mockup 29 draws a full two-pane WYSIWYG editor
 * plus Signatures/Disciplinary/Documents tabs and a per-policy "N unsigned"
 * compliance chip, none of which this task is scoped to build (the unsigned
 * count in particular needs an admin-facing signatures listing that doesn't
 * exist — `db/signatures.ts` only exposes `listMySignatures(employeeId)` for
 * the SIGNED-IN employee, and that file is out of scope to extend here). What
 * IS replicated from mockup 29: the flat bordered-list-of-rows treatment, the
 * document icon per category, and the category/signature-required badges.
 * The create/edit mechanics follow this codebase's own established shape
 * (ShiftTemplatesPage's list + modal), not the mockup's inline dual-pane editor.
 *
 * `createPolicyVersion` never mutates existing content — "editing" a policy
 * always creates version N+1 and flips the old version's `isCurrent` to
 * false (src/lib/db/policies.ts). The modal makes that explicit rather than
 * reading like an in-place save, since any signature already on file stays
 * bound to the exact version text it was signed against.
 */

const FIELD_CLASS =
  'h-10 w-full rounded-control border border-line bg-page px-3 text-meta text-ink ' +
  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary'

const TEXTAREA_CLASS =
  'w-full rounded-control border border-line bg-page px-3 py-2 text-meta text-ink ' +
  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary'

const CATEGORIES: PolicyCategory[] = ['handbook', 'policy', 'onboarding', 'other']

const CATEGORY_TONE: Record<PolicyCategory, PillTone> = {
  handbook: 'published',
  policy: 'draft',
  onboarding: 'pending',
  other: 'neutral',
}

interface PolicyFamily {
  familyId: string
  current: Policy
  older: Policy[]
}

function toDate(value: unknown): Date | null {
  if (value && typeof value === 'object' && 'toDate' in value) {
    return (value as { toDate(): Date }).toDate()
  }
  return null
}

function groupFamilies(policies: Policy[]): PolicyFamily[] {
  const byFamily = new Map<string, Policy[]>()
  for (const p of policies) {
    const list = byFamily.get(p.familyId) ?? []
    list.push(p)
    byFamily.set(p.familyId, list)
  }
  const families: PolicyFamily[] = []
  for (const [familyId, versions] of byFamily) {
    const sorted = [...versions].sort((a, b) => b.version - a.version)
    const current = sorted.find((v) => v.isCurrent) ?? sorted[0]
    if (!current) continue
    families.push({ familyId, current, older: sorted.filter((v) => v.id !== current.id) })
  }
  return families.sort((a, b) => a.current.title.localeCompare(b.current.title))
}

export function PolicyLibraryPage(): JSX.Element {
  return (
    <RequirePermission permission="policies.manage">
      <PolicyLibraryScreen />
    </RequirePermission>
  )
}

function PolicyLibraryScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language

  const [policies, setPolicies] = useState<Policy[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'version'; previous: Policy } | null>(null)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState<PolicyCategory | 'all'>('all')

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      setPolicies(await listPolicies())
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const families = useMemo(() => groupFamilies(policies), [policies])

  const visibleFamilies = useMemo(() => {
    const q = search.trim().toLowerCase()
    return families.filter((f) => {
      if (categoryFilter !== 'all' && f.current.category !== categoryFilter) return false
      if (!q) return true
      const label = lang.startsWith('es') && f.current.titleEs ? f.current.titleEs : f.current.title
      return label.toLowerCase().includes(q) || f.current.title.toLowerCase().includes(q)
    })
  }, [families, search, categoryFilter, lang])

  function titleFor(p: Policy): string {
    return lang.startsWith('es') && p.titleEs ? p.titleEs : p.title
  }

  function toggleExpanded(familyId: string): void {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(familyId)) next.delete(familyId)
      else next.add(familyId)
      return next
    })
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">
            {t('settings.policyLibrary.title')}
          </h1>
          <p className="mt-0.5 text-meta text-ink-muted">{t('settings.policyLibrary.subtitle')}</p>
        </div>
        <Button variant="primary" onClick={() => setModal({ mode: 'create' })}>
          {t('settings.policyLibrary.newPolicy')}
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('settings.policyLibrary.searchPlaceholder')}
          aria-label={t('settings.policyLibrary.searchPlaceholder')}
          className={`${FIELD_CLASS} max-w-xs`}
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as PolicyCategory | 'all')}
          aria-label={t('settings.policyLibrary.filterCategory')}
          className={`${FIELD_CLASS} w-48`}
        >
          <option value="all">{t('settings.policyLibrary.allCategories')}</option>
          {CATEGORIES.map((cat) => (
            <option key={cat} value={cat}>
              {t(`settings.policyLibrary.categories.${cat}`)}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="flex flex-col gap-1 rounded-card border border-line bg-page p-1">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-16 animate-skeleton rounded-lg bg-app" />
          ))}
        </div>
      ) : loadError ? (
        <div className="rounded-card border border-line bg-page p-6 text-center">
          <p className="text-meta text-ink-muted">{t('settings.policyLibrary.errorBody')}</p>
          <Button className="mt-3" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : visibleFamilies.length === 0 ? (
        <EmptyState
          illustration="search"
          title={t('settings.policyLibrary.emptyTitle')}
          body={t('settings.policyLibrary.emptyBody')}
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-line bg-page">
          {visibleFamilies.map((family, idx) => {
            const p = family.current
            const updated = toDate(p.updatedAt) ?? toDate(p.createdAt)
            const isExpanded = expanded.has(family.familyId)
            return (
              <div key={family.familyId} className={idx > 0 ? 'border-t border-line' : ''}>
                <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                  <div className="flex min-w-0 items-center gap-4">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-app text-ink-muted">
                      <CategoryIcon category={p.category} />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-body font-semibold text-ink">{titleFor(p)}</p>
                      <p className="tabular text-chip text-ink-muted">
                        {t('settings.policyLibrary.versionMeta', {
                          version: p.version,
                          date: updated ? formatDate(updated, { dateStyle: 'medium' }, lang) : '—',
                        })}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Pill tone={CATEGORY_TONE[p.category]}>{t(`settings.policyLibrary.categories.${p.category}`)}</Pill>
                    {p.requiresSignature ? (
                      <Pill tone="approved">{t('settings.policyLibrary.badges.signatureRequired')}</Pill>
                    ) : null}
                    {family.older.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => toggleExpanded(family.familyId)}
                        className="text-chip font-medium text-ink-muted transition-colors duration-hover hover:text-ink"
                      >
                        {isExpanded
                          ? t('settings.policyLibrary.hideOlderVersions')
                          : t('settings.policyLibrary.showOlderVersions', { count: family.older.length })}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setModal({ mode: 'version', previous: p })}
                      className="text-chip font-semibold text-primary transition-colors duration-hover hover:text-primary/80"
                    >
                      {t('settings.policyLibrary.newVersion')}
                    </button>
                  </div>
                </div>
                {isExpanded ? (
                  <div className="space-y-1 bg-app px-5 py-3">
                    {family.older.map((v) => {
                      const vDate = toDate(v.updatedAt) ?? toDate(v.createdAt)
                      return (
                        <div key={v.id} className="flex items-center justify-between gap-3 text-chip text-ink-muted">
                          <span className="truncate">{titleFor(v)}</span>
                          <span className="tabular shrink-0">
                            {t('settings.policyLibrary.olderVersionLine', {
                              version: v.version,
                              date: vDate ? formatDate(vDate, { dateStyle: 'medium' }, lang) : '—',
                            })}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {modal ? (
        <PolicyFormModal
          mode={modal.mode}
          previous={modal.mode === 'version' ? modal.previous : null}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null)
            void load()
          }}
        />
      ) : null}
    </div>
  )
}

function CategoryIcon({ category }: { category: PolicyCategory }): JSX.Element {
  // Category icon set — mirrors mockup 29's per-category document glyphs.
  // No dedicated icon file for a two-icon distinction; inlined here since
  // nothing else in this screen needs a shared icon module.
  if (category === 'onboarding') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
        <rect x="8" y="2" width="8" height="4" rx="1" />
        <path d="M9 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4" />
        <path d="M9 12h6M9 16h6M9 8h.01" />
      </svg>
    )
  }
  if (category === 'handbook') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
        <path d="M12 7v14" />
        <path d="M3 5a2 2 0 0 1 2-2h4a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H3Z" />
        <path d="M21 5a2 2 0 0 0-2-2h-4a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7Z" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  )
}

function PolicyFormModal({
  mode,
  previous,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'version'
  previous: Policy | null
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const titleFieldId = useId()

  const [title, setTitle] = useState(previous?.title ?? '')
  const [titleEs, setTitleEs] = useState(previous?.titleEs ?? '')
  const [bodyMarkdown, setBodyMarkdown] = useState(previous?.bodyMarkdown ?? '')
  const [bodyMarkdownEs, setBodyMarkdownEs] = useState(previous?.bodyMarkdownEs ?? '')
  const [category, setCategory] = useState<PolicyCategory>(previous?.category ?? 'policy')
  const [requiresSignature, setRequiresSignature] = useState(previous?.requiresSignature ?? false)
  const [activeFrom, setActiveFrom] = useState(previous?.activeFrom ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSave(): Promise<void> {
    setError(null)
    const trimmedTitle = title.trim()
    const trimmedBody = bodyMarkdown.trim()
    if (!trimmedTitle) {
      setError(t('settings.policyLibrary.modal.titleRequired'))
      return
    }
    if (!trimmedBody) {
      setError(t('settings.policyLibrary.modal.bodyRequired'))
      return
    }
    if (!activeFrom) {
      setError(t('settings.policyLibrary.modal.activeFromRequired'))
      return
    }

    const input: NewPolicyFamilyInput = {
      title: trimmedTitle,
      titleEs: titleEs.trim(),
      bodyMarkdown: trimmedBody,
      bodyMarkdownEs: bodyMarkdownEs.trim(),
      category,
      requiresSignature,
      activeFrom,
    }

    setSaving(true)
    try {
      if (mode === 'version' && previous) {
        await createPolicyVersion(previous, input)
        toast.show({
          tone: 'success',
          message: t('settings.policyLibrary.toast.versioned', { name: trimmedTitle }),
        })
      } else {
        await createPolicyFamily(input)
        toast.show({ tone: 'success', message: t('settings.policyLibrary.toast.created', { name: trimmedTitle }) })
      }
      onSaved()
    } catch {
      toast.show({
        tone: 'error',
        message: t(mode === 'version' ? 'settings.policyLibrary.toast.versionFailed' : 'settings.policyLibrary.toast.createFailed'),
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
      title={t(mode === 'version' ? 'settings.policyLibrary.modal.newVersionTitle' : 'settings.policyLibrary.modal.newTitle')}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={saving} onClick={() => void handleSave()}>
            {t(mode === 'version' ? 'settings.policyLibrary.modal.saveVersion' : 'common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {mode === 'version' ? (
          <div className="flex items-start gap-2 rounded-control border border-line bg-app p-3">
            <p className="text-chip text-ink-muted">{t('settings.policyLibrary.modal.newVersionNotice')}</p>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor={titleFieldId} className="mb-1 block text-chip font-medium text-ink-muted">
              {t('settings.policyLibrary.modal.title')}
            </label>
            <input
              id={titleFieldId}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={FIELD_CLASS}
            />
          </div>
          <div>
            <label className="mb-1 block text-chip font-medium text-ink-muted">
              {t('settings.policyLibrary.modal.titleEs')}
            </label>
            <input
              value={titleEs}
              onChange={(e) => setTitleEs(e.target.value)}
              placeholder={t('settings.policyLibrary.modal.titleEsPlaceholder')}
              className={FIELD_CLASS}
            />
          </div>
        </div>

        <div>
          <label className="mb-1 block text-chip font-medium text-ink-muted">
            {t('settings.policyLibrary.modal.body')}
          </label>
          <textarea
            rows={6}
            value={bodyMarkdown}
            onChange={(e) => setBodyMarkdown(e.target.value)}
            className={TEXTAREA_CLASS}
          />
        </div>

        <div>
          <label className="mb-1 block text-chip font-medium text-ink-muted">
            {t('settings.policyLibrary.modal.bodyEs')}
          </label>
          <textarea
            rows={6}
            value={bodyMarkdownEs}
            onChange={(e) => setBodyMarkdownEs(e.target.value)}
            placeholder={t('settings.policyLibrary.modal.bodyEsPlaceholder')}
            className={TEXTAREA_CLASS}
          />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="mb-1 block text-chip font-medium text-ink-muted">
              {t('settings.policyLibrary.modal.category')}
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as PolicyCategory)}
              className={FIELD_CLASS}
            >
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {t(`settings.policyLibrary.categories.${cat}`)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-chip font-medium text-ink-muted">
              {t('settings.policyLibrary.modal.activeFrom')}
            </label>
            <input
              type="date"
              value={activeFrom}
              onChange={(e) => setActiveFrom(e.target.value)}
              className={`${FIELD_CLASS} tabular`}
            />
          </div>
          <div className="flex items-end pb-2">
            <label className="flex items-center gap-2 text-chip font-medium text-ink-muted">
              <input
                type="checkbox"
                checked={requiresSignature}
                onChange={(e) => setRequiresSignature(e.target.checked)}
                className="h-5 w-5 rounded border-line text-primary focus:ring-primary"
              />
              {t('settings.policyLibrary.modal.requiresSignature')}
            </label>
          </div>
        </div>

        {error ? <p className="text-chip font-medium text-danger">{error}</p> : null}
      </div>
    </Modal>
  )
}

export default PolicyLibraryPage
