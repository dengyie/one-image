import React, { useEffect, useRef, useState } from 'react'
import { UiIcon } from '../ui/UiIcon'
import {
  fetchImagegenCapabilities,
  generateImage,
  base64ToFile,
  imagegenFailedCount,
  resolveImagegenSelection,
  type ImagegenCapabilities,
  type ImagegenResponse,
} from '../../infrastructure/imagegen-client'
import {
  prepareReferenceImage,
  REFERENCE_MAX_BYTES,
  REFERENCE_MAX_EDGE,
  type ReferenceImage,
  type ReferenceSource,
} from '../../application/imagegen-input'

/** What the App needs to report honestly once a batch comes back. */
export interface ImageGenOutcome {
  model: string
  images: ImagegenResponse['images']
  /** Requested images the upstream did not deliver. */
  failed: number
  /** The `size` that was asked for, when one was. */
  requestedSize?: string
}

interface ImageGenModalProps {
  isOpen: boolean
  onClose: () => void
  /** Called once per generation with every produced image; the App loads them. */
  onGenerated: (files: File[], outcome: ImageGenOutcome) => void
  /** The image open in the editor, used as the reference picker's shortcut. */
  currentImage?: File | null
  /** Renders the current canvas, edits included. Resolves null when nothing is open. */
  getCurrentReference?: () => Promise<ReferenceSource | null>
}

const referenceLimitMb = Math.round(REFERENCE_MAX_BYTES / 1024 / 1024)

