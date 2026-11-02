import React from 'react'
import { UiIcon, type UiIconName } from '../ui/UiIcon'
import { CropSubToolbar } from './SubToolbars/CropSubToolbar'
import { MarkupSubToolbar, type MarkupMode } from './SubToolbars/MarkupSubToolbar'
import { MosaicSubToolbar, type MosaicType, type MosaicShape } from './SubToolbars/MosaicSubToolbar'
import { TextSubToolbar } from './SubToolbars/TextSubToolbar'
import { AdjustSubToolbar } from './SubToolbars/AdjustSubToolbar'
import { CompressSubToolbar } from './SubToolbars/CompressSubToolbar'
import { WatermarkSubToolbar, type WatermarkLayout, type WatermarkEraseType, type WatermarkTab } from './SubToolbars/WatermarkSubToolbar'
import type { SmartEraseStage } from '../../infrastructure/inpaint/smart-erase'
import type { SmartEraseMode } from '../../infrastructure/inpaint/auto-route'
import type { Adjustments, TextBgStyle } from '../../domain/editor-state'
import type { ProvenanceResult } from '../../infrastructure/openai-provenance-adapter'

export type ActiveTool = 'none' | 'crop' | 'markup' | 'mosaic' | 'text' | 'adjust' | 'watermark' | 'compress'

interface BottomDockProps {
  activeTool: ActiveTool
  onToolSelect: (tool: ActiveTool) => void

  // Crop props
  cropRatio: string
  onRatioSelect: (ratio: string) => void
  onRotate90: () => void
  onFlipH: () => void
  onFlipV: () => void
  onResetCrop: () => void

  // Markup props
  markupMode: MarkupMode
  markupColor: string
  markupWidth: number
  onMarkupModeSelect: (mode: MarkupMode) => void
  onMarkupColorSelect: (color: string) => void
  onMarkupWidthSelect: (width: number) => void

  // Mosaic props
  mosaicType: MosaicType
  mosaicBlockSize: number
  mosaicShape: MosaicShape
  mosaicBrushSize: number
  onMosaicTypeSelect: (type: MosaicType) => void
  onMosaicBlockSizeSelect: (size: number) => void
  onMosaicShapeSelect: (shape: MosaicShape) => void
  onMosaicBrushSizeSelect: (size: number) => void

  // Text props
  textStyle: TextBgStyle
  textColor: string
  textSize: number
  onTextStyleSelect: (style: TextBgStyle) => void
  onTextColorSelect: (color: string) => void
  onTextSizeSelect: (size: number) => void

  // Adjust props
  adjustments: Adjustments
  onAdjustmentsChange: (adjustments: Adjustments) => void
  onAdjustmentsCommit: () => void
  onAdjustmentsReset: () => void

  // Watermark props
  onAddWatermark: (options: { text: string; layout: WatermarkLayout; opacity: number; color: string }) => void
  onAddEraseRegion: () => void
  onCheckProvenanceTarget: (target: 'current' | 'original') => void
  provenanceResultDetail: ProvenanceResult | null
  provenanceError?: string | null
  hasEraseAiRegions?: boolean
  onRunErase?: (eraseType: WatermarkEraseType) => void
  isSmartErasing?: boolean
  smartEraseStage?: SmartEraseStage | null
  smartEraseError?: string | null
  eraseMaskShape: MosaicShape
  eraseBrushSize: number
  eraseMode: SmartEraseMode
  onEraseMaskShapeSelect: (shape: MosaicShape) => void
  onEraseBrushSizeSelect: (size: number) => void
  onEraseModeSelect: (mode: SmartEraseMode) => void
  onClearEraseRegions: () => void
  onWatermarkTabChange?: (tab: WatermarkTab) => void

