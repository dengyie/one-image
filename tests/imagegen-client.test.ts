import { describe, expect, it } from 'vitest'
import {
  groupImagegenModels,
  imagegenFailedCount,
  resolveImagegenSelection,
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

const providers: ImagegenProviderInfo[] = [
  {
    id: 'grok',
    name: 'Grok',
    models: ['grok-imagine-image-2.0', 'grok-imagine-image'],
    defaultModel: 'grok-imagine-image',
    sizes: [],
    fixedSizeNote: null,
    editModels: [],
    modelInfos: [info('grok-imagine-image-2.0'), info('grok-imagine-image')],
    timeoutMs: 90_000,
  },
  {
    id: 'google-direct',
    name: 'Gemini',
    models: ['gemini-3.1-flash-image'],
    defaultModel: 'gemini-3.1-flash-image',
    sizes: [],
    fixedSizeNote: '固定 1:1',
    editModels: ['gemini-3.1-flash-image'],
    modelInfos: [info('gemini-3.1-flash-image', { edit: true, fixedSizeNote: '固定 1:1' })],
    timeoutMs: 90_000,
  },
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
    const pruned: ImagegenProviderInfo[] = [{ ...providers[0]!, models: ['grok-imagine-image-2.0'], defaultModel: 'grok-imagine-image-2.0', modelInfos: [info('grok-imagine-image-2.0')] }]
    expect(resolveImagegenSelection(pruned, 'grok', 'grok-imagine-image')).toEqual({
      providerId: 'grok',
      model: 'grok-imagine-image-2.0',
    })
  })

  it('never selects a video model, even as the provider default', () => {
    // The image picker validates against modelInfos, which the server keeps
    // free of video dialects; a default pointing at a video id falls through
    // to the first image model.
    const mixed: ImagegenProviderInfo[] = [
      {
        id: 'mangoapi',
        name: 'MangoApi',
        models: ['grok-imagine-image', 'grok-imagine-video'],
        defaultModel: 'grok-imagine-video',
        sizes: [],
        fixedSizeNote: null,
        editModels: [],
        modelInfos: [info('grok-imagine-image', { note: '最快 5-11s' })],
        timeoutMs: 90_000,
      },
    ]
    expect(resolveImagegenSelection(mixed, '', '')).toEqual({ providerId: 'mangoapi', model: 'grok-imagine-image' })
    expect(resolveImagegenSelection(mixed, 'mangoapi', 'grok-imagine-video')).toEqual({ providerId: 'mangoapi', model: 'grok-imagine-image' })
  })

  it('returns null when no provider is configured', () => {
    expect(resolveImagegenSelection([], '', '')).toBeNull()
  })

  it('returns null when providers exist but none offers image models', () => {
    const videoOnly: ImagegenProviderInfo[] = [{ ...providers[0]!, modelInfos: [] }]
    expect(resolveImagegenSelection(videoOnly, '', '')).toBeNull()
  })
})

describe('groupImagegenModels', () => {
  it('groups by family in first-appearance order', () => {
    const groups = groupImagegenModels([
      info('grok-imagine-image'),
      info('gpt-image-2'),
      info('grok-imagine-image-2.0'),
      info('gemini-3.1-flash-image'),
      info('nano-banana-pro'),
      info('mystery-model'),
    ])
    expect(groups.map((g) => g.family)).toEqual(['Grok Imagine', 'GPT Image', 'Gemini', 'Nano Banana', '其他模型'])
    expect(groups[0]!.models.map((m) => m.id)).toEqual(['grok-imagine-image', 'grok-imagine-image-2.0'])
  })

  it('keeps every model even when all share one family', () => {
    const groups = groupImagegenModels([info('gpt-image-1'), info('gpt-image-2')])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.models).toHaveLength(2)
  })
})

describe('imagegenFailedCount', () => {
  it('treats a missing or negative failed field as zero', () => {
    expect(imagegenFailedCount({ provider: 'p', model: 'm', images: [] })).toBe(0)
    expect(imagegenFailedCount({ provider: 'p', model: 'm', images: [], failed: -2 })).toBe(0)
    expect(imagegenFailedCount({ provider: 'p', model: 'm', images: [], failed: 2 })).toBe(2)
  })
})
