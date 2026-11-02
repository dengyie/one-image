import React from 'react'
import { formatBytes as formatSize } from '../../../domain/format'
import { UiIcon } from '../../ui/UiIcon'

interface CompressSubToolbarProps {
  currentMime: string
  quality: number
  estimatedBytes: number | null
  originalBytes: number
  stripMetadata: boolean
  isCheckingProvenance?: boolean
  provenanceResult?: { detected: boolean; note?: string } | null
  onMimeSelect: (mime: string) => void
  onQualityChange: (quality: number) => void
  onToggleStripMetadata: () => void
  onCheckProvenance: () => void
}

const FORMATS = [
  { label: 'WebP', mime: 'image/webp', desc: '体积最小' },
  { label: 'PNG', mime: 'image/png', desc: '无损透底' },
  { label: 'JPEG', mime: 'image/jpeg', desc: '通用兼容' },
  { label: 'AVIF', mime: 'image/avif', desc: '高压缩率' },
]

export const CompressSubToolbar: React.FC<CompressSubToolbarProps> = ({
  currentMime,
  quality,
  estimatedBytes,
  originalBytes,
  stripMetadata,
  isCheckingProvenance = false,
  provenanceResult,
  onMimeSelect,
  onQualityChange,
  onToggleStripMetadata,
  onCheckProvenance,
}) => {
  // Calculate compression ratio
  const ratio =
    estimatedBytes && originalBytes > 0
      ? Math.round(((originalBytes - estimatedBytes) / originalBytes) * 100)
      : null

  return (
    <div className="flex flex-col gap-2 p-3 rounded-2xl bg-zinc-900/95 backdrop-blur-2xl border border-white/10 shadow-2xl text-xs text-zinc-300 max-w-md w-full">
      {/* Format pills */}
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1">
          {FORMATS.map((f) => (
            <button
              key={f.mime}
              onClick={() => onMimeSelect(f.mime)}
              className={`px-2.5 py-1 rounded-xl text-[11px] font-mono transition-all ${
                currentMime === f.mime
                  ? 'bg-emerald-500 text-zinc-950 font-medium shadow-md shadow-emerald-500/20'
                  : 'bg-zinc-800/60 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Live Estimated Size Badge (Squoosh-style) */}
        {estimatedBytes !== null && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-lg bg-zinc-800/80 border border-zinc-700/60 text-[11px] font-mono">
            <span className="text-zinc-300">预估 {formatSize(estimatedBytes)}</span>
            {ratio !== null && ratio > 0 ? (
              <span className="text-emerald-400 font-semibold">↓{ratio}%</span>
            ) : ratio !== null && ratio < 0 ? (
              <span className="text-amber-400 font-semibold">↑{Math.abs(ratio)}%</span>
            ) : null}
          </div>
        )}
      </div>

      {/* Quality slider (hidden for PNG) */}
      {currentMime !== 'image/png' && (
        <div className="flex items-center gap-3 pt-1">
          <span className="text-[11px] text-zinc-400 w-14">质量级别</span>
          <input
            type="range"
            min={10}
            max={100}
            value={quality}
            onChange={(e) => onQualityChange(Number(e.target.value))}
            className="flex-1"
          />
          <span className="text-[11px] font-mono text-zinc-300 w-8 text-right">
            {quality}%
          </span>
        </div>
      )}

      {/* Bottom toggles: Metadata & Provenance */}
      <div className="flex items-center justify-between border-t border-zinc-800/80 pt-2 text-[11px]">
        <label className="flex items-center gap-2 cursor-pointer select-none text-zinc-400 hover:text-zinc-200">
          <input
            type="checkbox"
            checked={stripMetadata}
            onChange={onToggleStripMetadata}
            className="rounded border-zinc-700 bg-zinc-800 text-emerald-500 focus:ring-0"
          />
          <UiIcon name="shield-check" size={13} className="text-emerald-400" />
          <span>抹除 EXIF / GPS 隐私元数据</span>
        </label>

        <button
          onClick={onCheckProvenance}
          disabled={isCheckingProvenance}
          className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-zinc-800/60 hover:bg-zinc-800 text-zinc-400 hover:text-emerald-400 transition-colors disabled:opacity-50"
        >
          {isCheckingProvenance ? (
            <span className="animate-spin">
              <UiIcon name="loader" size={12} />
            </span>
          ) : (
            <UiIcon name="sparkles" size={12} className="text-amber-400" />
          )}
          <span>{provenanceResult ? (provenanceResult.detected ? '已检出 AI 信号' : '未检出 AI 信号') : '检测 AI 来源'}</span>
        </button>
      </div>

      {provenanceResult && provenanceResult.note && (
        <div className="text-[10px] text-zinc-400 bg-zinc-800/40 p-1.5 rounded-lg border border-zinc-800 font-mono">
          {provenanceResult.note}
        </div>
      )}
    </div>
  )
}
