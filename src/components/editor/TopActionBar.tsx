import React, { useState, useRef, useEffect } from 'react'
import { formatBytes as formatSize } from '../../domain/format'
import { UiIcon } from '../ui/UiIcon'

interface TopActionBarProps {
  fileName: string
  fileSize: number
  dimensions: { width: number; height: number }
  zoomPercent: number
  canUndo: boolean
  canRedo: boolean
  /** Reset is meaningful for any uncommitted work, not just committed steps. */
  canReset: boolean
  isComparingOriginal: boolean
  isProcessing?: boolean
  onUndo: () => void
  onRedo: () => void
  onRevert: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
  onCompareStart: () => void
  onCompareEnd: () => void
  onReplaceImage: () => void
  onQuickExport: () => void
  onExportFormat: (mime: string) => void
  onCopyToClipboard: () => void
  /** Present only when the server exposes imagegen providers. */
  onOpenImageGen?: () => void
}

export const TopActionBar: React.FC<TopActionBarProps> = ({
  fileName,
  fileSize,
  dimensions,
  zoomPercent,
  canUndo,
  canRedo,
  canReset,
  isComparingOriginal,
  isProcessing = false,
  onUndo,
  onRedo,
  onRevert,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onCompareStart,
  onCompareEnd,
  onReplaceImage,
  onQuickExport,
  onExportFormat,
  onCopyToClipboard,
  onOpenImageGen,
}) => {
  const [showExportMenu, setShowExportMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <header className="fixed top-14 sm:top-3 inset-x-0 z-40 mx-auto flex w-fit max-w-[calc(100vw-1rem)] items-center gap-1 whitespace-nowrap px-3 py-1.5 rounded-full bg-zinc-900/85 backdrop-blur-2xl border border-white/10 shadow-2xl shadow-black/60 text-xs text-zinc-300 transition-all select-none sm:gap-2">
      {/* File info pill */}
      <div className="hidden sm:flex min-w-0 items-center gap-1.5 px-2 py-1 rounded-full bg-zinc-800/60 border border-zinc-700/40 text-[11px] text-zinc-400 font-mono">
        <span className="max-w-[120px] lg:max-w-[220px] truncate text-zinc-200" title={fileName}>
          {fileName}
        </span>
        <span className="shrink-0 text-zinc-600">·</span>
        <span className="shrink-0">
          {dimensions.width}×{dimensions.height}
        </span>
        <span className="shrink-0 text-zinc-600">·</span>
        <span className="shrink-0">{formatSize(fileSize)}</span>
      </div>

      <div className="hidden sm:block w-px h-4 bg-zinc-800 mx-0.5 shrink-0" />

      {/* History buttons */}
      <div className="flex shrink-0 items-center gap-0.5">
        {onOpenImageGen && (
          <button
            onClick={onOpenImageGen}
            title="AI 生图"
            className="p-1.5 rounded-full hover:bg-zinc-800 text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            <UiIcon name="sparkles" size={15} />
          </button>
        )}
        <button
          onClick={onUndo}
          disabled={!canUndo}
          title="撤销 (⌘Z)"
          className="p-1.5 rounded-full hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent text-zinc-300 hover:text-zinc-100 transition-colors"
        >
          <UiIcon name="undo" size={15} />
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          title="重做 (⌘⇧Z)"
          className="p-1.5 rounded-full hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent text-zinc-300 hover:text-zinc-100 transition-colors"
        >
          <UiIcon name="redo" size={15} />
        </button>
        <button
          onClick={onRevert}
          disabled={!canReset}
          title="重置全部更改"
          className="p-1.5 rounded-full hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent text-zinc-400 hover:text-rose-400 transition-colors"
        >
          <UiIcon name="refresh" size={15} />
        </button>
      </div>

      <div className="w-px h-4 bg-zinc-800 mx-0.5 shrink-0" />

      {/* Compare original */}
      <button
        onMouseDown={onCompareStart}
        onMouseUp={onCompareEnd}
        onMouseLeave={onCompareEnd}
        onTouchStart={onCompareStart}
        onTouchEnd={onCompareEnd}
        onTouchCancel={onCompareEnd}
        title="按住查看原图 (\ 键)"
        className={`flex shrink-0 items-center gap-1 px-2.5 py-1 rounded-full transition-all text-[11px] ${
          isComparingOriginal
            ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40 shadow-inner'
            : 'bg-zinc-800/50 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-transparent'
        }`}
      >
        <UiIcon name="eye" size={13} />
        <span className="hidden md:inline">原图对比</span>
      </button>

      <div className="w-px h-4 bg-zinc-800 mx-0.5 shrink-0" />

      {/* Zoom controls */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          onClick={onZoomOut}
          title="缩小 (滚轮下滑)"
          className="p-1.5 rounded-full hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <UiIcon name="zoom-out" size={14} />
        </button>
        <button
          onClick={onZoomReset}
          title="点击适应屏幕 / 100%"
          className="px-1.5 py-0.5 rounded text-[11px] font-mono text-zinc-300 hover:text-emerald-400 hover:bg-zinc-800 transition-colors min-w-[42px] text-center"
        >
          {zoomPercent}%
        </button>
        <button
          onClick={onZoomIn}
          title="放大 (滚轮上滑)"
          className="p-1.5 rounded-full hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <UiIcon name="zoom-in" size={14} />
        </button>
      </div>

      <div className="hidden md:block w-px h-4 bg-zinc-800 mx-0.5 shrink-0" />

      {/* Replace image */}
      <button
        onClick={onReplaceImage}
        title="更换图片"
        className="hidden md:flex shrink-0 items-center gap-1 px-2.5 py-1 rounded-full hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 text-[11px] transition-colors"
      >
        <UiIcon name="image" size={13} />
        <span>换图</span>
      </button>

      {/* Quick Export CTA & Split Dropdown */}
      <div className="relative flex shrink-0 items-center" ref={menuRef}>
        <button
          onClick={onQuickExport}
          disabled={isProcessing}
          className="flex items-center gap-1 px-3 py-1 rounded-l-full bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-medium text-xs shadow-lg shadow-emerald-500/20 transition-all disabled:opacity-50"
        >
          {isProcessing ? (
            <span className="animate-spin">
              <UiIcon name="loader" size={13} />
            </span>
          ) : (
            <UiIcon name="download" size={13} strokeWidth={2.2} />
          )}
          <span>保存</span>
        </button>
        <button
          onClick={() => setShowExportMenu((v) => !v)}
          className="px-1.5 py-1 rounded-r-full bg-emerald-600 hover:bg-emerald-500 text-zinc-950 border-l border-emerald-700 transition-colors"
          title="更多导出选项"
        >
          <UiIcon name="chevron-down" size={12} strokeWidth={2.2} />
        </button>

        {showExportMenu && (
          <div className="absolute right-0 top-full mt-2 w-44 py-1.5 rounded-2xl bg-zinc-900/95 backdrop-blur-2xl border border-zinc-700/80 shadow-2xl shadow-black/80 z-50 text-xs animate-in fade-in slide-in-from-top-1 duration-150">
            <button
              onClick={() => {
                setShowExportMenu(false)
                onCopyToClipboard()
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-left text-zinc-200 hover:bg-zinc-800/80 hover:text-emerald-400 transition-colors"
            >
              <UiIcon name="clipboard" size={14} />
              <span>复制到剪贴板</span>
              <kbd className="ml-auto text-[10px] text-zinc-500 font-mono">⌘C</kbd>
            </button>
            <div className="my-1 border-t border-zinc-800" />
            <div className="px-3 py-1 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
              导出格式
            </div>
            {[
              { label: 'WebP (推荐 · 最小)', mime: 'image/webp' },
              { label: 'PNG (无损透底)', mime: 'image/png' },
              { label: 'JPEG (通用兼容)', mime: 'image/jpeg' },
              { label: 'AVIF (超高压缩率)', mime: 'image/avif' },
            ].map((fmt) => (
              <button
                key={fmt.mime}
                onClick={() => {
                  setShowExportMenu(false)
                  onExportFormat(fmt.mime)
                }}
                className="w-full flex items-center justify-between px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800/80 hover:text-emerald-400 transition-colors text-[11px]"
              >
                <span>{fmt.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </header>
  )
}
