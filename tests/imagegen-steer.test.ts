import { describe, expect, it } from 'vitest'
import {
  steerSelectionAwayFromGoogleDialect,
  type ImagegenModelInfo,
  type ImagegenProviderInfo,
} from '../src/infrastructure/imagegen-client'

const info = (id: string, overrides: Partial<ImagegenModelInfo> = {}): ImagegenModelInfo => ({
  id,
  sizes: [],
  fixedSizeNote: null,
  edit: false,
  note: null,
  timeoutMs: 90_000,
  ...overrides,
})

const providerOf = (id: string, models: ImagegenModelInfo[]): ImagegenProviderInfo => ({
  id,
  name: id,
  models: models.map((m) => m.id),
  defaultModel: models[0]?.id ?? '',
  sizes: [],
  fixedSizeNote: null,
  editModels: [],
  modelInfos: models,
  timeoutMs: 90_000,
})

describe('steerSelectionAwayFromGoogleDialect', () => {
  it('keeps a non-Google selection untouched', () => {
    const providers = [providerOf('grok', [info('grok-imagine-image', { dialect: 'openai-images' })])]
    expect(steerSelectionAwayFromGoogleDialect(providers, { providerId: 'grok', model: 'grok-imagine-image' })).toBeNull()
  })

  it('steers a gemini-dialect selection to the first non-Google model', () => {
    const providers = [
      providerOf('mangoapi', [
        info('gemini-3.1-flash-image', { dialect: 'gemini' }),
        info('grok-imagine-image', { dialect: 'openai-images' }),
      ]),
    ]
    expect(
      steerSelectionAwayFromGoogleDialect(providers, { providerId: 'mangoapi', model: 'gemini-3.1-flash-image' }),
    ).toEqual({ providerId: 'mangoapi', model: 'grok-imagine-image' })
  })

  it('falls back to the id prefix when the server predates the dialect field', () => {
    const providers = [
      providerOf('mangoapi', [info('gemini-3.1-flash-image'), info('nano-banana-pro'), info('gpt-image-2')]),
    ]
    expect(
      steerSelectionAwayFromGoogleDialect(providers, { providerId: 'mangoapi', model: 'gemini-3.1-flash-image' }),
    ).toEqual({ providerId: 'mangoapi', model: 'gpt-image-2' })
  })

  it('crosses providers when the Google model own provider has no other pickable model', () => {
    const providers = [
      providerOf('google-direct', [info('gemini-3.1-flash-image', { dialect: 'gemini' })]),
      providerOf('grok', [info('grok-imagine-image', { dialect: 'openai-images' })]),
    ]
    expect(
      steerSelectionAwayFromGoogleDialect(providers, { providerId: 'google-direct', model: 'gemini-3.1-flash-image' }),
    ).toEqual({ providerId: 'grok', model: 'grok-imagine-image' })
  })

  it('keeps the selection when every pickable model is Google', () => {
    const providers = [providerOf('mangoapi', [info('gemini-3.1-flash-image', { dialect: 'gemini' })])]
    expect(
      steerSelectionAwayFromGoogleDialect(providers, { providerId: 'mangoapi', model: 'gemini-3.1-flash-image' }),
    ).toBeNull()
  })

  it('trusts the modelInfos projection as-is (the server hides caption-only entries)', () => {
    // Steering cannot re-derive "text-only" from a pickable entry; hiding
    // caption-only models is the server projection's job. If one were ever
    // wrongly re-admitted, this function would steer to it — garbage in,
    // garbage out — which is why the projection has its own test.
    const providers = [
      providerOf('mangoapi', [
        info('gemini-3.1-flash-image', { dialect: 'gemini' }),
        info('vlm-model', { dialect: 'openai-chat-image' }),
        info('grok-imagine-image', { dialect: 'openai-images' }),
      ]),
    ]
    expect(
      steerSelectionAwayFromGoogleDialect(providers, { providerId: 'mangoapi', model: 'gemini-3.1-flash-image' }),
    ).toEqual({ providerId: 'mangoapi', model: 'vlm-model' })
  })
})
