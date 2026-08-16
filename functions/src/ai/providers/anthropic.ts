/**
 * Anthropic Messages API — a raw `fetch` call, not the `@anthropic-ai/sdk`
 * package. This app only ever needs ONE non-streaming call per generation,
 * and Node 20 (this package's pinned runtime) has global `fetch` — pulling
 * in a full SDK (plus its own retry/streaming machinery this app never
 * uses) for one endpoint isn't worth the dependency weight, matching this
 * codebase's own minimal-dependencies habit (pdfkit was added only when a
 * real PDF-generation need existed).
 */

import { AiProviderError, errorCodeForStatus, type LlmGenerateInput, type LlmGenerateResult, type LlmProvider } from './types'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_TOKENS = 8192

interface AnthropicResponse {
  content?: { type: string; text?: string }[]
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
}

export class AnthropicProvider implements LlmProvider {
  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    let response: Response
    try {
      response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': input.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: input.model,
          max_tokens: MAX_TOKENS,
          system: input.system,
          messages: [{ role: 'user', content: input.user }],
        }),
      })
    } catch (err) {
      throw new AiProviderError(`Could not reach Anthropic: ${(err as Error).message}`, 'network')
    }

    let body: AnthropicResponse
    try {
      body = (await response.json()) as AnthropicResponse
    } catch {
      throw new AiProviderError('Anthropic response was not valid JSON.', 'invalid-response', response.status)
    }

    if (!response.ok) {
      throw new AiProviderError(
        body.error?.message ?? `Anthropic returned HTTP ${response.status}.`,
        errorCodeForStatus(response.status),
        response.status,
      )
    }

    const text = body.content?.find((block) => block.type === 'text')?.text
    if (typeof text !== 'string') {
      throw new AiProviderError('Anthropic response had no text content block.', 'invalid-response', response.status)
    }

    return {
      text,
      usage: {
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
      },
    }
  }
}
