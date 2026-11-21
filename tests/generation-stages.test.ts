import { describe, expect, it } from 'vitest'
import { resolveStage, VIDEO_STAGES } from '../src/components/imagegen/GenerationStages'

// The wait-state ladder is pure logic resolved against the model's own
// upstream budget: the component renders, this suite pins the decisions a
// user reads while waiting.

describe('generation stage ladder', () => {
  it('walks all four stages in order for a slow model (95s gemini)', () => {
    const budget = 95_000
    expect(resolveStage(0, budget, 1).label).toBe('已提交请求…')
    expect(resolveStage(budget * 0.2, budget, 1).label).toBe('构思画面…')
    expect(resolveStage(budget * 0.5, budget, 1).label).toBe('绘制细节…')
    expect(resolveStage(budget * 0.8, budget, 1).label).toBe('打磨输出…')
  })

  it('compresses the same ladder for a fast model (8s grok) on the same fractions', () => {
    const budget = 8_000
    expect(resolveStage(500, budget, 1).label).toBe('已提交请求…')
    expect(resolveStage(1_500, budget, 1).label).toBe('构思画面…')
    expect(resolveStage(4_000, budget, 1).label).toBe('绘制细节…')
    expect(resolveStage(7_000, budget, 1).label).toBe('打磨输出…')
  })

  it('pluralizes the submit stage copy for parallel batches', () => {
    const budget = 90_000
    expect(resolveStage(0, budget, 4).label).toBe('提交 4 个并行请求…')
    expect(resolveStage(budget, budget, 4).label).toBe('汇总输出…')
  })

  it('progress saturates at 100% and never reports over-budget before the cap', () => {
    const budget = 90_000
    const mid = resolveStage(45_000, budget, 1)
    expect(mid.progress).toBeGreaterThan(40)
    expect(mid.progress).toBeLessThan(50)
    expect(mid.overBudget).toBe(false)
    const atCap = resolveStage(budget * 1.1 + 1, budget, 1)
    expect(atCap.progress).toBe(100)
    expect(atCap.overBudget).toBe(true)
    // The stage holds the last one instead of inventing a fifth.
    expect(atCap.label).toBe('打磨输出…')
  })

  it('clamps a degenerate zero budget to the 5s floor', () => {
    const stage = resolveStage(1_000, 0, 1)
    expect(stage.label).toBe('构思画面…') // 1s ≥ 0.18 × 5s
    expect(stage.overBudget).toBe(false) // 1s < 1.1 × 5s
  })

  it('walks the video ladder on the same fractions for a 95s clip', () => {
    const budget = 95_000
    expect(resolveStage(0, budget, 1, VIDEO_STAGES.map((s) => ({ ...s, label: () => s.label }))).label).toBe('已提交请求…')
    expect(resolveStage(budget * 0.2, budget, 1, VIDEO_STAGES.map((s) => ({ ...s, label: () => s.label }))).label).toBe('分镜构思…')
    expect(resolveStage(budget * 0.5, budget, 1, VIDEO_STAGES.map((s) => ({ ...s, label: () => s.label }))).label).toBe('逐帧渲染…')
    expect(resolveStage(budget * 0.8, budget, 1, VIDEO_STAGES.map((s) => ({ ...s, label: () => s.label }))).label).toBe('编码输出…')
  })

  it('holds the last video stage past the cap and never invents a fifth', () => {
    const ladder = VIDEO_STAGES.map((s) => ({ ...s, label: () => s.label }))
    const atCap = resolveStage(95_000 * 1.1 + 1, 95_000, 1, ladder)
    expect(atCap.label).toBe('编码输出…')
    expect(atCap.overBudget).toBe(true)
    expect(atCap.progress).toBe(100)
  })
})