export const ImageGenModal: React.FC<ImageGenModalProps> = ({
  isOpen,
  onClose,
  onGenerated,
  currentImage,
  getCurrentReference,
}) => {
  const [caps, setCaps] = useState<ImagegenCapabilities | null>(null)
  const [capsLoaded, setCapsLoaded] = useState(false)
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [size, setSize] = useState('')
  const [count, setCount] = useState(1)
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revised, setRevised] = useState<string | null>(null)
  // null = a plain text-to-image request, which keeps the outgoing body
  // byte-for-byte identical to the pre-i2i shape.
  const [reference, setReference] = useState<ReferenceImage | null>(null)
  const [pickingReference, setPickingReference] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  // Latest selection for the reopen-resolution effect, which intentionally
  // does not list these as dependencies (it runs once per open).
  const selectionRef = useRef({ providerId: '', model: '' })
  selectionRef.current = { providerId, model }

  useEffect(() => {
    if (!isOpen) return
    setError(null)
    setRevised(null)
    let cancelled = false
    void fetchImagegenCapabilities().then((result) => {
      if (cancelled) return
      setCaps(result && result.enabled ? result : null)
      setCapsLoaded(true)
      if (result && result.enabled && result.providers.length > 0) {
        const resolved = resolveImagegenSelection(result.providers, selectionRef.current.providerId, selectionRef.current.model)
        if (resolved) {
          setProviderId(resolved.providerId)
          setModel(resolved.model)
        }
        setSize('')
      }
    })
    return () => {
      cancelled = true
    }
  }, [isOpen])

  // Closing ends the session: abandon an in-flight call and drop the reference
  // so the next open starts clean.
  useEffect(() => {
    if (!isOpen) {
      abortRef.current?.abort()
      abortRef.current = null
      setReference(null)
      setPickingReference(false)
      setLoading(false)
    }
  }, [isOpen])

  if (!isOpen) return null

  const provider = caps?.providers.find((p) => p.id === providerId)
  const supportsEdit = !!provider && provider.editModels.includes(model)

  const switchProvider = (id: string) => {
    const next = caps?.providers.find((p) => p.id === id)
    setProviderId(id)
    if (next) {
      setModel(next.defaultModel)
      setSize('')
      // A reference only exists for models that accept one.
      if (!next.editModels.includes(next.defaultModel)) setReference(null)
    }
  }

  const switchModel = (next: string) => {
    setModel(next)
    if (!provider?.editModels.includes(next)) setReference(null)
  }

  /** Runs a blob through the downscale/re-encode pipeline and shows it. */
  const acceptReference = async (source: ReferenceSource) => {
    setPickingReference(true)
    setError(null)
    try {
      setReference(await prepareReferenceImage(source))
    } catch (err: unknown) {
      setReference(null)
      setError(err instanceof Error ? err.message : '参考图处理失败')
    } finally {
      setPickingReference(false)
    }
  }

  const useCurrentImage = async () => {
    // The canvas (with crops and colour edits) wins over the file on disk.
    const current = await getCurrentReference?.().catch(() => null)
    if (current) {
      await acceptReference(current)
      return
    }
    if (currentImage) {
      await acceptReference({ blob: Promise.resolve(currentImage), mimeType: currentImage.type })
      return
    }
    setError('当前没有可用的图片')
  }

  const useFile = (file: File | null | undefined) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setError('请选择图片文件')
      return
    }
    void acceptReference({ blob: Promise.resolve(file), mimeType: file.type })
  }

  const handleGenerate = async () => {
    if (!provider) return
    const cleanPrompt = prompt.trim()
    if (!cleanPrompt) {
      setError('请先输入提示词')
      return
    }
    setLoading(true)
    setError(null)
    setRevised(null)
    // Abort on close, and give up a little after the server's own upstream
    // budget so its 504 wins the race and the user sees a real reason.
    const controller = new AbortController()
    abortRef.current = controller
    const result = await generateImage(
      {
        provider: provider.id,
        model,
        prompt: cleanPrompt,
        size: size || undefined,
        n: count,
        image: reference ? { mimeType: reference.mimeType, base64: reference.base64 } : undefined,
        timeoutMs: provider.timeoutMs + 5_000,
      },
      { signal: controller.signal },
    )
    abortRef.current = null
    setLoading(false)
    if (!result.ok || !result.data) {
      setError(result.message ?? '生成失败，请稍后重试')
      return
    }
    if (result.data.revisedPrompt) setRevised(result.data.revisedPrompt)
    const files = result.data.images.map((image, index) => base64ToFile(image, index))
    if (files.length === 0) {
      setError('上游没有返回图片')
      return
    }
    // One callback for the whole batch: loading N images is the App's job,
    // and a modal-driven setTimeout chain would race the document switcher.
    onGenerated(files, {
      model: result.data.model,
      images: result.data.images,
      failed: imagegenFailedCount(result.data),
      requestedSize: result.data.requestedSize,
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900/95 shadow-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-zinc-100 font-medium">
            <UiIcon name="sparkles" className="w-4 h-4 text-emerald-400" />
            <span>AI 生图</span>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 transition-colors" aria-label="关闭">
            <UiIcon name="x" className="w-4 h-4" />
          </button>
        </div>

        {capsLoaded && !caps && (
          <div className="text-sm text-zinc-400 bg-zinc-800/60 rounded-xl p-4">
            生图服务尚未配置。站点管理员需要在服务端配置 <code className="text-zinc-300">ONEIMAGE_IMAGE_PROVIDERS_FILE</code> 后才能使用。
          </div>
        )}

        {caps && provider && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1.5">
                <span className="text-xs text-zinc-400">生成服务</span>
                <select
                  value={providerId}
                  onChange={(e) => switchProvider(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/60"
                >
                  {caps.providers.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5">
                <span className="text-xs text-zinc-400">模型</span>
                <select
                  value={model}
                  onChange={(e) => switchModel(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/60"
                >
                  {provider.models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-3 items-start">
              {provider.sizes.length > 0 ? (
                <label className="space-y-1.5">
                  <span className="text-xs text-zinc-400">请求尺寸</span>
                  <select
                    value={size}
                    onChange={(e) => setSize(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/60"
                  >
                    <option value="">模型默认</option>
                    {provider.sizes.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <span className="block text-[11px] text-zinc-500 leading-relaxed">部分模型会按自己的比例出图，实际尺寸以生成为准</span>
                </label>
              ) : provider.fixedSizeNote ? (
                <div className="text-[11px] text-zinc-500 leading-relaxed pt-5">
                  <span className="text-zinc-400">固定比例：</span>{provider.fixedSizeNote}
                  <span className="block mt-0.5">出图后会在提示里报告实际像素</span>
                </div>
              ) : (
                <div className="text-[11px] text-zinc-500 leading-relaxed pt-5">尺寸由模型自行决定，出图后会在提示里报告实际像素</div>
              )}
              <label className="space-y-1.5">
                <span className="text-xs text-zinc-400">张数</span>
                <select
                  value={String(count)}
                  onChange={(e) => setCount(Number(e.target.value))}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/60"
                >
                  {[1, 2, 3, 4].map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
                <span className="block text-[11px] text-zinc-500 leading-relaxed">多张会并行请求</span>
              </label>
            </div>

            {supportsEdit && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-zinc-400">参考图</span>
                  {reference && (
                    <button onClick={() => setReference(null)} className="text-[11px] text-zinc-500 hover:text-zinc-200 transition-colors">
                      移除
                    </button>
                  )}
                </div>
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    useFile(e.dataTransfer.files?.[0])
                  }}
                  className="rounded-xl border border-dashed border-zinc-700 bg-zinc-800/40 p-3 space-y-2"
                >
                  {reference ? (
                    <div className="flex items-center gap-3">
                      <img
                        src={`data:${reference.mimeType};base64,${reference.base64}`}
                        alt="参考图"
                        className="w-16 h-16 rounded-lg object-cover bg-zinc-900"
                      />
                      <div className="text-[11px] text-zinc-400 leading-relaxed">
                        {reference.width}×{reference.height} · {Math.max(1, Math.round(reference.bytes / 1024))} KB
                        <br />
                        上传前已压到 {REFERENCE_MAX_EDGE}px / {referenceLimitMb}MB 以内
                      </div>
                    </div>
                  ) : (
                    <div className="text-[11px] text-zinc-500 leading-relaxed">
                      拖入一张图作为底图，或直接使用当前画布；会在上传前压到 {REFERENCE_MAX_EDGE}px 以内
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => void useCurrentImage()}
                      disabled={pickingReference || loading}
                      className="px-2.5 py-1 rounded-lg bg-zinc-700/70 hover:bg-zinc-700 disabled:opacity-50 text-[11px] text-zinc-100 transition-colors"
                    >
                      使用当前图片
                    </button>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      disabled={pickingReference || loading}
                      className="px-2.5 py-1 rounded-lg bg-zinc-700/70 hover:bg-zinc-700 disabled:opacity-50 text-[11px] text-zinc-100 transition-colors"
                    >
                      选择文件
                    </button>
                    {pickingReference && <span className="text-[11px] text-zinc-500">处理中…</span>}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      useFile(e.target.files?.[0])
                      e.target.value = ''
                    }}
                  />
                </div>
              </div>
            )}

            <label className="block space-y-1.5">
              <span className="text-xs text-zinc-400">提示词</span>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                maxLength={4000}
                placeholder="描述你想要的画面…"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 resize-none focus:outline-none focus:border-emerald-500/60"
              />
            </label>

            {revised && (
              <div className="text-xs text-zinc-400 bg-zinc-800/60 rounded-lg p-2.5">
                模型改写后的提示词：{revised}
              </div>
            )}

            {error && (
              <div className="text-xs text-rose-300 bg-rose-950/60 border border-rose-500/30 rounded-lg p-2.5">{error}</div>
            )}

            <button
              onClick={() => void handleGenerate()}
              disabled={loading || !prompt.trim()}
              className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-xl py-2.5 text-sm font-medium transition-colors"
            >
              {loading ? (
                <>
                  <UiIcon name="loader" className="w-4 h-4 animate-spin" />
                  生成中，多张会并行请求，通常 30-90 秒…
                </>
              ) : (
                <>
                  <UiIcon name="sparkles" className="w-4 h-4" />
                  生成图片
                </>
              )}
            </button>
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              生成直接进入编辑器工作台，可继续裁剪、调色、加水印并同步历史。API 密钥保存在服务端，浏览器不会接触。
            </p>
          </>
        )}
      </div>
    </div>
  )
}
