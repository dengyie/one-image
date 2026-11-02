import React from 'react'
import { formatBytes } from '../../domain/format'

/**
 * One entry of the multi-image working set: a user-loaded image with its own
 * decoupled session. `rootId` is the session key — derived documents (erase
 * results) stay inside their root's history and never get a list entry.
 */
export interface OpenImageItem {
  rootId: string
  name: string
  width: number
  height: number
  size: number
  url: string
}

interface ImageListPanelProps {
  images: OpenImageItem[]
  activeRootId: string | null
  /** While an erase run owns the active session, switching/closing is blocked. */
  disabled?: boolean
  onSelect: (rootId: string) => void
  onClose: (rootId: string) => void
}

/**
 * Left-side working-set list, shown once more than one image is open. Same
 * glass-panel language as the tool sub-toolbars (zinc-900/95 + backdrop blur +
 * white/10 border); the active image carries the emerald ring.
 */
export const ImageListPanel: React.FC<ImageListPanelProps> = ({ images, activeRootId, disabled = false, onSelect, onClose }) => {
  if (images.length < 2) return null

  return (
    <aside
      data-testid="image-list-panel"
      className={`absolute left-3 top-20 bottom-28 z-30 w-[104px] flex flex-col rounded-2xl bg-zinc-900/95 backdrop-blur-2xl border border-white/10 shadow-2xl overflow-hidden ${disabled ? 'opacity-60' : ''}`}
    >
      <div className="px-2.5 pt-2 pb-1.5 text-[10px] font-medium text-zinc-500 border-b border-zinc-800/80 shrink-0">
        图片 · {images.length}
      </div>
      <div className="flex-1 overflow-y-auto p-1.5 flex flex-col gap-1.5">
        {images.map((img) => {
          const active = img.rootId === activeRootId
          return (
            <div key={img.rootId} className="relative group shrink-0">
              <button
                type="button"
                disabled={disabled}
                onClick={() => onSelect(img.rootId)}
                title={`${img.name} · ${img.width}×${img.height} · ${formatBytes(img.size)}`}
                className={`w-full text-left rounded-xl p-1 transition-all border ${
                  active
                    ? 'bg-zinc-800/80 border-emerald-500/60 shadow-md shadow-emerald-500/10'
                    : 'bg-zinc-800/30 border-transparent hover:bg-zinc-800/60 hover:border-zinc-700'
                }`}
              >
                <img
                  src={img.url}
                  alt={img.name}
                  className={`w-full aspect-[4/3] object-cover rounded-lg ${active ? 'ring-1 ring-emerald-400/70' : 'ring-1 ring-white/5'}`}
                />
                <div className="px-0.5 pt-1 pb-0.5">
                  <div className={`text-[10px] truncate ${active ? 'text-emerald-300' : 'text-zinc-300'}`}>{img.name}</div>
                  <div className="text-[9px] text-zinc-500 font-mono">
                    {img.width}×{img.height} · {formatBytes(img.size)}
                  </div>
                </div>
              </button>
              {images.length > 1 && (
                <button
                  type="button"
                  disabled={disabled}
                  title="从工作区移除"
                  onClick={(e) => {
                    e.stopPropagation()
                    onClose(img.rootId)
                  }}
                  className="absolute -top-1.5 -right-1.5 w-4.5 h-4.5 min-w-[18px] min-h-[18px] hidden group-hover:flex items-center justify-center rounded-full bg-zinc-700 hover:bg-rose-500 text-zinc-200 hover:text-white text-[9px] leading-none shadow-md transition-colors"
                >
                  ✕
                </button>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