  // Compress props
  outputMime: string
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

const TOOLS: Array<{ id: ActiveTool; label: string; shortcut: string; icon: UiIconName }> = [
  { id: 'crop', label: '裁剪', shortcut: 'C', icon: 'crop' },
  { id: 'markup', label: '标注', shortcut: 'B', icon: 'brush' },
  { id: 'mosaic', label: '马赛克', shortcut: 'M', icon: 'mosaic' },
  { id: 'text', label: '文字', shortcut: 'T', icon: 'type' },
  { id: 'adjust', label: '滤镜调色', shortcut: 'F', icon: 'sliders' },
  { id: 'watermark', label: '水印', shortcut: 'W', icon: 'shield-check' },
  { id: 'compress', label: '压缩格式', shortcut: 'O', icon: 'sparkles' },
]

export const BottomDock: React.FC<BottomDockProps> = ({
  activeTool,
  onToolSelect,
  cropRatio,
  onRatioSelect,
  onRotate90,
  onFlipH,
  onFlipV,
  onResetCrop,
  markupMode,
  markupColor,
  markupWidth,
  onMarkupModeSelect,
  onMarkupColorSelect,
  onMarkupWidthSelect,
  mosaicType,
  mosaicBlockSize,
  mosaicShape,
  mosaicBrushSize,
  onMosaicTypeSelect,
  onMosaicBlockSizeSelect,
  onMosaicShapeSelect,
  onMosaicBrushSizeSelect,
  textStyle,
  textColor,
  textSize,
  onTextStyleSelect,
  onTextColorSelect,
  onTextSizeSelect,
  adjustments,
  onAdjustmentsChange,
  onAdjustmentsCommit,
  onAdjustmentsReset,
  onAddWatermark,
  onAddEraseRegion,
  onCheckProvenanceTarget,
  provenanceResultDetail,
  provenanceError,
  hasEraseAiRegions,
  onRunErase,
  isSmartErasing,
  smartEraseStage,
  smartEraseError,
  eraseMaskShape,
  eraseBrushSize,
  eraseMode,
  onEraseMaskShapeSelect,
  onEraseBrushSizeSelect,
  onEraseModeSelect,
  onClearEraseRegions,
  onWatermarkTabChange,
  outputMime,
  quality,
  estimatedBytes,
  originalBytes,
  stripMetadata,
  isCheckingProvenance,
  provenanceResult,
  onMimeSelect,
  onQualityChange,
  onToggleStripMetadata,
  onCheckProvenance,
}) => {
  return (
    <div className="fixed inset-x-0 bottom-6 z-40 flex flex-col items-center gap-2 px-2 select-none pointer-events-none">
      {/* Contextual Sub-Toolbar (Floating directly above the dock) */}
      <div className="pointer-events-auto max-w-full transition-all duration-200">
        {activeTool === 'crop' && (
          <CropSubToolbar
            currentRatio={cropRatio}
            onRatioSelect={onRatioSelect}
            onRotate90={onRotate90}
            onFlipH={onFlipH}
            onFlipV={onFlipV}
            onResetCrop={onResetCrop}
          />
        )}
        {activeTool === 'markup' && (
          <MarkupSubToolbar
            currentMode={markupMode}
            currentColor={markupColor}
            currentWidth={markupWidth}
            onModeSelect={onMarkupModeSelect}
            onColorSelect={onMarkupColorSelect}
            onWidthSelect={onMarkupWidthSelect}
          />
        )}
        {activeTool === 'mosaic' && (
          <MosaicSubToolbar
            currentType={mosaicType}
            currentBlockSize={mosaicBlockSize}
            currentShape={mosaicShape}
            currentBrushSize={mosaicBrushSize}
            onTypeSelect={onMosaicTypeSelect}
            onBlockSizeSelect={onMosaicBlockSizeSelect}
            onShapeSelect={onMosaicShapeSelect}
            onBrushSizeSelect={onMosaicBrushSizeSelect}
          />
        )}
        {activeTool === 'text' && (
          <TextSubToolbar
            currentStyle={textStyle}
            currentColor={textColor}
            currentSize={textSize}
            onStyleSelect={onTextStyleSelect}
            onColorSelect={onTextColorSelect}
            onSizeSelect={onTextSizeSelect}
          />
        )}
        {activeTool === 'adjust' && (
          <AdjustSubToolbar
            adjustments={adjustments}
            onChange={onAdjustmentsChange}
            onCommit={onAdjustmentsCommit}
            onReset={onAdjustmentsReset}
          />
        )}
        {activeTool === 'watermark' && (
          <WatermarkSubToolbar
            onAddWatermark={onAddWatermark}
            onAddEraseRegion={onAddEraseRegion}
            onCheckProvenance={onCheckProvenanceTarget}
            isCheckingProvenance={isCheckingProvenance ?? false}
            provenanceResult={provenanceResultDetail}
            provenanceError={provenanceError}
            hasEraseAiRegions={hasEraseAiRegions}
            onRunErase={onRunErase}
            isSmartErasing={isSmartErasing}
            smartEraseStage={smartEraseStage}
            smartEraseError={smartEraseError}
            eraseMaskShape={eraseMaskShape}
            eraseBrushSize={eraseBrushSize}
            eraseMode={eraseMode}
            onEraseMaskShapeSelect={onEraseMaskShapeSelect}
            onEraseBrushSizeSelect={onEraseBrushSizeSelect}
            onEraseModeSelect={onEraseModeSelect}
            onClearEraseRegions={onClearEraseRegions}
            onTabChange={onWatermarkTabChange}
          />
        )}
        {activeTool === 'compress' && (
          <CompressSubToolbar
            currentMime={outputMime}
            quality={quality}
            estimatedBytes={estimatedBytes}
            originalBytes={originalBytes}
            stripMetadata={stripMetadata}
            isCheckingProvenance={isCheckingProvenance}
            provenanceResult={provenanceResult}
            onMimeSelect={onMimeSelect}
            onQualityChange={onQualityChange}
            onToggleStripMetadata={onToggleStripMetadata}
            onCheckProvenance={onCheckProvenance}
          />
        )}
      </div>

      {/* Main WeChat / QQ Style Capsule Dock */}
      <nav className="pointer-events-auto flex max-w-full items-center gap-1 sm:gap-2 px-3 py-2 rounded-full bg-zinc-900/85 backdrop-blur-2xl border border-white/10 shadow-2xl shadow-black/80 text-xs text-zinc-300">
        {TOOLS.map((t) => {
          const isActive = activeTool === t.id
          return (
            <button
              key={t.id}
              onClick={() => onToolSelect(isActive ? 'none' : t.id)}
              title={t.label}
              className={`group relative flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-full transition-all text-xs ${
                isActive
                  ? 'bg-emerald-500 text-zinc-950 font-medium shadow-lg shadow-emerald-500/30 scale-105'
                  : 'hover:bg-zinc-800/80 text-zinc-400 hover:text-zinc-100'
              }`}
            >
              <UiIcon name={t.icon} size={16} strokeWidth={isActive ? 2.2 : 1.8} />
              <span className="hidden whitespace-nowrap font-medium lg:inline">{t.label}</span>
              <kbd
                className={`hidden lg:inline-block text-[10px] font-mono px-1 rounded transition-colors ${
                  isActive ? 'bg-zinc-950/20 text-zinc-950' : 'text-zinc-500 group-hover:text-zinc-400'
                }`}
              >
                {t.shortcut}
              </kbd>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
