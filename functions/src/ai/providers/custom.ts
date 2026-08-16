/**
 * The "other/custom" provider slot (spec §13's own text: "add API keys for
 * Anthropic, OpenAI, Google, and an 'other/custom' slot"). The spec names no
 * request/response shape for it — this is a DOCUMENTED JUDGMENT CALL, not a
 * spec requirement: an OpenAI-compatible `/chat/completions` endpoint is the
 * closest thing to a de facto standard among self-hosted/proxy LLM servers
 * (LiteLLM, vLLM, Ollama's OpenAI-compat mode, most third-party gateways),
 * so this reuses that exact request/response shape against a
 * manager-supplied `endpoint` instead of OpenAI's own URL. CONFIRM WITH
 * RAFA before a real custom integration depends on this assumption — see
 * PROGRESS.md's Phase 5 open-questions entry.
 */

import { AiProviderError, errorCodeForStatus, type LlmGenerateInput, type LlmGenerateResult, type LlmProvider } from './types'

interface CustomResponse {
  choices?: { message?: { content?: string } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string }
}

export class CustomProvider implements LlmProvider {
  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    if (!input.endpoint) {
      throw new AiProviderError('The custom provider has no endpoint configured.', 'invalid-response')
    }

    let response: Response
    try {
      response = await fetch(input.endpoint, {
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
        }),
      })
    } catch (err) {
      throw new AiProviderError(`Could not reach the custom endpoint: ${(err as Error).message}`, 'network')
    }

    let body: CustomResponse
    try {
      body = (await response.json()) as CustomResponse
    } catch {
      throw new AiProviderError('Custom provider response was not valid JSON.', 'invalid-response', response.status)
    }

    if (!response.ok) {
      throw new AiProviderError(
        body.error?.message ?? `Custom provider returned HTTP ${response.status}.`,
        errorCodeForStatus(response.status),
        response.status,
      )
    }

    const text = body.choices?.[0]?.message?.content
    if (typeof text !== 'string') {
      throw new AiProviderError('Custom provider response had no message content.', 'invalid-response', response.status)
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
