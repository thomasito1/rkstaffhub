import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AlertCircleIcon, ChevronLeftIcon, RefreshCwIcon } from './icons'

/**
 * Selfie capture — mockup 20. Camera only, no gallery/file-picker fallback
 * (spec §8). Captures a single frame to canvas and compresses it via
 * `canvas.toBlob(..., 'image/jpeg', quality)` — no extra dependency needed
 * for the compression the spec asks for.
 *
 * Rendered as a fixed full-viewport overlay so it visually replaces the
 * bottom tab bar the mockup hides, without touching AppShell/MobileShell
 * (out of scope for this task — see CLAUDE.md's file-ownership list).
 */
const JPEG_QUALITY = 0.8

export function SelfieCaptureScreen({
  punchType,
  stepOf,
  onCancel,
  onCaptured,
}: {
  punchType: 'in' | 'out'
  /** e.g. "2 of 2" for clock-in, "2 of 3" for clock-out. */
  stepOf: { step: number; total: number }
  onCancel: () => void
  onCaptured: (blob: Blob) => void
}): JSX.Element {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user' },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          await videoRef.current.play()
        }
        setReady(true)
      } catch {
        if (!cancelled) setError(true)
      }
    })()

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((tr) => tr.stop())
      streamRef.current = null
    }
  }, [])

  function handleCapture() {
    const video = videoRef.current
    if (!video || !ready || capturing) return
    setCapturing(true)

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 720
    canvas.height = video.videoHeight || 960
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      setCapturing(false)
      return
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob(
      (blob) => {
        setCapturing(false)
        if (blob) onCaptured(blob)
      },
      'image/jpeg',
      JPEG_QUALITY,
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-page pl-safe pr-safe">
      <div aria-hidden="true" className="h-safe-top w-full shrink-0 bg-page" />

      <header className="relative flex h-[52px] shrink-0 items-center border-b border-line px-4">
        <button
          type="button"
          onClick={onCancel}
          aria-label={t('clock.selfie.cancel')}
          className="absolute left-4 -ml-2 p-2 text-ink-muted"
        >
          <ChevronLeftIcon className="h-6 w-6" />
        </button>
        <h1 className="flex-1 text-center text-section font-semibold text-ink">
          {punchType === 'in' ? t('clock.selfie.titleIn') : t('clock.selfie.titleOut')}
        </h1>
        <span className="absolute right-4 text-chip font-medium text-ink-muted">
          {t('clock.selfie.stepOf', { step: stepOf.step, total: stepOf.total })}
        </span>
      </header>

      <div className="flex h-[3px] w-full shrink-0 bg-line">
        {Array.from({ length: stepOf.total }, (_, i) => (
          <div
            key={i}
            className={`flex-1 ${i < stepOf.step ? 'bg-primary' : 'bg-line'}`}
          />
        ))}
      </div>

      <main className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col p-4">
          <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden rounded-card-lg bg-ink shadow-inner">
            <video
              ref={videoRef}
              muted
              playsInline
              autoPlay
              className="absolute inset-0 h-full w-full object-cover"
            />
            {error ? (
              <p className="z-10 max-w-[80%] text-center text-meta text-white">
                {t('clock.selfie.cameraError')}
              </p>
            ) : (
              <>
                <p className="absolute top-12 z-10 text-body font-semibold text-white">
                  {t('clock.selfie.guide')}
                </p>
                {/* Front camera only per spec §8 — this pill is decorative,
                    matching mockup 20's visual, not a functional flip control. */}
                <span className="absolute right-4 top-4 z-10 flex items-center gap-1.5 rounded-full bg-black/30 px-3 py-1.5 text-chip font-medium text-white backdrop-blur-md">
                  <RefreshCwIcon className="h-3.5 w-3.5" />
                  {t('clock.selfie.front')}
                </span>
                <div className="relative z-10 flex h-[290px] w-[220px] items-center justify-center rounded-[100px] border-[3px] border-dashed border-white/80" />
              </>
            )}
          </div>

          <div className="mt-4 flex items-start gap-3 px-1">
            <AlertCircleIcon className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <div>
              <p className="text-meta font-semibold leading-tight text-ink">{t('clock.selfie.notice')}</p>
              <p className="mt-0.5 text-chip leading-normal text-ink-muted">{t('clock.selfie.noticeBody')}</p>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between px-6 pb-2 pt-4">
          <button type="button" onClick={onCancel} className="w-20 text-left text-meta font-medium text-ink-muted">
            {t('clock.selfie.cancel')}
          </button>

          <button
            type="button"
            onClick={handleCapture}
            disabled={!ready || capturing}
            aria-label={t('clock.selfie.capture')}
            className="flex h-[76px] w-[76px] items-center justify-center rounded-full border-4 border-primary bg-page transition-transform active:scale-95 disabled:opacity-50"
          >
            <span className="h-14 w-14 rounded-full bg-primary" />
          </button>

          <div className="flex w-20 items-center justify-end gap-1 text-meta font-medium text-primary opacity-40">
            <RefreshCwIcon className="h-4 w-4" />
            <span>{t('clock.selfie.retake')}</span>
          </div>
        </div>
      </main>

      <div aria-hidden="true" className="h-safe-bottom w-full shrink-0 bg-page" />
    </div>
  )
}
