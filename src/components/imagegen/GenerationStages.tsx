import React, { useEffect, useState } from 'react'
import { UiIcon, type UiIconName } from '../ui/UiIcon'

/**
 * The generation wait state, designed against the "did it hang?" anxiety:
 * a shimmering canvas-shaped placeholder, a stage ladder that advances with
 * elapsed time (normalized against the model's own upstream budget, so a
 * 5-11s grok and a 95s gemini both walk the full ladder), and a live
 * elapsed-seconds counter.
 *
 * Pure presentation: the parent keeps owning the fetch; this component only
 * renders what `timeoutMs` + a ticking clock imply.
 */

interface GenerationStagesProps {
  /** The model's upstream budget in ms; stages advance relative to it. */
  timeoutMs: number
  /** Number of images in flight; shown in the stage copy. */
  count: number
}

// Stage copy follows ChatGPT's cadence: short verb phrases, no fake
// percentages. The ladder is normalized: each boundary is a fraction of the
// model budget, capped so the last stage always has room to breathe.
const STAGES: { at: number; icon: UiIconName; label: (count: number) => string }[] = [
  { at: 0, icon: 'cloud', label: (n) => (n > 1 ? `提交 ${n} 个并行请求…` : '已提交请求…') },
  { at: 0.18, icon: 'sparkles', label: () => '构思画面…' },
  { at: 0.45, icon: 'brush', label: () => '绘制细节…' },
  { at: 0.75, icon: 'image', label: (n) => (n > 1 ? '汇总输出…' : '打磨输出…') },
]

// Long-poll requests behind Cloudflare can stretch well past the nominal
// budget (upstream 504 wins the race at ~budget+5s client-side). Stages stop
// advancing at 110% of budget and hold the last one instead of lying.
export const LADDER_CAP = 1.1

/** Pure stage-ladder resolver, exported for tests (node environment, no DOM). */
export function resolveStage(
  elapsedMs: number,
  timeoutMs: number,
  count: number,
): { icon: UiIconName; label: string; atMs: number; progress: number; overBudget: boolean } {
  const budget = Math.max(timeoutMs, 5_000)
  const capMs = budget * LADDER_CAP
  const ladder = STAGES.map((stage) => ({ ...stage, atMs: stage.at * budget }))
  const current = ladder.reduce((acc, stage) => (elapsedMs >= stage.atMs ? stage : acc), ladder[0])
  return {
    icon: current.icon,
    label: current.label(count),
    atMs: current.atMs,
    progress: Math.min(100, (elapsedMs / capMs) * 100),
    overBudget: elapsedMs > capMs,
  }
}

export const GenerationStages: React.FC<GenerationStagesProps> = ({ timeoutMs, count }) => {
  const [elapsedMs, setElapsedMs] = useState(0)
  useEffect(() => {
    const started = performance.now()
    const timer = window.setInterval(() => {
      setElapsedMs(performance.now() - started)
    }, 250)
    return () => window.clearInterval(timer)
  }, [])

  const current = resolveStage(elapsedMs, timeoutMs, count)
  const seconds = Math.floor(elapsedMs / 1000)

  return (
    <div className="flex flex-col gap-2.5" data-testid="generation-stages">
      <div className="flex items-center gap-2 text-xs text-zinc-300">
        <UiIcon name={current.icon} className="w-3.5 h-3.5 text-emerald-400 generation-stage-icon" />
        <span key={current.atMs} className="generation-stage-label">{current.label}</span>
        <span className="ml-auto tabular-nums text-zinc-500" title="已用时（估算自模型预算）">
          {seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`}
        </span>
      </div>
      {/* The ladder: elapsed time normalized to the budget, capped honestly. */}
      <div className="h-1 rounded-full bg-zinc-700/60 overflow-hidden">
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-[width] duration-300 ease-linear"
          style={{ width: `${current.progress}%` }}
        />
      </div>
      {current.overBudget && (
        <p className="text-[11px] text-amber-300/90 leading-tight">
          已超过模型常规预算，仍在等待上游响应——即将到达客户端上限并返回具体错误。
        </p>
      )}
    </div>
  )
}

interface GenerationPreviewProps {
  /** Aspect ratio hint from the requested size, e.g. "1536x1024". */
  size?: string
  /** The child in the middle of the shimmer frame (spinner/ladder). */
  children?: React.ReactNode
}

/** "widthxheight" → a CSS aspect-ratio value, or undefined when unusable. */
function aspectOf(size?: string): string | undefined {
  const match = /^(\d+)x(\d+)$/.exec(size ?? '')
  if (!match) return undefined
  const w = Number(match[1])
  const h = Number(match[2])
  if (!(w > 0 && h > 0)) return undefined
  return `${w} / ${h}`
}

/**
 * The Gemini-style shimmer placeholder: a canvas-proportioned frame whose
 * surface sweeps light while the request is in flight. Replaces the bare
 * spinner-in-a-button with something that reads as "a picture is coming".
 */
export const GenerationPreview: React.FC<GenerationPreviewProps> = ({ size, children }) => {
  const aspect = aspectOf(size)
  return (
    <div
      className="relative w-full max-w-[280px] mx-auto rounded-xl border border-zinc-700/80 bg-zinc-800/40 overflow-hidden"
      style={aspect ? { aspectRatio: aspect } : { height: 160 }}
      data-testid="generation-preview"
    >
      <div className="absolute inset-0 generation-shimmer" />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
        {children ?? (
          <UiIcon name="sparkles" className="w-5 h-5 text-emerald-400/90 generation-sparkle" />
        )}
      </div>
    </div>
  )
}
