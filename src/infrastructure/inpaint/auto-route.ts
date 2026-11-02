// Chooses a filler for a smart-erase run. Both fillers exist so the app can
// match the tool to the hole instead of forcing every edit through one model:
//
//   - classical  push-pull diffusion: no download, no resampling, exact outside
//                the mask. Ideal for small holes (thin watermark strokes,
//                dust, stray specks) where a generative fill would only lose
//                detail it never needed to invent.
//   - migan      the MI-GAN pipeline: synthesizes plausible structure for larger
//                holes, at the cost of its internal 512px working resolution.
//
// Auto routing picks classical only for holes small enough that diffusion is
// indistinguishable from (and strictly safer than) a generated fill.
//
// Pure module (no canvas, no DOM) so it runs and tests in Node.

import type { RgbaGrid } from './mask-refine'
import { countHolePixels } from './classical-fill'

export type FillProvider = 'classical' | 'migan' | 'blur' | 'pixel' | 'solid'
/** What the user picked in the toolbar. The erase tab's blur/pixel/blackout
 * options map straight onto the last three; `routeFill` only ever returns the
 * first two because routing applies to the smart-repair mode alone. */
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
    provider: 'migan',
    coverage,
    holePixels,
    reason: `选区较大（${holePixels}px），使用 MI-GAN 合成填充`,
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
