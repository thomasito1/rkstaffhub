/**
 * Google Gemini `generateContent` API — raw `fetch`, same reasoning as
 * providers/anthropic.ts. The API key is a query parameter (Google's own
 * REST convention for this endpoint, unlike Anthropic/OpenAI's header
 * auth) — never logged, since it never appears in this file's own error
 * messages (only the response body/status do).
 */

import { AiProviderError, errorCodeForStatus, type LlmGenerateInput, type LlmGenerateResult, type LlmProvider } from './types'

interface GoogleResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  error?: { message?: string }
}

export class GoogleProvider implements LlmProvider {
  async generate(input: LlmGenerateInput): Promise<LlmGenerateResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent?key=${encodeURIComponent(input.apiKey)}`

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: input.system }] },
          contents: [{ role: 'user', parts: [{ text: input.user }] }],
          generationConfig: { responseMimeType: 'application/json' },
        }),
      })
    } catch (err) {
      throw new AiProviderError(`Could not reach Google: ${(err as Error).message}`, 'network')
    }

    let body: GoogleResponse
    try {
      body = (await response.json()) as GoogleResponse
    } catch {
      throw new AiProviderError('Google response was not valid JSON.', 'invalid-response', response.status)
    }

    if (!response.ok) {
      throw new AiProviderError(
        body.error?.message ?? `Google returned HTTP ${response.status}.`,
        errorCodeForStatus(response.status),
        response.status,
      )
    }

    const text = body.candidates?.[0]?.content?.parts?.[0]?.text
    if (typeof text !== 'string') {
      throw new AiProviderError('Google response had no candidate text.', 'invalid-response', response.status)
    }

    return {
      text,
      usage: {
        inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
      },
    }
  }
}
