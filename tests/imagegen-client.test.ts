import { describe, expect, it } from 'vitest'
import { imagegenFailedCount, resolveImagegenSelection, type ImagegenProviderInfo } from '../src/infrastructure/imagegen-client'

const providers: ImagegenProviderInfo[] = [
  { id: 'grok', name: 'Grok', models: ['grok-imagine-image-2.0', 'grok-imagine-image'], defaultModel: 'grok-imagine-image', sizes: [], fixedSizeNote: null, editModels: [], timeoutMs: 90_000 },
  { id: 'google-direct', name: 'Gemini', models: ['gemini-3.1-flash-image'], defaultModel: 'gemini-3.1-flash-image', sizes: [], fixedSizeNote: '固定 1:1', editModels: ['gemini-3.1-flash-image'], timeoutMs: 90_000 },
]

describe('resolveImagegenSelection', () => {
  it('starts from the first provider for a fresh modal', () => {
    expect(resolveImagegenSelection(providers, '', '')).toEqual({ providerId: 'grok', model: 'grok-imagine-image' })
  })

  it('keeps a selection that is still valid after a config reload', () => {
    expect(resolveImagegenSelection(providers, 'google-direct', 'gemini-3.1-flash-image')).toEqual({
      providerId: 'google-direct',
      model: 'gemini-3.1-flash-image',
    })
  })

  it('does not keep a model that now belongs to a different provider than the resolved one', () => {
    // google-direct disappeared; the provider falls back to grok, and the stale
    // gemini model must not ride along — every generation would 400.
    const withoutGemini = providers.slice(0, 1)
    expect(resolveImagegenSelection(withoutGemini, 'google-direct', 'gemini-3.1-flash-image')).toEqual({
      providerId: 'grok',
      model: 'grok-imagine-image',
    })
  })

  it('falls back to the resolved provider default when only the model vanished', () => {
    const pruned: ImagegenProviderInfo[] = [{ ...providers[0]!, models: ['grok-imagine-image-2.0'], defaultModel: 'grok-imagine-image-2.0' }]
    expect(resolveImagegenSelection(pruned, 'grok', 'grok-imagine-image')).toEqual({
      providerId: 'grok',
      model: 'grok-imagine-image-2.0',
    })
  })

  it('returns null when no provider is configured', () => {
    expect(resolveImagegenSelection([], '', '')).toBeNull()
  })
})

describe('imagegenFailedCount', () => {
  it('treats a missing or negative failed field as zero', () => {
    expect(imagegenFailedCount({ provider: 'p', model: 'm', images: [] })).toBe(0)
    expect(imagegenFailedCount({ provider: 'p', model: 'm', images: [], failed: -2 })).toBe(0)
    expect(imagegenFailedCount({ provider: 'p', model: 'm', images: [], failed: 2 })).toBe(2)
  })
})
