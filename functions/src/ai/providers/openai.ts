/**
 * OpenAI Chat Completions API — raw `fetch`, same reasoning as
 * providers/anthropic.ts. `response_format: { type: 'json_object' }` asks
 * the model to guarantee valid JSON at the API level; `contract.ts`'s
 * `parseAiResponse` still re-validates the SHAPE independently regardless
 * (this app never trusts a provider's own claim of compliance).
 */

import { AiProviderError, errorCodeForStatus, type LlmGenerateInput, type LlmGenerateResult, type LlmProvider } from './types'

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiResponse {
  choices?: { message?: { content?: string } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string }
}

export class OpenAiProvider implements LlmProvider {
  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    let response: Response
    try {
      response = await fetch(OPENAI_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${input.apiKey}`,
        },
        body: JSON.stringify({
          model: input.model,
          messages: [
            { role: 'system', content: input.system },
            { role: 'user', content: input.user },
          ],
          response_format: { type: 'json_object' },
        }),
      })
    } catch (err) {
      throw new AiProviderError(`Could not reach OpenAI: ${(err as Error).message}`, 'network')
    }

    let body: OpenAiResponse
    try {
      body = (await response.json()) as OpenAiResponse
    } catch {
      throw new AiProviderError('OpenAI response was not valid JSON.', 'invalid-response', response.status)
    }

    if (!response.ok) {
      throw new AiProviderError(
        body.error?.message ?? `OpenAI returned HTTP ${response.status}.`,
        errorCodeForStatus(response.status),
        response.status,
      )
    }

    const text = body.choices?.[0]?.message?.content
    if (typeof text !== 'string') {
      throw new AiProviderError('OpenAI response had no message content.', 'invalid-response', response.status)
    }

    return {
      text,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      },
    }
  }
}
