import { describe, expect, it } from 'vitest'
import { loadImagegenConfig } from '../server/imagegen-config'

const VALID_PROVIDER = {
  id: 'mangoapi',
  name: 'MangoApi 聚合',
  type: 'openai-images',
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  models: ['gpt-image-1', 'grok-2-image-1212'],
}

describe('imagegen config loader', () => {
  it('returns an empty provider list with no warnings when nothing is set', () => {
    const result = loadImagegenConfig({})
    expect(result.providers).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('parses inline JSON and fills defaults', () => {
    const result = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({ providers: [VALID_PROVIDER] }),
    })
    expect(result.warnings).toEqual([])
    expect(result.providers).toHaveLength(1)
    const provider = result.providers[0]
    expect(provider.type).toBe('openai-images')
    expect(provider.defaultModel).toBe('gpt-image-1')
    expect(provider.timeoutMs).toBe(90_000)
    expect(provider.sizes).toBeUndefined()
  })

  it('reads from the config file env when set', () => {
    const result = loadImagegenConfig({ ONEIMAGE_IMAGE_PROVIDERS_FILE: 'nonexistent/imagegen.json' })
    expect(result.providers).toEqual([])
    expect(result.warnings[0]).toContain('could not be read')
  })

  it('degrades gracefully on invalid JSON', () => {
    const result = loadImagegenConfig({ ONEIMAGE_IMAGE_PROVIDERS: '{not json' })
    expect(result.providers).toEqual([])
    expect(result.warnings[0]).toContain('not valid JSON')
  })

  it('skips invalid providers and keeps valid ones', () => {
    const result = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({
        providers: [
          VALID_PROVIDER,
          { ...VALID_PROVIDER, id: 'bad type id' }, // id with space
          { ...VALID_PROVIDER, id: 'nokey', apiKey: '' },
          { ...VALID_PROVIDER, id: 'badtype', type: 'midjourney' },
          { ...VALID_PROVIDER, id: 'nourl', baseUrl: 'api.example.com/v1' },
          { ...VALID_PROVIDER, id: 'nomodels', models: [] },
          VALID_PROVIDER, // duplicate id
        ],
      }),
    })
    expect(result.providers.map((p) => p.id)).toEqual(['mangoapi'])
    expect(result.warnings.length).toBeGreaterThanOrEqual(5)
  })

  it('clamps the upstream timeout under the Cloudflare edge limit', () => {
    const result = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({
        providers: [{ ...VALID_PROVIDER, timeoutMs: 120_000 }],
      }),
    })
    expect(result.providers[0].timeoutMs).toBeLessThanOrEqual(95_000)
    expect(result.warnings).toEqual([]) // accepted range is up to 180s, clamp is silent
  })

  it('rejects a defaultModel outside the model list and falls back', () => {
    const result = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({
        providers: [{ ...VALID_PROVIDER, defaultModel: 'not-in-list' }],
      }),
    })
    expect(result.providers[0].defaultModel).toBe('gpt-image-1')
    expect(result.warnings[0]).toContain('defaultModel not in models')
  })

  it('keeps a gemini generationConfig object passthrough', () => {
    const result = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({
        providers: [{
          ...VALID_PROVIDER,
          id: 'google',
          type: 'gemini',
          models: ['gemini-2.5-flash-image'],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
        }],
      }),
    })
    expect(result.providers[0].generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'] })
  })

  it('keeps a trimmed fixedSizeNote and drops malformed values', () => {
    const kept = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({
        providers: [{ ...VALID_PROVIDER, fixedSizeNote: '  固定 2:3 竖版输出  ' }],
      }),
    })
    expect(kept.providers[0].fixedSizeNote).toBe('固定 2:3 竖版输出')

    const dropped = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({
        providers: [{ ...VALID_PROVIDER, fixedSizeNote: '   ' }],
      }),
    })
    expect(dropped.providers[0].fixedSizeNote).toBeUndefined()
    expect(dropped.warnings.join('\n')).toContain('fixedSizeNote')
  })

  it('warns and drops a fixedSizeNote that a sizes picker makes unreachable', () => {
    const result = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({
        providers: [{
          ...VALID_PROVIDER,
          sizes: ['1024x1024'],
          fixedSizeNote: '固定 1:1',
          models: [{ id: 'm1' }, { id: 'm2', sizes: [], fixedSizeNote: '固定 3:4' }],
        }],
      }),
    })
    // String-form models inherit the provider sizes, so the provider-level
    // note is unreachable for them: the resolved spec carries no note.
    const m1 = result.providers[0].modelSpecs.find((m) => m.id === 'm1')
    expect(m1?.sizes).toEqual(['1024x1024'])
    expect(m1?.fixedSizeNote).toBeNull()
    // A per-model note paired with that model's own empty sizes is reachable
    // and survives.
    const m2 = result.providers[0].modelSpecs.find((m) => m.id === 'm2')
    expect(m2?.sizes).toEqual([])
    expect(m2?.fixedSizeNote).toBe('固定 3:4')
    expect(result.warnings.join('\n')).not.toContain('fixedSizeNote is unused')
  })
})

