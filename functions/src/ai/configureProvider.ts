/**
 * `configureAiProvider`/`setActiveAiProvider` — spec §13, Rafa's guardrail
 * #1: "Keys via callable into Secret Manager; metadata-only settings doc;
 * client never sees key material." The key itself never touches this
 * function's RESPONSE — only `keyLast4` goes back to the caller, and the
 * `settings/aiProviders` document these write is Cloud-Function-only
 * (firestore.rules denies every client write on it, same as `payPeriods`).
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

import { AI_SETTINGS_ID, COLLECTIONS, db } from '../firebase'
import { requirePermission } from '../permissions'
import { writeAudit } from '../audit'
import type { AiProviderConfigDoc, AiProviderName, AiSettingsDoc } from '../model'
import { getSecretStore } from './secrets'

const PROVIDER_NAMES: readonly AiProviderName[] = ['anthropic', 'openai', 'google', 'custom']

function requireProviderName(value: unknown): AiProviderName {
  if (typeof value === 'string' && (PROVIDER_NAMES as readonly string[]).includes(value)) {
    return value as AiProviderName
  }
  throw new HttpsError('invalid-argument', `provider must be one of: ${PROVIDER_NAMES.join(', ')}.`)
}

function settingsRef() {
  return db.collection(COLLECTIONS.settings).doc(AI_SETTINGS_ID)
}

export interface ConfigureAiProviderRequest {
  provider: AiProviderName
  model: string
  apiKey: string
  /** Only meaningful for provider === 'custom' — see providers/custom.ts. */
  endpoint?: string | null
  /** Also make this the active provider in the same call — the common "add and switch to it" flow. */
  setActive?: boolean
}

export interface ConfigureAiProviderResponse {
  provider: AiProviderName
  keyLast4: string
}

export const configureAiProvider = onCall<ConfigureAiProviderRequest>(
  async (request): Promise<ConfigureAiProviderResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const provider = requireProviderName(request.data.provider)
    const model = request.data.model?.trim()
    const apiKey = request.data.apiKey?.trim()
    if (!model) throw new HttpsError('invalid-argument', 'model is required.')
    if (!apiKey) throw new HttpsError('invalid-argument', 'apiKey is required.')
    if (provider === 'custom' && !request.data.endpoint?.trim()) {
      throw new HttpsError('invalid-argument', 'endpoint is required for the custom provider.')
    }

    const actor = await requirePermission(uid, 'ai.configureKeys')

    const ref = settingsRef()
    const before = (await ref.get()).data() as AiSettingsDoc | undefined
    const previousConfig = before?.providers?.[provider]

    // A "Replace" always writes a NEW secret value under the same name —
    // getSecretStore().store() overwrites, matching how a key rotation
    // should behave (the old value is never resolvable again once replaced).
    const secretName = `ai-provider-${provider}`
    const secretRef = await getSecretStore().store(secretName, apiKey)
    const keyLast4 = apiKey.slice(-4)

    // Firestore's Admin SDK throws on a literal `undefined` field value
    // (this project does not set `ignoreUndefinedProperties`) — `createdAt`
    // is therefore only ever INCLUDED on first configure, via a conditional
    // spread, never assigned `undefined` on a replace.
    const providerConfig: AiProviderConfigDoc = {
      provider,
      model,
      keyLast4,
      secretRef,
      endpoint: provider === 'custom' ? (request.data.endpoint ?? null) : null,
      // Reset to false on every (re)configure — "connected" means a REAL
      // generation call has succeeded against THIS key/model, which hasn't
      // happened yet for a value that was just entered or just replaced.
      connected: false,
      lastUsedAt: null,
      configuredBy: actor.id,
      ...(previousConfig ? {} : { createdAt: FieldValue.serverTimestamp() }),
      updatedAt: FieldValue.serverTimestamp(),
    }

    await ref.set(
      {
        providers: { [provider]: providerConfig },
        ...(request.data.setActive ? { active: provider } : {}),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )

    await writeAudit({
      action: 'ai.keyChange',
      actorEmployeeId: actor.id,
      actorUid: uid,
      targetType: 'aiSettings',
      targetId: provider,
      reason: previousConfig ? 'replace' : 'configure',
      before: previousConfig ? { keyLast4: previousConfig.keyLast4, model: previousConfig.model } : null,
      after: { keyLast4, model },
    })
    // Unlike every other sensitive mutation in this app, a failed audit
    // write here is NOT marked auditPending on a record — `settings/
    // aiProviders` carries no per-provider document to flag, and the
    // ai.keyChange event itself is inherently re-derivable (the provider's
    // `updatedAt`/`configuredBy` already show a change happened) even if
    // the log entry is briefly missing. writeAudit's own retry-then-log
    // behavior still applies; this is a smaller consequence than a
    // punch/tip/discipline edit going unlogged, so no extra durable marker
    // was added here.

    return { provider, keyLast4 }
  },
)

export interface SetActiveAiProviderRequest {
  provider: AiProviderName
}

export interface SetActiveAiProviderResponse {
  active: AiProviderName
}

/** Switches which already-configured provider generation calls use, without touching any key. */
export const setActiveAiProvider = onCall<SetActiveAiProviderRequest>(
  async (request): Promise<SetActiveAiProviderResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const provider = requireProviderName(request.data.provider)
    const actor = await requirePermission(uid, 'ai.configureKeys')

    const ref = settingsRef()
    const snap = await ref.get()
    const settings = snap.data() as AiSettingsDoc | undefined
    if (!settings?.providers?.[provider]) {
      throw new HttpsError('failed-precondition', `${provider} has no key configured yet.`)
    }

    const previousActive = settings.active ?? null
    await ref.set({ active: provider, updatedAt: FieldValue.serverTimestamp() }, { merge: true })

    await writeAudit({
      action: 'ai.keyChange',
      actorEmployeeId: actor.id,
      actorUid: uid,
      targetType: 'aiSettings',
      targetId: provider,
      reason: 'activate',
      before: { active: previousActive },
      after: { active: provider },
    })

    return { active: provider }
  },
)
