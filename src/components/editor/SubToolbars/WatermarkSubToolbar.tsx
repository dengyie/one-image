import React, { useState } from 'react'
import { UiIcon } from '../../ui/UiIcon'
import type { ProvenanceResult } from '../../../infrastructure/openai-provenance-adapter'
import type { SmartEraseStage } from '../../../infrastructure/inpaint/smart-erase'
import type { SmartEraseMode, EraseKind } from '../../../infrastructure/inpaint/auto-route'
import type { MosaicShape } from './MosaicSubToolbar'

export type WatermarkTab = 'add' | 'erase' | 'test'
export type WatermarkLayout = 'tile' | 'corner'
/** The toolbar's erase kinds, resolved onto fillers by `resolveEraseProvider`. */
export type WatermarkEraseType = EraseKind

export interface WatermarkSubToolbarProps {
  onAddWatermark: (options: { text: string; layout: WatermarkLayout; opacity: number; color: string }) => void
  onAddEraseRegion: () => void
  onCheckProvenance: (target: 'current' | 'original') => void
  isCheckingProvenance: boolean
  provenanceResult: ProvenanceResult | null
  provenanceError?: string | null
  /** Present when the current state has pending smart-erase regions. */
  hasEraseAiRegions?: boolean
  onRunErase?: (eraseType: WatermarkEraseType) => void
  isSmartErasing?: boolean
  smartEraseStage?: SmartEraseStage | null
  smartEraseError?: string | null
  /** Smart-erase mask shape: painted stroke vs toolbar-created box. */
  eraseMaskShape: MosaicShape
  eraseBrushSize: number
  /** Which filler to use for the smart eraser. */
  eraseMode: SmartEraseMode
  onEraseMaskShapeSelect: (shape: MosaicShape) => void
  onEraseBrushSizeSelect: (size: number) => void
  onEraseModeSelect: (mode: SmartEraseMode) => void
  /** Drops every pending smart-erase region. */
  onClearEraseRegions?: () => void
  /** Notifies the app which tab is visible, so canvas painting can be gated. */
  onTabChange?: (tab: WatermarkTab) => void
}

const ERASE_BRUSH_SIZES = [
  { label: '细', value: 16 },
  { label: '中', value: 32 },
  { label: '粗', value: 64 },
]

const ERASE_MODES: Array<{ value: SmartEraseMode; label: string; hint: string }> = [
  { value: 'auto', label: '自动', hint: '按选区大小自动选择：小选区本地扩散，大选区 MI-GAN 合成' },
  { value: 'classical', label: '快速', hint: '纯本地扩散填充：不下载模型、不重采样，掩膜外逐位不变' },
  { value: 'migan', label: '标准', hint: 'MI-GAN 合成填充：大选区结构更自然（首次需下载 27MB 模型）' },
]

const ERASE_TYPE_LABELS: Record<WatermarkEraseType, string> = {
  blur: '磨砂模糊',
  pixel: '像素打码',
  blackout: '实心遮蔽',
  ai: '智能修复',
}

const ERASE_TYPE_HINTS: Record<Exclude<WatermarkEraseType, 'ai'>, string> = {
  blur: '运行后对掩膜内的像素做高斯模糊（强度随选区自适应），掩膜先收紧到检测到的水印笔画；掩膜外像素逐位不变，原图不上传。',
  pixel: '运行后对掩膜内的像素做马赛克（块对齐全局网格），掩膜先收紧到检测到的水印笔画；掩膜外像素逐位不变。',
  blackout: '用纯色完整覆盖选区（不收紧到笔画，保证盖住一切残留）；掩膜外像素逐位不变。',
}

const WATERMARK_COLORS = [
  { label: '半透白', value: 'rgba(255, 255, 255, 0.85)' },
  { label: '暗夜黑', value: 'rgba(0, 0, 0, 0.75)' },
  { label: '警示红', value: 'rgba(239, 68, 68, 0.85)' },
  { label: '安全黄', value: 'rgba(234, 179, 8, 0.85)' },
]

