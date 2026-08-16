/**
 * The provider interface every LLM implementation satisfies (spec §13,
 * Rafa's guardrail #5: "Provider interface with Anthropic/OpenAI/Google
 * implementations... typed graceful failures"). `functions/src/ai/generate.ts`
 * only ever talks to this interface — it does not know or care which
 * provider is active.
 */

export interface LlmGenerateInput {
  apiKey: string
  model: string
  system: string
  user: string
  /** Only meaningful for the 'custom' provider — see providers/custom.ts. */
  endpoint?: string | null
}

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
}

export interface LlmGenerateResult {
  text: string
  usage: LlmUsage
}

export type AiProviderErrorCode = 'auth' | 'rate-limit' | 'network' | 'invalid-response' | 'unknown'

/** A typed, graceful failure — `generate.ts` catches this specifically to surface a clear reason rather than a raw stack trace. */
export class AiProviderError extends Error {
  readonly code: AiProviderErrorCode
  readonly providerStatus?: number

  constructor(message: string, code: AiProviderErrorCode, providerStatus?: number) {
    super(message)
    this.name = 'AiProviderError'
    this.code = code
    this.providerStatus = providerStatus
  }
}

export interface LlmProvider {
  generate(input: LlmGenerateInput): Promise<LlmGenerateResult>
}

/** Maps an HTTP status from any provider's REST API to our own error vocabulary — shared by every implementation so a caller's error handling doesn't need to know which provider it was talking to. */
export function errorCodeForStatus(status: number): AiProviderErrorCode {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limit'
  if (status >= 500) return 'network'
  return 'unknown'
}
