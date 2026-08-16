import { useCallback, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, useToast } from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import { configureAiProvider, setActiveAiProvider } from '@/lib/ai/aiActions'
import { getAiSettings, subscribeAppSettings } from '@/lib/db'
import { formatDate } from '@/lib/format'
import type { AiProviderConfig, AiProviderName, AiSettings } from '@/types/models'

/**
 * Settings → AI providers — spec §13, Phase 5.
 *
 * Mirrors mockup 34's 2×2 provider grid + security banner. Two mockup
 * elements are deliberately NOT built here, per CLAUDE.md's "spec wins for
 * behavior" conflict rule: a top "Save changes"/"Test connection" button
 * pair (every card already writes independently through its own callable —
 * `configureAiProvider`/`setActiveAiProvider` — there is no batched-save
 * operation for a button to call), and a "Usage this month" tokens/cost card
 * plus a "fallback provider" strategy row (neither has a backing field on
 * `AiSettings`/`AiProviderConfig`, and spec §13's own provider-settings bullet
 * asks for exactly "provider, model picker, last-4, active toggle" — nothing
 * about usage aggregation or a fallback policy). Building either would mean
 * either a dead button or fabricated numbers, both worse than omitting them.
 * Flagged here per CLAUDE.md's conflict-resolution rule rather than silently
 * dropped.
 *
 * The page is gated by TWO independent things, checked in this order:
 *   1. `ai.configureKeys` (Owner-only, spec §4) — synchronous via useAuth(),
 *      so it fails fast with no network round trip.
 *   2. `settings/app.featureFlags.aiScheduling` — an async Firestore read,
 *      following the same "flag off = hide/disable the control, not a scary
 *      dedicated screen" precedent as `usePhoneOtpEnabled` on the login page
 *      (src/pages/auth/LoginPage.tsx) — reusing the exact same permission-
 *      denied copy/layout for a flag that's off, rather than inventing a new
 *      "feature disabled" screen this codebase has no other example of.
 */

type ModelOption = { id: string; label: string }

interface ProviderMeta {
  provider: AiProviderName
  /** Brand color is fixed identity, not a design-system token — same reasoning as `ShiftRole.color` (src/types/models.ts): rendered via inline style, never a Tailwind class. */
  badgeColor: string
  badgeLetter: string
  models: ModelOption[] | null // null = free-text model input (custom)
}

const PROVIDER_ORDER: AiProviderName[] = ['anthropic', 'openai', 'google', 'custom']

const PROVIDER_META: Record<AiProviderName, ProviderMeta> = {
  anthropic: {
    provider: 'anthropic',
    badgeColor: '#E87B35',
    badgeLetter: 'A',
    models: [
      // Ids match mockup 34's own options exactly, and `claude-opus-5` is the
      // literal seeded model id (scripts/seed.ts's AI_PROVIDER_ANTHROPIC) —
      // keeping this list in sync means Settings → AI providers renders the
      // seeded config's model as a real select match, not an unmatched
      // fallback string.
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ],
  },
  openai: {
    provider: 'openai',
    badgeColor: '#10A37F',
    badgeLetter: 'O',
    models: [
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'gpt-5-mini', label: 'GPT-5 mini' },
      { id: 'gpt-4o', label: 'GPT-4o' },
    ],
  },
  google: {
    provider: 'google',
    badgeColor: '#4285F4',
    badgeLetter: 'G',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
  },
  custom: {
    provider: 'custom',
    badgeColor: '#6B7280',
    badgeLetter: 'C',
    models: null,
  },
}

function toDate(value: unknown): Date | null {
  if (value && typeof value === 'object' && 'toDate' in value) {
    return (value as { toDate(): Date }).toDate()
  }
  return null
}

export function AiProvidersPage(): JSX.Element {
  return (
    <RequirePermission permission="ai.configureKeys">
      <AiSchedulingFlagGate>
        <AiProvidersScreen />
      </AiSchedulingFlagGate>
    </RequirePermission>
  )
}

