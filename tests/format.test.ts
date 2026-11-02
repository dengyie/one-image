import { describe, expect, it } from 'vitest'
import { formatBytes } from '../src/domain/format'

describe('formatBytes', () => {
  it('normalizes zero and negatives', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
  })

  it('formats bytes without decimals', () => {
    expect(formatBytes(1)).toBe('1 B')
    expect(formatBytes(512)).toBe('512 B')
  })

  it('formats KB and MB with one decimal', () => {
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(25 * 1024 * 1024)).toBe('25.0 MB')
  })

  it('supports GB for large estimates', () => {
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.0 GB')
  })

  it('treats non-finite input as zero', () => {
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})