describe('imagegen config editModels', () => {
  it('keeps a subset of models that accept a reference image', () => {
    const result = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({
        providers: [{ ...VALID_PROVIDER, editModels: ['gpt-image-1', 'gpt-image-1'] }],
      }),
    })
    expect(result.warnings).toEqual([])
    // Deduplicated so the picker offers each model once.
    expect(result.providers[0].editModels).toEqual(['gpt-image-1'])
  })

  it('drops entries outside models with a warning instead of widening the surface', () => {
    const result = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({
        providers: [{ ...VALID_PROVIDER, editModels: ['gpt-image-1', 'not-configured', 7] }],
      }),
    })
    expect(result.providers[0].editModels).toEqual(['gpt-image-1'])
    expect(result.warnings.filter((w) => w.includes('editModels entry'))).toHaveLength(2)
    expect(result.warnings.join('\n')).toContain('not-configured')
  })

  it('advertises nothing when every entry is rejected or the field is malformed', () => {
    const rejected = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({ providers: [{ ...VALID_PROVIDER, editModels: ['nope'] }] }),
    })
    expect(rejected.providers[0].editModels).toBeUndefined()

    const malformed = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({ providers: [{ ...VALID_PROVIDER, editModels: 'gpt-image-1' }] }),
    })
    expect(malformed.providers[0].editModels).toBeUndefined()
    expect(malformed.warnings.join('\n')).toContain('editModels must be a string array')

    const absent = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({ providers: [VALID_PROVIDER] }),
    })
    expect(absent.providers[0].editModels).toBeUndefined()
    expect(absent.warnings).toEqual([])
  })
})

describe('imagegen config editsStyle', () => {
  it('accepts xai-json on an openai-images provider', () => {
    const result = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({ providers: [{ ...VALID_PROVIDER, editsStyle: 'xai-json' }] }),
    })
    expect(result.providers[0].editsStyle).toBe('xai-json')
    expect(result.warnings).toEqual([])
  })

  it('leaves editsStyle undefined when absent, so the multipart default is unchanged', () => {
    const result = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({ providers: [VALID_PROVIDER] }),
    })
    expect(result.providers[0].editsStyle).toBeUndefined()
  })

  it('rejects an unknown dialect and ignores the field on non-openai-images types', () => {
    const unknown = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({ providers: [{ ...VALID_PROVIDER, editsStyle: 'soap' }] }),
    })
    expect(unknown.providers[0].editsStyle).toBeUndefined()
    expect(unknown.warnings.join('\n')).toContain('editsStyle must be "multipart" or "xai-json"')

    const wrongType = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({
        providers: [{ ...VALID_PROVIDER, type: 'gemini', editsStyle: 'xai-json' }],
      }),
    })
    expect(wrongType.providers[0].editsStyle).toBeUndefined()
    expect(wrongType.warnings.join('\n')).toContain('editsStyle 只对 openai-images 类型生效')
  })
})

describe('imagegen config warnings', () => {
  it('warns that generationConfig only applies to gemini providers', () => {
    const result = loadImagegenConfig({
      ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({
        providers: [{ ...VALID_PROVIDER, generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }],
      }),
    })
    expect(result.providers[0].generationConfig).toBeUndefined()
    expect(result.warnings[0]).toContain('只对 gemini 类型生效')
  })
})

