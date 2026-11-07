import React, { useRef, useState } from 'react'
import { UiIcon } from '../ui/UiIcon'

export interface RecentItemPreview {
  id: string
  title: string
  thumbnail: string
  dimensions?: { width: number; height: number }
  updatedAt: number
}

interface EmptyDropzoneProps {
  onFileSelect: (file: File) => void
  error?: string | null
  recentItems?: RecentItemPreview[]
  onSelectRecent?: (id: string) => void
  onViewAllHistory?: () => void
  /** Present only when the server exposes imagegen providers. */
  onOpenImageGen?: () => void
  /** Present only when the server exposes video models. */
  onOpenVideoGen?: () => void
}

function formatRelativeTime(timestamp: number): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000)
  if (diffSec < 60) return '刚刚'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export const EmptyDropzone: React.FC<EmptyDropzoneProps> = ({
  onFileSelect,
  error,
  recentItems = [],
  onSelectRecent,
  onViewAllHistory,
  onOpenImageGen,
  onOpenVideoGen,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      onFileSelect(e.dataTransfer.files[0])
    }
  }

  return (
    <div
      className={`relative w-full h-full flex flex-col items-center justify-center p-6 transition-all duration-300 overflow-y-auto ${
        isDragOver ? 'bg-zinc-900/60' : 'bg-transparent'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/avif"
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files[0]) {
            onFileSelect(e.target.files[0])
          }
        }}
      />

      {/* Heroic Drop Card */}
      <div
        onClick={() => fileInputRef.current?.click()}
        className={`group relative max-w-md w-full flex flex-col items-center justify-center p-10 rounded-3xl cursor-pointer transition-all duration-300 border ${
          isDragOver
            ? 'border-emerald-500 bg-emerald-950/20 shadow-2xl shadow-emerald-500/20 scale-[1.02]'
            : 'border-zinc-800 hover:border-zinc-700 bg-zinc-900/40 hover:bg-zinc-900/70 shadow-2xl backdrop-blur-xl'
        }`}
      >
        <div className="w-16 h-16 rounded-2xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center mb-6 text-zinc-300 group-hover:text-emerald-400 group-hover:scale-110 transition-all duration-300 shadow-inner">
          <UiIcon name="image" size={32} strokeWidth={1.5} />
        </div>

        <h2 className="text-xl font-medium text-zinc-100 mb-2 tracking-tight">
          拖入图片，或点击选择
        </h2>

        <p className="text-sm text-zinc-400 text-center mb-6 max-w-xs leading-relaxed">
          纯浏览器本地处理 · 原图不离开设备
          <br />
          支持快捷键 <kbd className="px-1.5 py-0.5 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-300 font-mono">⌘V</kbd> 直接粘贴
        </p>

        <div className="flex items-center gap-2">
          {['JPEG', 'PNG', 'WebP', 'AVIF'].map((fmt) => (
            <span
              key={fmt}
              className="text-[11px] font-mono tracking-wider px-2.5 py-1 rounded-full bg-zinc-800/70 text-zinc-400 border border-zinc-700/50"
            >
              {fmt}
            </span>
          ))}
          <span className="text-[11px] font-mono text-zinc-500 pl-1">≤ 25MB</span>
        </div>

        {error && (
          <div className="mt-4 px-3 py-1.5 text-xs text-rose-400 bg-rose-950/40 border border-rose-800/60 rounded-xl">
            {error}
          </div>
        )}
      </div>

      {(onOpenImageGen || onOpenVideoGen) && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {onOpenImageGen && (
            <button
              onClick={onOpenImageGen}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-xs font-medium text-emerald-300 bg-emerald-950/40 border border-emerald-500/30 hover:bg-emerald-900/50 hover:border-emerald-400/50 transition-all"
            >
              <UiIcon name="sparkles" size={14} />
              没有素材？用 AI 生成一张
            </button>
          )}
          {onOpenVideoGen && (
            <button
              onClick={onOpenVideoGen}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-xs font-medium text-emerald-300 bg-emerald-950/40 border border-emerald-500/30 hover:bg-emerald-900/50 hover:border-emerald-400/50 transition-all"
            >
              <UiIcon name="film" size={14} />
              用 AI 生成一段视频
            </button>
          )}
        </div>
      )}

      {/* Recent Projects Shelf */}
      {recentItems.length > 0 && (
        <div className="max-w-xl w-full mt-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <div className="flex items-center justify-between mb-3 px-1">
            <span className="text-xs font-semibold text-zinc-400 flex items-center gap-1.5">
              <UiIcon name="clock" size={14} className="text-emerald-400" />
              <span>最近编辑草稿</span>
            </span>
            {onViewAllHistory && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onViewAllHistory()
                }}
                className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                查看全部 ({recentItems.length}) →
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {recentItems.slice(0, 4).map((item) => (
              <div
                key={item.id}
                onClick={(e) => {
                  e.stopPropagation()
                  onSelectRecent?.(item.id)
                }}
                className="group relative flex flex-col p-2 rounded-2xl bg-zinc-900/40 hover:bg-zinc-900/80 border border-white/5 hover:border-white/15 cursor-pointer transition-all shadow-sm hover:scale-[1.03]"
              >
                <div className="w-full aspect-[4/3] rounded-xl overflow-hidden bg-zinc-950 mb-2 relative">
                  {item.thumbnail ? (
                    <img
                      src={item.thumbnail}
                      alt={item.title}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-zinc-700">
                      <UiIcon name="image" size={20} />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-white text-[11px] font-medium">
                    继续编辑
                  </div>
                </div>
                <div className="text-[11px] font-medium text-zinc-200 truncate px-1">
                  {item.title}
                </div>
                <div className="text-[10px] text-zinc-500 truncate px-1 mt-0.5">
                  {formatRelativeTime(item.updatedAt)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
