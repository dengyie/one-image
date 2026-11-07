import React, { useEffect, useRef, useState } from 'react'
import { UiIcon } from '../ui/UiIcon'
import {
  fetchImagegenCapabilities,
  fetchVideogenQuota,
  generateVideo,
  type VideoResult,
  type VideogenProviderInfo,
} from '../../infrastructure/imagegen-client'

interface VideoGenModalProps {
  isOpen: boolean
  onClose: () => void
}

/**
 * Text-to-video generation. Videos never enter the image workspace (the
 * editor is a bitmap pipeline); the result plays in place with a download
 * button, one clip per request.
 */
export const VideoGenModal: React.FC<VideoGenModalProps> = ({ isOpen, onClose }) => {
  const [providers, setProviders] = useState<VideogenProviderInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<VideoResult | null>(null)
  const [quota, setQuota] = useState<{ used: number; cap: number; remaining: number } | null>(null)
  const resultUrlRef = useRef<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const refreshQuota = () => {
    void fetchVideogenQuota().then((next) => {
      if (next) setQuota(next)
    })
  }

  useEffect(() => {
    if (!isOpen) return
    setError(null)
    let cancelled = false
    void fetchImagegenCapabilities().then((caps) => {
      if (cancelled) return
      const videoProviders = caps?.video?.providers ?? []
      setProviders(videoProviders)
      setLoaded(true)
      if (videoProviders.length > 0) {
        const prevProvider = videoProviders.find((p) => p.id === providerId) ?? videoProviders[0]
        setProviderId(prevProvider.id)
        setModel(prevProvider.models.some((m) => m.id === model) ? model : prevProvider.defaultModel)
      }
    })
    refreshQuota()
    return () => {
      cancelled = true
    }
    // The reopen resolution intentionally reads the last selection once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // Closing ends the session: abandon an in-flight call and release the blob
  // URL so the next open starts clean.
  useEffect(() => {
    if (!isOpen) {
      abortRef.current?.abort()
      abortRef.current = null
      setLoading(false)
      if (resultUrlRef.current) {
        URL.revokeObjectURL(resultUrlRef.current)
        resultUrlRef.current = null
      }
      setResult(null)
    }
  }, [isOpen])

  if (!isOpen) return null

  const provider = providers.find((p) => p.id === providerId)
  const modelInfo = provider?.models.find((m) => m.id === model)

  const handleGenerate = async () => {
    if (!provider) return
    const cleanPrompt = prompt.trim()
    if (!cleanPrompt) {
      setError('请先输入提示词')
      return
    }
    setLoading(true)
    setError(null)
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current)
      resultUrlRef.current = null
    }
    setResult(null)
    const controller = new AbortController()
    abortRef.current = controller
    const res = await generateVideo(
      {
        provider: provider.id,
        model,
        prompt: cleanPrompt,
        timeoutMs: (modelInfo?.timeoutMs ?? provider.models[0]?.timeoutMs ?? 90_000) + 5_000,
      },
      { signal: controller.signal },
    )
    abortRef.current = null
    setLoading(false)
    refreshQuota()
    if (!res.ok || !res.data) {
      setError(res.message ?? '视频生成失败，请稍后重试')
      return
    }
    resultUrlRef.current = URL.createObjectURL(res.data.blob)
    setResult(res.data)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-zinc-800 bg-zinc-900/95 shadow-2xl p-5 space-y-4 max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-zinc-100 font-medium">
            <UiIcon name="film" className="w-4 h-4 text-emerald-400" />
            <span>AI 视频</span>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200 transition-colors" aria-label="关闭">
            <UiIcon name="x" className="w-4 h-4" />
          </button>
        </div>

        {loaded && providers.length === 0 && (
          <div className="text-sm text-zinc-400 bg-zinc-800/60 rounded-xl p-4">
            视频生成服务尚未配置。站点管理员需要在服务端配置视频模型后才能使用。
          </div>
        )}

        {provider && (
          <>
            <div className={providers.length > 1 ? 'grid grid-cols-2 gap-3' : 'space-y-3'}>
              {providers.length > 1 && (
                <label className="space-y-1.5">
                  <span className="text-xs text-zinc-400">生成服务</span>
                  <select
                    value={providerId}
                    onChange={(e) => {
                      const next = providers.find((p) => p.id === e.target.value)
                      setProviderId(e.target.value)
                      if (next) setModel(next.defaultModel)
                    }}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/60"
                  >
                    {providers.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="space-y-1.5">
                <span className="text-xs text-zinc-400">模型</span>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500/60"
                >
                  {provider.models.map((m) => (
                    <option key={m.id} value={m.id}>{m.id}</option>
                  ))}
                </select>
              </label>
            </div>

            {modelInfo?.note && (
              <div className="text-[11px] text-zinc-500">{modelInfo.note}</div>
            )}

            <label className="block space-y-1.5">
              <span className="text-xs text-zinc-400">提示词</span>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                maxLength={4000}
                placeholder="描述你想要的视频画面…"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 resize-none focus:outline-none focus:border-emerald-500/60"
              />
            </label>

            {error && (
              <div className="text-xs text-rose-300 bg-rose-950/60 border border-rose-500/30 rounded-lg p-2.5">{error}</div>
            )}

            {result && resultUrlRef.current && (
              <div className="space-y-2">
                <video
                  src={resultUrlRef.current}
                  controls
                  autoPlay
                  loop
                  className="w-full rounded-xl bg-black"
                />
                <div className="flex items-center justify-between text-[11px] text-zinc-500">
                  <span>{result.model} · {(result.bytes / 1024 / 1024).toFixed(1)} MB · {result.mimeType}</span>
                  <a
                    href={resultUrlRef.current}
                    download={`ai-video-${Date.now()}.${result.mimeType.split('/')[1] ?? 'mp4'}`}
                    className="px-2.5 py-1 rounded-lg bg-zinc-700/70 hover:bg-zinc-700 text-[11px] text-zinc-100 transition-colors"
                  >
                    下载视频
                  </a>
                </div>
              </div>
            )}

            <button
              onClick={() => void handleGenerate()}
              disabled={loading || !prompt.trim()}
              className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-xl py-2.5 text-sm font-medium transition-colors"
            >
              {loading ? (
                <>
                  <UiIcon name="loader" className="w-4 h-4 animate-spin" />
                  视频生成中，通常 {modelInfo?.note ?? '40-90 秒'}…
                </>
              ) : (
                <>
                  <UiIcon name="film" className="w-4 h-4" />
                  生成视频
                </>
              )}
            </button>
            {quota && (
              <p className="text-[11px] text-zinc-500">
                今日剩余 {quota.remaining} / {quota.cap} 段
              </p>
            )}
            <p className="text-[11px] text-zinc-500 leading-relaxed">
              视频不进入图片工作台，可直接播放与下载。API 密钥保存在服务端，浏览器不会接触。
            </p>
          </>
        )}
      </div>
    </div>
  )
}
