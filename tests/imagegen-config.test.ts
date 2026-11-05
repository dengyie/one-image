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
        providers: [{ ...VALID_PROVIDER, sizes: ['1024x1024'], fixedSizeNote: '固定 1:1' }],
      }),
    })
    expect(result.providers[0].fixedSizeNote).toBeUndefined()
    expect(result.warnings.join('\n')).toContain('fixedSizeNote is unused because sizes is set')
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