/**
 * `settings/app.featureFlags.aiScheduling` — live-subscribed (same reasoning
 * as `useMyTasksData`'s live read of `taskPhotoProof`: an admin flipping the
 * flag should take effect for anyone with this tab open, without a reload).
 * `undefined` = still loading, distinct from a resolved `false`. Exported so
 * `SettingsShell`'s nav tab can hide itself with the exact same signal the
 * route itself gates on, rather than two independently-drifting checks.
 */
export function useAiSchedulingEnabled(): boolean | undefined {
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    return subscribeAppSettings((settings) => {
      setEnabled(settings?.featureFlags.aiScheduling === true)
    })
  }, [])
  return enabled
}

/**
 * Async twin of `RequirePermission` for the `aiScheduling` feature flag —
 * reuses the exact same loading/refusal copy so a flag-off page and a
 * permission-denied page are indistinguishable, per this file's header note.
 */
function AiSchedulingFlagGate({ children }: { children: JSX.Element }): JSX.Element {
  const { t } = useTranslation()
  const enabled = useAiSchedulingEnabled()

  if (enabled === undefined) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
        <h1 className="text-section font-semibold text-ink">{t('app.loading')}</h1>
      </div>
    )
  }

  if (!enabled) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
        <h1 className="text-section font-semibold text-ink">{t('auth.noPermissionTitle')}</h1>
        <p className="mt-2 max-w-sm text-meta text-ink-muted">{t('auth.noPermissionBody')}</p>
      </div>
    )
  }

  return children
}

function AiProvidersScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language

  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [editingProvider, setEditingProvider] = useState<AiProviderName | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      setSettings(await getAiSettings())
    } catch {
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-6">
        <h1 className="text-title-lg font-semibold tracking-tight text-ink">
          {t('settings.aiProviders.title')}
        </h1>
        <p className="mt-0.5 text-meta text-ink-muted">{t('settings.aiProviders.subtitle')}</p>
      </div>

      <div className="mb-8 flex items-center gap-3 rounded-card border border-line bg-app px-4 py-3">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-[18px] w-[18px] shrink-0 text-ink-muted"
          aria-hidden="true"
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
        <p className="text-meta text-ink-muted">{t('settings.aiProviders.securityNote')}</p>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-64 animate-skeleton rounded-card border border-line bg-page" />
          ))}
        </div>
      ) : loadError ? (
        <div className="rounded-card border border-line bg-page p-6 text-center">
          <p className="text-meta text-ink-muted">{t('settings.aiProviders.errorBody')}</p>
          <Button className="mt-3" onClick={() => void load()}>
            {t('common.retry')}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          {PROVIDER_ORDER.map((provider) => (
            <ProviderCard
              key={provider}
              provider={provider}
              config={settings?.providers[provider] ?? null}
              active={settings?.active === provider}
              editing={editingProvider === provider}
              onStartEdit={() => setEditingProvider(provider)}
              onCancelEdit={() => setEditingProvider(null)}
              onSaved={() => {
                setEditingProvider(null)
                void load()
              }}
              onActivated={() => void load()}
              lang={lang}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ProviderCard({
  provider,
  config,
  active,
  editing,
  onStartEdit,
  onCancelEdit,
  onSaved,
  onActivated,
  lang,
}: {
  provider: AiProviderName
  config: AiProviderConfig | null
  active: boolean
  editing: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaved: () => void
  onActivated: () => void
  lang: string
}): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const meta = PROVIDER_META[provider]
  const [activating, setActivating] = useState(false)

  async function handleActivate(): Promise<void> {
    if (!config || active || activating) return
    setActivating(true)
    try {
      await setActiveAiProvider(provider)
      toast.show({
        tone: 'success',
        message: t('settings.aiProviders.toast.activated', { provider: t(`settings.aiProviders.providers.${provider}.name`) }),
      })
      onActivated()
    } catch {
      toast.show({ tone: 'error', message: t('settings.aiProviders.toast.activateFailed') })
    } finally {
      setActivating(false)
    }
  }

  const configured = Boolean(config)

  return (
    <div
      className={[
        'rounded-card-lg border p-6',
        active ? 'border-2 border-primary bg-[#F0F5FF]' : 'border-line bg-page',
      ].join(' ')}
    >
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-xl font-bold text-white"
            style={{ backgroundColor: meta.badgeColor }}
            aria-hidden="true"
          >
            {meta.badgeLetter}
          </div>
          <div>
            <h3 className="text-body font-semibold text-ink">
              {t(`settings.aiProviders.providers.${provider}.name`)}
            </h3>
            <p className="text-chip text-ink-muted">
              {t(`settings.aiProviders.providers.${provider}.description`)}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleActivate()}
          disabled={!configured || active || activating}
          className="flex items-center gap-2 disabled:cursor-not-allowed"
          aria-pressed={active}
          aria-label={t('settings.aiProviders.active')}
        >
          <span
            className={[
              'text-chip font-semibold',
              active ? 'text-primary' : configured ? 'text-ink-muted' : 'text-ink-muted/50',
            ].join(' ')}
          >
            {t('settings.aiProviders.active')}
          </span>
          <span
            className={[
              'flex h-5 w-5 items-center justify-center rounded-full border-2 bg-page',
              active ? 'border-primary' : configured ? 'border-line' : 'border-line/50',
            ].join(' ')}
          >
            {active ? <span className="h-2.5 w-2.5 rounded-full bg-primary" /> : null}
          </span>
        </button>
      </div>

      {editing ? (
        <ProviderForm
          provider={provider}
          meta={meta}
          config={config}
          onCancel={onCancelEdit}
          onSaved={onSaved}
        />
      ) : (
        <ProviderSummary provider={provider} config={config} lang={lang} onStartEdit={onStartEdit} />
      )}
    </div>
  )
}

function ProviderSummary({
  provider,
  config,
  lang,
  onStartEdit,
}: {
  provider: AiProviderName
  config: AiProviderConfig | null
  lang: string
  onStartEdit: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const meta = PROVIDER_META[provider]

  if (!config) {
    return (
      <div>
        <div className="mb-6">
          <Button variant="secondary" onClick={onStartEdit}>
            {t('settings.aiProviders.addKey')}
          </Button>
        </div>
        <StatusLine icon="dash" label={t('settings.aiProviders.notConfigured')} />
      </div>
    )
  }

  const modelLabel = meta.models?.find((m) => m.id === config.model)?.label ?? config.model
  const lastUsed = toDate(config.lastUsedAt)

  return (
    <div>
      <div className="mb-6 space-y-4">
        {provider === 'custom' ? (
          <Field label={t('settings.aiProviders.baseUrl')}>
            <p className="truncate text-meta text-ink">{config.endpoint}</p>
          </Field>
        ) : null}
        <Field label={t('settings.aiProviders.model')}>
          <p className="text-meta text-ink">{modelLabel}</p>
        </Field>
        <Field label={t('settings.aiProviders.apiKey')}>
          <div className="flex h-10 items-center justify-between rounded-control border border-line bg-page px-3">
            <span className="tabular text-meta text-ink tracking-[0.2em]">
              {t('settings.aiProviders.keyMasked', { last4: config.keyLast4 })}
            </span>
            <button
              type="button"
              onClick={onStartEdit}
              className="text-chip font-semibold text-primary hover:underline"
            >
              {t('settings.aiProviders.replace')}
            </button>
          </div>
        </Field>
      </div>
      {config.connected && lastUsed ? (
        <StatusLine
          icon="check"
          label={t('settings.aiProviders.connectedLastUsed', {
            date: formatDate(lastUsed, { dateStyle: 'medium', timeStyle: 'short' }, lang),
          })}
        />
      ) : config.connected ? (
        <StatusLine icon="check" label={t('settings.aiProviders.connected')} />
      ) : (
        <StatusLine icon="clock" label={t('settings.aiProviders.notYetUsed')} />
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-muted">{label}</p>
      {children}
    </div>
  )
}

function StatusLine({ icon, label }: { icon: 'check' | 'clock' | 'dash'; label: string }): JSX.Element {
  const color = icon === 'check' ? 'text-success' : 'text-ink-muted'
  return (
    <div className="flex items-center gap-2 pt-2">
      <StatusIcon icon={icon} className={`h-[18px] w-[18px] shrink-0 ${color}`} />
      <span className="text-meta text-ink">{label}</span>
    </div>
  )
}

function StatusIcon({ icon, className }: { icon: 'check' | 'clock' | 'dash'; className: string }): JSX.Element {
  if (icon === 'check') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="m8.5 12 2.5 2.5 5-5" />
      </svg>
    )
  }
  if (icon === 'clock') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 3" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  )
}

function ProviderForm({
  provider,
  meta,
  config,
  onCancel,
  onSaved,
}: {
  provider: AiProviderName
  meta: ProviderMeta
  config: AiProviderConfig | null
  onCancel: () => void
  onSaved: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const formId = useId()
  const isNew = !config

  const [model, setModel] = useState(config?.model ?? meta.models?.[0]?.id ?? '')
  const [apiKey, setApiKey] = useState('')
  const [endpoint, setEndpoint] = useState(config?.endpoint ?? '')
  const [setActive, setSetActive] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function handleSave(): Promise<void> {
    setError(null)
    const trimmedModel = model.trim()
    const trimmedKey = apiKey.trim()
    const trimmedEndpoint = endpoint.trim()

    if (!trimmedModel) {
      setError(t('settings.aiProviders.validation.modelRequired'))
      return
    }
    if (!trimmedKey) {
      setError(t('settings.aiProviders.validation.apiKeyRequired'))
      return
    }
    if (provider === 'custom' && !trimmedEndpoint) {
      setError(t('settings.aiProviders.validation.endpointRequired'))
      return
    }

    setSaving(true)
    try {
      await configureAiProvider({
        provider,
        model: trimmedModel,
        apiKey: trimmedKey,
        endpoint: provider === 'custom' ? trimmedEndpoint : undefined,
        // Only offer to switch active on a brand-new provider — replacing an
        // existing key's material never touches which provider is active
        // (that's setActiveAiProvider's own job, triggered from the card).
        setActive: isNew ? setActive : undefined,
      })
      toast.show({
        tone: 'success',
        message: t('settings.aiProviders.toast.configured', {
          provider: t(`settings.aiProviders.providers.${provider}.name`),
        }),
      })
      onSaved()
    } catch {
      // AiActionRejected carries a machine `.code` (e.g. 'invalid-argument',
      // 'permission-denied') but never a message safe to show verbatim —
      // CLAUDE.md/this task: surface a bilingual, user-facing string instead.
      setError(t('settings.aiProviders.toast.configureFailed'))
    } finally {
      setSaving(false)
    }
  }

  const fieldClass =
    'h-10 w-full rounded-control border border-line bg-page px-3 text-meta text-ink ' +
    'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary'

  return (
    <div className="space-y-4">
      {provider === 'custom' ? (
        <Field label={t('settings.aiProviders.baseUrl')}>
          <input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={t('settings.aiProviders.baseUrlPlaceholder')}
            className={fieldClass}
          />
        </Field>
      ) : null}

      <Field label={t('settings.aiProviders.model')}>
        {meta.models ? (
          <select value={model} onChange={(e) => setModel(e.target.value)} className={fieldClass}>
            {meta.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={t('settings.aiProviders.customModelPlaceholder')}
            className={fieldClass}
          />
        )}
      </Field>

      <Field label={t('settings.aiProviders.apiKey')}>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t('settings.aiProviders.apiKeyPlaceholder')}
          autoComplete="off"
          className={fieldClass}
        />
      </Field>

      {isNew ? (
        <label htmlFor={formId} className="flex items-center gap-2 text-chip font-medium text-ink-muted">
          <input
            id={formId}
            type="checkbox"
            checked={setActive}
            onChange={(e) => setSetActive(e.target.checked)}
            className="h-5 w-5 rounded border-line text-primary focus:ring-primary"
          />
          {t('settings.aiProviders.setActive')}
        </label>
      ) : null}

      {error ? <p className="text-chip font-medium text-danger">{error}</p> : null}

      <div className="flex justify-end gap-3 pt-2">
        <Button onClick={onCancel} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={saving} onClick={() => void handleSave()}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  )
}

export default AiProvidersPage
