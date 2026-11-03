// Chooses a filler for a smart-erase run. Both fillers exist so the app can
// match the tool to the hole instead of forcing every edit through one model:
//
//   - classical  push-pull diffusion: no download, no resampling, exact outside
//                the mask. Ideal for small holes (thin watermark strokes,
//                dust, stray specks) where any resampling would only lose
//                detail it never needed to invent.
//   - blur       Gaussian-style obscure fill (fillHolesBlur): floods the hole
//                with a σ-adapted blur of its neighbourhood. Its failure mode
//                is a soft frost patch; it can never hallucinate.
//
// Auto routing never sends a watermark hole to MI-GAN: on textured photo
// backgrounds the generative fill comes back as a visibly darker, structurally
// wrong patch (the exact "the tool covered my picture" complaint), while the
// local fillers degrade gracefully. MI-GAN remains available as the explicit
// 标准 engine for flat-background holes where synthesis does help.
//
// Pure module (no canvas, no DOM) so it runs and tests in Node.

import type { RgbaGrid } from './mask-refine'
import { countHolePixels } from './classical-fill'

export type FillProvider = 'classical' | 'migan' | 'blur' | 'pixel' | 'solid'
/** What the user picked in the toolbar. The erase tab's blur/pixel/blackout
 * options map straight onto the last three; `routeFill` only ever returns the
 * first two for the smart-repair mode because routing must stay predictable
 * and model-free unless the user explicitly picks MI-GAN. */
export type SmartEraseMode = 'auto' | 'classical' | 'migan'

export interface RouteInput {
  mode: SmartEraseMode
  /** Binary hole mask, same size as the image (white = hole). */
  mask: RgbaGrid
  imageWidth: number
  imageHeight: number
}

export interface RouteDecision {
  provider: FillProvider
  /** Share of the frame covered by the hole, in [0, 1]. */
  coverage: number
  holePixels: number
  /** Human-readable reason, surfaced in the progress UI. */
  reason: string
}

/** Holes at or below this many pixels are handled by diffusion in auto mode. */
export const AUTO_CLASSICAL_MAX_PIXELS = 4000
/** ...or at or below this share of the frame. */
export const AUTO_CLASSICAL_MAX_COVERAGE = 0.002

export function routeFill(input: RouteInput): RouteDecision {
  const holePixels = countHolePixels(input.mask)
  const total = Math.max(1, input.imageWidth * input.imageHeight)
  const coverage = holePixels / total

  if (input.mode === 'classical') {
    return { provider: 'classical', coverage, holePixels, reason: '已选择本地扩散填充' }
  }
  if (input.mode === 'migan') {
    return { provider: 'migan', coverage, holePixels, reason: '已选择 MI-GAN 合成填充' }
  }
  if (holePixels === 0) {
    return { provider: 'classical', coverage, holePixels, reason: '选区为空，无需填充' }
  }
  if (holePixels <= AUTO_CLASSICAL_MAX_PIXELS || coverage <= AUTO_CLASSICAL_MAX_COVERAGE) {
    return {
      provider: 'classical',
      coverage,
      holePixels,
      reason: `选区较小（${holePixels}px），使用本地扩散填充，不重采样、不生成`,
    }
  }
  return {
    provider: 'blur',
    coverage,
    holePixels,
    reason: `选区较大（${holePixels}px），使用高斯磨砂填充，不生成、不改掩膜外像素`,
  }
}

/** What the erase tab's 消除方式 pills select. Lives beside the routing types
 * because the run handler resolves it onto a FillProvider. */
export type EraseKind = 'blur' | 'pixel' | 'blackout' | 'ai'

/** Maps the non-AI erase kinds onto their fillers. Blur and pixelate are
 * fillers in their own right; solid blackout is the guaranteed-cover filler
 * that keeps the drawn region untouched by refinement. The AI kind is resolved
 * by `routeFill` at the call site. */
export function resolveEraseProvider(kind: Exclude<EraseKind, 'ai'>): FillProvider {
  return kind === 'blackout' ? 'solid' : kind
}