describe('imagegen config per-model specs', () => {
  const MODEL_PROVIDER = {
    id: 'mangoapi',
    name: 'MangoApi 聚合',
    type: 'openai-images',
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test',
    models: [
      'grok-imagine-image',
      {
        id: 'gpt-image-2',
        sizes: ['1024x1024', '1536x1024', '1024x1536'],
        note: '约 44s，尊重尺寸',
        timeoutMs: 120_000,
      },
      {
        id: 'gemini-3.1-flash-image',
        dialect: 'gemini',
        edit: true,
        fixedSizeNote: '固定 1:1 方形输出',
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      },
      { id: 'grok-imagine-video', dialect: 'openai-chat-video', note: '约 40-50s' },
    ],
  }

  const load = (provider: Record<string, unknown>) =>
    loadImagegenConfig({ ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({ providers: [provider] }) })

  it('normalizes object entries into specs with provider fallbacks', () => {
    const result = load(MODEL_PROVIDER)
    expect(result.warnings).toEqual([])
    const p = result.providers[0]
    // `models` stays the flat id list; `defaultModel` falls back to the first.
    expect(p.models).toEqual(['grok-imagine-image', 'gpt-image-2', 'gemini-3.1-flash-image', 'grok-imagine-video'])
    expect(p.defaultModel).toBe('grok-imagine-image')

    const grok = p.modelSpecs.find((m) => m.id === 'grok-imagine-image')
    expect(grok).toMatchObject({ dialect: 'openai-images', sizes: [], edit: false, editsStyle: 'multipart', note: null, timeoutMs: 90_000 })

    const gpt = p.modelSpecs.find((m) => m.id === 'gpt-image-2')
    expect(gpt).toMatchObject({ dialect: 'openai-images', sizes: ['1024x1024', '1536x1024', '1024x1536'], edit: false, note: '约 44s，尊重尺寸' })
    // Per-model timeout accepted in range then clamped silently.
    expect(gpt?.timeoutMs).toBe(95_000)

    const gemini = p.modelSpecs.find((m) => m.id === 'gemini-3.1-flash-image')
    expect(gemini).toMatchObject({
      dialect: 'gemini',
      sizes: [],
      fixedSizeNote: '固定 1:1 方形输出',
      edit: true,
    })
    expect(gemini?.generationConfig).toEqual({ responseModalities: ['TEXT', 'IMAGE'] })
  })

  it('derives editModels from per-model edit flags and keeps video models out of the image surface', () => {
    const result = load(MODEL_PROVIDER)
    const p = result.providers[0]
    expect(p.editModels).toEqual(['gemini-3.1-flash-image'])
    const video = p.modelSpecs.find((m) => m.id === 'grok-imagine-video')
    expect(video).toMatchObject({ dialect: 'openai-chat-video', sizes: [], edit: false, note: '约 40-50s' })
  })

  it('rejects duplicate model ids and entries without a usable id', () => {
    const result = load({
      ...MODEL_PROVIDER,
      models: ['m1', { id: 'm1' }, { dialect: 'gemini' }, { id: 'm2' }],
    })
    expect(result.providers[0].models).toEqual(['m1', 'm2'])
    expect(result.warnings.filter((w) => w.includes('duplicate model id'))).toHaveLength(1)
    expect(result.warnings.join('\n')).toContain('model id must be')
  })

  it('warns and ignores capability fields that a video model cannot use', () => {
    const result = load({
      ...MODEL_PROVIDER,
      models: [{ id: 'v', dialect: 'openai-chat-video', sizes: ['1024x1024'], edit: true, editsStyle: 'xai-json', generationConfig: { a: 1 } }],
    })
    const video = result.providers[0].modelSpecs[0]
    expect(video).toMatchObject({ dialect: 'openai-chat-video', sizes: [], edit: false, editsStyle: 'multipart' })
    expect(video?.generationConfig).toBeUndefined()
    expect(result.warnings.join('\n')).toContain('video models take no sizes')
    expect(result.warnings.join('\n')).toContain('video models take no reference image')
    expect(result.warnings.join('\n')).toContain('video models take no editsStyle')
    expect(result.warnings.join('\n')).toContain('video models take no generationConfig')
  })

  it('warns when a per-model editsStyle or generationConfig lands on the wrong dialect', () => {
    const result = load({
      ...MODEL_PROVIDER,
      models: [
        { id: 'a', dialect: 'openai-chat-image', editsStyle: 'xai-json' },
        { id: 'b', dialect: 'openai-images', generationConfig: { a: 1 } },
      ],
    })
    expect(result.warnings.join('\n')).toContain('editsStyle 只对 openai-images 方言生效')
    expect(result.warnings.join('\n')).toContain('generationConfig 只对 gemini 方言生效')
  })

  it('keeps a per-model editModelId for capability-split edit surfaces', () => {
    const result = load({
      ...MODEL_PROVIDER,
      models: [
        { id: 'grok-imagine-image', edit: true, editModelId: 'grok-imagine-image-edit' },
        { id: 'm2', edit: true, editModelId: 'not a slug!' },
        { id: 'm3', edit: true, editModelId: '   ' },
      ],
    })
    const specs = result.providers[0].modelSpecs
    expect(specs.find((m) => m.id === 'grok-imagine-image')?.editModelId).toBe('grok-imagine-image-edit')
    expect(specs.find((m) => m.id === 'm2')?.editModelId).toBeUndefined()
    expect(specs.find((m) => m.id === 'm3')?.editModelId).toBeUndefined()
    expect(result.warnings.join('|')).toContain('editModelId must be a non-empty slug')
  })

  it('drops a per-model fixedSizeNote that its own sizes make unreachable', () => {
    const result = load({
      ...MODEL_PROVIDER,
      models: [{ id: 'm', sizes: ['1024x1024'], fixedSizeNote: '固定 1:1' }],
    })
    expect(result.providers[0].modelSpecs[0].fixedSizeNote).toBeNull()
    expect(result.warnings.join('\n')).toContain('fixedSizeNote is unused because sizes is set')
  })

  it('does not leak the provider fixedSizeNote into a per-model note', () => {
    const result = load({
      ...MODEL_PROVIDER,
      fixedSizeNote: '固定 2:3 竖版输出',
      models: [{ id: 'm', sizes: [] }],
    })
    const spec = result.providers[0].modelSpecs[0]
    // fixedSizeNote stays in its own slot; the hint slot stays empty.
    expect(spec.fixedSizeNote).toBe('固定 2:3 竖版输出')
    expect(spec.note).toBeNull()
  })

  it('truncates long notes to 80 characters', () => {
    const result = load({
      ...MODEL_PROVIDER,
      models: [{ id: 'm', note: 'x'.repeat(120) }],
    })
    expect(result.providers[0].modelSpecs[0].note).toHaveLength(80)
  })

  it('keeps disabledModels out of models and deduplicates against it', () => {
    const result = load({
      ...MODEL_PROVIDER,
      disabledModels: [
        'gpt-image-1',
        { id: 'nano-banana-pro', reason: '上游无可用渠道' },
        { id: 'gpt-image-2' }, // already enabled — ignored
        'grok-imagine-video', // already enabled — ignored
        '   ',
        42,
      ],
    })
    const p = result.providers[0]
    expect(p.models).not.toContain('gpt-image-1')
    expect(p.disabledModels).toEqual([
      { id: 'gpt-image-1', reason: '上游暂无可用渠道' },
      { id: 'nano-banana-pro', reason: '上游无可用渠道' },
    ])
    expect(result.warnings.filter((w) => w.includes('already listed'))).toHaveLength(2)
    expect(result.warnings.filter((w) => w.includes('id must be a non-empty string'))).toHaveLength(2)
  })

  it('warns for editModels entries that match no model (diagnostic, not widening)', () => {
    const result = load({
      ...MODEL_PROVIDER,
      editModels: ['grok-imagine-image', 'typo-model', 7],
    })
    // 'grok-imagine-image' matches (and thereby opts that model into edits);
    // the other two each get one warning. The derived surface only ever
    // contains real model ids, in spec order.
    expect(result.warnings.filter((w) => w.includes('editModels entry'))).toHaveLength(2)
    expect(result.providers[0].editModels).toEqual(['grok-imagine-image', 'gemini-3.1-flash-image'])
  })
})

it('warns when both the file and inline config env are set (file wins)', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'oneimage-cfg-'))
  const file = join(dir, 'imagegen.json')
  await writeFile(file, JSON.stringify({ providers: [VALID_PROVIDER] }))
  const result = loadImagegenConfig({
    ONEIMAGE_IMAGE_PROVIDERS_FILE: file,
    ONEIMAGE_IMAGE_PROVIDERS: JSON.stringify({ providers: [] }),
  })
  expect(result.providers).toHaveLength(1)
  expect(result.warnings.some((w) => w.includes('the file wins'))).toBe(true)
})
