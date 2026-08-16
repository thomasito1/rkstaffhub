import type { AiProviderName } from '../../model'
import { AnthropicProvider } from './anthropic'
import { OpenAiProvider } from './openai'
import { GoogleProvider } from './google'
import { CustomProvider } from './custom'
import type { LlmProvider } from './types'

export type { LlmGenerateInput, LlmGenerateResult, LlmUsage, AiProviderErrorCode, LlmProvider } from './types'
export { AiProviderError } from './types'

const REGISTRY: Record<AiProviderName, LlmProvider> = {
  anthropic: new AnthropicProvider(),
  openai: new OpenAiProvider(),
  google: new GoogleProvider(),
  custom: new CustomProvider(),
}

export function getProvider(name: AiProviderName): LlmProvider {
  return REGISTRY[name]
}