export const WatermarkSubToolbar: React.FC<WatermarkSubToolbarProps> = ({
  onAddWatermark,
  onAddEraseRegion,
  onCheckProvenance,
  isCheckingProvenance,
  provenanceResult,
  provenanceError,
  hasEraseAiRegions = false,
  onRunErase,
  isSmartErasing = false,
  smartEraseStage,
  smartEraseError,
  eraseMaskShape,
  eraseBrushSize,
  eraseMode,
  onEraseMaskShapeSelect,
  onEraseBrushSizeSelect,
  onEraseModeSelect,
  onClearEraseRegions,
  onTabChange,
}) => {
  const [tab, setTab] = useState<WatermarkTab>('add')
  const selectTab = (next: WatermarkTab) => {
    setTab(next)
    onTabChange?.(next)
  }

  // Add watermark state
  const [text, setText] = useState('OneImage')
  const [layout, setLayout] = useState<WatermarkLayout>('tile')
  const [opacity, setOpacity] = useState(25)
  const [color, setColor] = useState(WATERMARK_COLORS[0].value)

  // Erase state
  const [eraseType, setEraseType] = useState<WatermarkEraseType>('blur')

  return (
    <div className="flex flex-col gap-2.5 p-3 rounded-2xl bg-zinc-900/95 backdrop-blur-2xl border border-white/10 shadow-2xl text-xs text-zinc-300 max-w-md w-full">
      {/* 3-in-1 Mode Tabs */}
      <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => selectTab('add')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-xl text-[11px] font-medium transition-all ${
              tab === 'add'
                ? 'bg-emerald-500 text-zinc-950 shadow-md shadow-emerald-500/20'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
            }`}
          >
            <UiIcon name="type" size={12} />
            <span>添加水印</span>
          </button>
          <button
            type="button"
            onClick={() => selectTab('erase')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-xl text-[11px] font-medium transition-all ${
              tab === 'erase'
                ? 'bg-emerald-500 text-zinc-950 shadow-md shadow-emerald-500/20'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
            }`}
          >
            <UiIcon name="mosaic" size={12} />
            <span>消除水印</span>
          </button>
          <button
            type="button"
            onClick={() => selectTab('test')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-xl text-[11px] font-medium transition-all ${
              tab === 'test'
                ? 'bg-emerald-500 text-zinc-950 shadow-md shadow-emerald-500/20'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
            }`}
          >
            <UiIcon name="shield-check" size={12} />
            <span>测试隐形水印</span>
          </button>
        </div>
      </div>

      {/* Tab 1: 添加水印 */}
      {tab === 'add' && (
        <div className="flex flex-col gap-2 pt-0.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-400 w-14 shrink-0">水印文字</span>
            <input
              type="text"
              value={text}
              maxLength={40}
              placeholder="输入水印文字..."
              onChange={(e) => setText(e.target.value)}
              className="flex-1 px-2.5 py-1 rounded-lg bg-zinc-800 border border-zinc-700/80 text-zinc-100 text-[11px] focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <span className="text-[11px] text-zinc-400 w-14 shrink-0">排版形式</span>
              <button
                type="button"
                onClick={() => setLayout('tile')}
                className={`px-2 py-0.5 rounded-lg text-[11px] transition-all ${
                  layout === 'tile'
                    ? 'bg-zinc-700 text-emerald-400 font-medium'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                45° 全图平铺
              </button>
              <button
                type="button"
                onClick={() => setLayout('corner')}
                className={`px-2 py-0.5 rounded-lg text-[11px] transition-all ${
                  layout === 'corner'
                    ? 'bg-zinc-700 text-emerald-400 font-medium'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                右下角落款
              </button>
            </div>

            {/* Color pills */}
            <div className="flex items-center gap-1">
              {WATERMARK_COLORS.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  onClick={() => setColor(c.value)}
                  className={`w-4 h-4 rounded-full border transition-all ${
                    color === c.value ? 'border-emerald-400 scale-110' : 'border-zinc-700 hover:scale-105'
                  }`}
                  style={{ backgroundColor: c.value }}
                  title={c.label}
                />
              ))}
            </div>
          </div>

          {/* Opacity slider */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-400 w-14 shrink-0">透明度</span>
            <input
              type="range"
              min={10}
              max={80}
              step={5}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              className="flex-1"
            />
            <span className="text-[11px] font-mono text-zinc-400 w-7 text-right">{opacity}%</span>
          </div>

          <button
            type="button"
            onClick={() => onAddWatermark({ text: text || 'OneImage', layout, opacity: opacity / 100, color })}
            className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-medium text-[11px] transition-all shadow-md shadow-emerald-500/20 active:scale-[0.99]"
          >
            <UiIcon name="check" size={13} strokeWidth={2.5} />
            <span>盖入当前画布（支持撤销/重做）</span>
          </button>
        </div>
      )}

      {/* Tab 2: 消除水印 */}
      {tab === 'erase' && (
        <div className="flex flex-col gap-2 pt-0.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-zinc-400 w-14 shrink-0">消除方式</span>
            <div className="flex items-center gap-1">
              {(Object.keys(ERASE_TYPE_LABELS) as WatermarkEraseType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setEraseType(type)}
                  className={`px-2.5 py-1 rounded-lg text-[11px] transition-all ${
                    eraseType === type
                      ? 'bg-zinc-700 text-emerald-400 font-medium shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {ERASE_TYPE_LABELS[type]}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-zinc-400 w-14 shrink-0">选区方式</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onEraseMaskShapeSelect('brush')}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] transition-all ${
                  eraseMaskShape === 'brush'
                    ? 'bg-zinc-700 text-emerald-400 font-medium shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <UiIcon name="brush" size={12} />
                <span>涂抹水印</span>
              </button>
              <button
                type="button"
                onClick={() => onEraseMaskShapeSelect('rect')}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] transition-all ${
                  eraseMaskShape === 'rect'
                    ? 'bg-zinc-700 text-emerald-400 font-medium shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <UiIcon name="square" size={12} />
                <span>框选水印</span>
              </button>
            </div>
          </div>

          {eraseMaskShape === 'brush' ? (
            <>
              <p className="text-[11px] text-zinc-400 leading-relaxed bg-zinc-800/40 p-2 rounded-lg border border-emerald-900/40">
                在画面上沿水印涂抹，只把笔迹覆盖的像素作为掩膜——笔迹外的背景完全不参与处理。
              </p>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-zinc-400 w-14 shrink-0">笔刷粗细</span>
                <div className="flex items-center gap-1">
                  {ERASE_BRUSH_SIZES.map((size) => (
                    <button
                      key={size.value}
                      type="button"
                      onClick={() => onEraseBrushSizeSelect(size.value)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] transition-all ${
                        eraseBrushSize === size.value
                          ? 'bg-zinc-700 text-emerald-400 font-medium shadow-sm'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {size.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={onAddEraseRegion}
              className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-medium text-[11px] transition-all shadow-md shadow-emerald-500/20 active:scale-[0.99]"
            >
              <UiIcon name="crop" size={13} strokeWidth={2.2} />
              <span>生成消除选框</span>
            </button>
          )}

          {eraseType === 'ai' && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] text-zinc-400 w-14 shrink-0">填充引擎</span>
              <div className="flex items-center gap-1">
                {ERASE_MODES.map((mode) => (
                  <button
                    key={mode.value}
                    type="button"
                    title={mode.hint}
                    onClick={() => onEraseModeSelect(mode.value)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] transition-all ${
                      eraseMode === mode.value
                        ? 'bg-zinc-700 text-emerald-400 font-medium shadow-sm'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <p className="text-[11px] text-zinc-400 leading-relaxed bg-zinc-800/40 p-2 rounded-lg border border-emerald-900/40">
            {eraseType === 'ai'
              ? `${ERASE_MODES.find((mode) => mode.value === eraseMode)?.hint}；掩膜外像素逐位保留，原图不上传。`
              : ERASE_TYPE_HINTS[eraseType]}
          </p>

          <button
            type="button"
            disabled={isSmartErasing || !hasEraseAiRegions}
            onClick={() => onRunErase?.(eraseType)}
            className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded-xl bg-sky-500 hover:bg-sky-400 disabled:bg-zinc-700 disabled:text-zinc-500 text-zinc-950 font-medium text-[11px] transition-all shadow-md shadow-sky-500/20 active:scale-[0.99]"
          >
            {isSmartErasing ? (
              <>
                <span className="animate-spin"><UiIcon name="loader" size={13} /></span>
                <span>
                  {eraseType !== 'ai'
                    ? '正在处理…'
                    : smartEraseStage?.phase === 'model' && smartEraseStage.totalBytes
                    ? `下载模型 ${Math.round((smartEraseStage.loadedBytes ?? 0) / 1048576)}/${Math.round(smartEraseStage.totalBytes / 1048576)}MB`
                    : smartEraseStage?.phase === 'session'
                    ? '初始化推理引擎…'
                    : smartEraseStage?.phase === 'inference'
                    ? '正在合成修复…'
                    : '准备中…'}
                </span>
              </>
            ) : (
              <>
                <UiIcon name="sparkles" size={13} />
                <span>{hasEraseAiRegions ? `运行${ERASE_TYPE_LABELS[eraseType]}（虚线区域）` : '请先涂抹或框选水印'}</span>
              </>
            )}
          </button>

          {hasEraseAiRegions && onClearEraseRegions && (
            <button
              type="button"
              disabled={isSmartErasing}
              onClick={onClearEraseRegions}
              className="flex items-center justify-center gap-1.5 w-full py-1 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-[11px] transition-all border border-zinc-700/60 disabled:opacity-50"
            >
              <UiIcon name="trash" size={12} />
              <span>清除全部消除选区</span>
            </button>
          )}

          {smartEraseError && (
            <div className="text-[11px] text-rose-400 bg-rose-950/40 border border-rose-900/60 p-2 rounded-lg font-mono">
              {smartEraseError}
            </div>
          )}
        </div>
      )}

      {/* Tab 3: 测试隐形水印与溯源 */}
      {tab === 'test' && (
        <div className="flex flex-col gap-2 pt-0.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isCheckingProvenance}
              onClick={() => onCheckProvenance('current')}
              className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-xl bg-emerald-500/90 hover:bg-emerald-500 text-zinc-950 font-medium text-[11px] transition-all shadow-md shadow-emerald-500/20 disabled:opacity-50"
            >
              {isCheckingProvenance ? (
                <span className="animate-spin"><UiIcon name="loader" size={12} /></span>
              ) : (
                <UiIcon name="sparkles" size={12} />
              )}
              <span>检测当前编辑图</span>
            </button>
            <button
              type="button"
              disabled={isCheckingProvenance}
              onClick={() => onCheckProvenance('original')}
              className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-[11px] transition-all border border-zinc-700/60 disabled:opacity-50"
            >
              <span>检测原图</span>
            </button>
          </div>

          {provenanceError && (
            <div className="text-[11px] text-rose-400 bg-rose-950/40 border border-rose-900/60 p-2 rounded-lg font-mono">
              {provenanceError}
            </div>
          )}

          {provenanceResult && (
            <div className="flex flex-col gap-1.5 p-2 rounded-xl bg-zinc-800/60 border border-zinc-700/60">
              <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono">
                <span>OPENAI / PROVENANCE</span>
                <span>{new Date(provenanceResult.checkedAt).toLocaleTimeString()}</span>
              </div>
              <div className="flex flex-col gap-1">
                {provenanceResult.evidence.length === 0 ? (
                  <span className="text-[11px] text-zinc-400">未检出可信的 AI 隐形水印或 C2PA 凭据</span>
                ) : (
                  provenanceResult.evidence.map((ev, i) => (
                    <div key={i} className="flex items-center justify-between text-[11px]">
                      <span className="font-mono text-zinc-300">
                        {ev.signal === 'c2pa' ? 'C2PA 凭据' : 'SynthID 隐形水印'}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-medium ${
                          ev.outcome === 'detected'
                            ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40'
                            : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                        }`}
                      >
                        {ev.outcome === 'detected' ? 'DETECTED' : 'NOT DETECTED'}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          <p className="text-[10px] text-zinc-400 leading-tight">
            注：此处检测的是嵌入在像素频域内的隐形水印（SynthID）与 C2PA 数字凭证。清除可见文字水印不会清除底层隐形签名。
          </p>
        </div>
      )}
    </div>
  )
}
