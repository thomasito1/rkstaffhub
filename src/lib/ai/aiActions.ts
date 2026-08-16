/**
 * Client wrappers for the Phase 5 AI Cloud Functions — see
 * `functions/src/ai/configureProvider.ts`/`generate.ts` for what each
 * independently verifies (permission, rate limit, draft-only) and why none
 * of this can be a plain client write (firestore.rules: `settings/
 * aiProviders` is Cloud-Function-only; `schedules`/`shifts` writes from a
 * generation call need the real key and the conflicts engine, neither of
 * which belongs on the client).
 */
import { httpsCallable, type FunctionsError } from 'firebase/functions'
import { functions } from '@/lib/firebase'
import type { AiProviderName } from '@/types/models'

export class AiActionRejected extends Error {
  constructor(
    message: string,
    public readonly code: FunctionsError['code'],
    public readonly details: unknown,
  ) {
    super(message)
    this.name = 'AiActionRejected'
  }
}

async function callAiAction<Req, Res>(name: string, input: Req): Promise<Res> {
  const call = httpsCallable<Req, Res>(functions, name)
  try {
    const res = await call(input)
    return res.data
  } catch (err) {
    const fnErr = err as FunctionsError
    throw new AiActionRejected(fnErr.message ?? 'That AI action failed', fnErr.code, fnErr.details)
  }
}

export interface ConfigureAiProviderInput {
  provider: AiProviderName
  model: string
  apiKey: string
  /** Only meaningful for provider === 'custom'. */
  endpoint?: string | null
  /** Also make this the active provider in the same call. */
  setActive?: boolean
}

export interface ConfigureAiProviderResult {
  provider: AiProviderName
  keyLast4: string
}

/** ai.configureKeys, Owner-only per the effective permission matrix. Never returns the key. */
export function configureAiProvider(input: ConfigureAiProviderInput): Promise<ConfigureAiProviderResult> {
  return callAiAction('configureAiProvider', input)
}

export interface SetActiveAiProviderResult {
  active: AiProviderName
}

/** Switches the active provider without touching any key — the provider must already have one configured. */
export function setActiveAiProvider(provider: AiProviderName): Promise<SetActiveAiProviderResult> {
  return callAiAction('setActiveAiProvider', { provider })
}

export interface GenerateAiScheduleResult {
  weekId: string
  provider: string
  model: string
  shiftsAssigned: number
  shiftsOpenWithReason: number
  shiftsRejected: number
  tokensUsed: { input: number; output: number }
}

/**
 * ai.generateSchedule, rate-limited server-side. `instructions` present =
 * a "regenerate with instructions" call, which replaces the week's prior
 * AI-authored draft shifts before generating fresh — a manager's own
 * manual edits to the draft are never touched. Always writes a DRAFT;
 * never publishes.
 */
export function generateAiSchedule(weekId: string, instructions?: string | null): Promise<GenerateAiScheduleResult> {
  return callAiAction('generateAiSchedule', { weekId, instructions: instructions ?? null })
}
