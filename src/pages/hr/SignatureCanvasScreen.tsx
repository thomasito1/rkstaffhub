import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Avatar } from '@/components/ui'
import { submitSignature } from '@/lib/hr/hrActions'
import { formatDate, formatTime } from '@/lib/format'
import type { Employee, Policy } from '@/types/models'

import { signatureErrorMessage } from './hrErrors'
import { CheckIcon, ChevronLeftIcon, ClockIcon, UndoIcon, XIcon } from './icons'

/**
 * Signature capture — mockup 30b. A single HTML5 `<canvas>` with pointer
 * event handling (works for mouse, touch and pen alike — no separate touch
 * handlers needed). Strokes are kept in a ref (not React state — a canvas
 * redraw on every point would be needless render churn) so Undo can pop the
 * last stroke and replay the rest; `hasDrawn` is the one piece of drawing
 * state that DOES need to be React state, since it gates the submit button.
 *
 * `canvas.toDataURL('image/png')` is sent straight to `submitSignature`
 * (src/lib/hr/hrActions.ts) — a Cloud Function call, since firestore.rules
 * denies all client writes to `signatures` outright.
 */

interface Point {
  x: number
  y: number
}

export function SignatureCanvasScreen({
  policy,
  employee,
  onBack,
  onCancel,
  onSigned,
}: {
  policy: Policy
  employee: Employee
  onBack: () => void
  onCancel: () => void
  onSigned: (signatureId: string) => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const strokesRef = useRef<Point[][]>([])
  const drawingRef = useRef(false)

  const [hasDrawn, setHasDrawn] = useState(false)
  const [consent, setConsent] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [signedAtPreview] = useState(() => new Date())

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(rect.width * dpr))
    canvas.height = Math.max(1, Math.round(rect.height * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 2.5
    ctx.strokeStyle = '#1F2937'
  }, [])

  function pointFromEvent(e: ReactPointerEvent<HTMLCanvasElement>): Point {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    canvas.setPointerCapture(e.pointerId)
    drawingRef.current = true
    const p = pointFromEvent(e)
    strokesRef.current.push([p])
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const p = pointFromEvent(e)
    const stroke = strokesRef.current[strokesRef.current.length - 1]
    stroke?.push(p)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
  }

  function endStroke() {
    if (!drawingRef.current) return
    drawingRef.current = false
    setHasDrawn(strokesRef.current.some((s) => s.length > 1))
  }

  function redrawAll() {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr)
    for (const stroke of strokesRef.current) {
      if (stroke.length < 2) continue
      ctx.beginPath()
      ctx.moveTo(stroke[0]!.x, stroke[0]!.y)
      for (let i = 1; i < stroke.length; i += 1) ctx.lineTo(stroke[i]!.x, stroke[i]!.y)
      ctx.stroke()
    }
  }

  function handleClear() {
    strokesRef.current = []
    redrawAll()
    setHasDrawn(false)
  }

  function handleUndo() {
    strokesRef.current.pop()
    redrawAll()
    setHasDrawn(strokesRef.current.some((s) => s.length > 1))
  }

  async function handleSubmit() {
    const canvas = canvasRef.current
    if (!canvas || !hasDrawn || !consent || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const dataUrl = canvas.toDataURL('image/png')
      const { signatureId } = await submitSignature('policy', policy.id, dataUrl)
      onSigned(signatureId)
    } catch (err) {
      setError(signatureErrorMessage(t, err))
    } finally {
      setSubmitting(false)
    }
  }

  const employeeMeta = t('hr.sign.employeeMeta', { number: employee.employeeNumber })

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-page pl-safe pr-safe">
      <div aria-hidden="true" className="h-safe-top w-full shrink-0 bg-page" />

      <header className="shrink-0 border-b border-line bg-page">
        <div className="flex h-[56px] items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <button type="button" onClick={onBack} aria-label={t('hr.sign.back')} className="-ml-1 p-1">
              <ChevronLeftIcon className="h-6 w-6 text-ink" />
            </button>
            <h1 className="text-section font-semibold text-ink">{t('hr.sign.title')}</h1>
          </div>
          <span className="text-meta text-ink-muted">{t('hr.stepIndicator', { step: 2, total: 3 })}</span>
        </div>
        <div className="mb-2 flex h-1 w-full gap-1 px-4">
          <div className="flex-1 rounded-full bg-primary" />
          <div className="flex-1 rounded-full bg-primary" />
          <div className="flex-1 rounded-full bg-line" />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
        <div className="mb-6">
          <h2 className="mb-2 text-title font-semibold text-ink">{t('hr.sign.heading')}</h2>
          <p className="text-meta leading-relaxed text-ink-muted">
            {t('hr.sign.acknowledgement', {
              title: policy.title,
              version: policy.version,
              date: policy.activeFrom
                ? formatDate(new Date(`${policy.activeFrom}T00:00:00`), { dateStyle: 'medium' }, i18n.language)
                : policy.activeFrom,
            })}
          </p>
        </div>

        <div className="mb-8 flex items-center gap-3 rounded-card-lg border border-line p-3">
          <Avatar firstName={employee.firstName} lastName={employee.lastName} photoUrl={employee.photoUrl} size={40} />
          <div>
            <p className="text-meta font-semibold text-ink">
              {employee.preferredName || employee.firstName} {employee.lastName}
            </p>
            <p className="text-chip text-ink-muted">{employeeMeta}</p>
          </div>
        </div>

        <div className="relative mb-3">
          <div className="relative h-[200px] w-full overflow-hidden rounded-card-lg border border-line bg-app">
            <span className="absolute right-3 top-3 text-chip font-medium uppercase tracking-wider text-ink-muted">
              {t('hr.sign.canvasLabel')}
            </span>
            <div className="pointer-events-none absolute inset-x-8 bottom-[66px] h-px bg-line" />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 h-full w-full"
              style={{ touchAction: 'none' }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={endStroke}
              onPointerLeave={endStroke}
              onPointerCancel={endStroke}
              role="img"
              aria-label={t('hr.sign.canvasLabel')}
            />
          </div>
        </div>

        <div className="mb-8 flex items-center justify-between px-1">
          <div className="flex gap-6">
            <button type="button" onClick={handleClear} className="flex items-center gap-1.5 text-meta font-semibold text-primary">
              <XIcon className="h-4 w-4" />
              {t('hr.sign.clear')}
            </button>
            <button type="button" onClick={handleUndo} className="flex items-center gap-1.5 text-meta font-semibold text-primary">
              <UndoIcon className="h-4 w-4" />
              {t('hr.sign.undo')}
            </button>
          </div>
          <span className="text-chip text-ink-muted">{t('hr.sign.useYourFinger')}</span>
        </div>

        <label className="mb-6 flex cursor-pointer gap-3 px-1">
          <span
            className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md border ${
              consent ? 'border-primary bg-primary' : 'border-line bg-page'
            }`}
          >
            {consent ? <CheckIcon className="h-3.5 w-3.5 text-white" /> : null}
          </span>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="sr-only" />
          <span className="text-meta leading-tight text-ink">{t('hr.sign.consent')}</span>
        </label>

        <div className="flex items-start gap-2.5 rounded-card-lg border border-line p-3">
          <ClockIcon className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
          <p className="tabular text-chip leading-snug text-ink-muted">
            {t('hr.sign.timestampNotice', {
              date: formatDate(signedAtPreview, { dateStyle: 'medium' }, i18n.language),
              time: formatTime(signedAtPreview, i18n.language),
            })}
          </p>
        </div>

        {error ? <p className="mt-4 text-meta font-medium text-danger">{error}</p> : null}
      </main>

      <footer className="shrink-0 bg-page px-4 pb-2">
        <div className="flex flex-col gap-2 py-2">
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!hasDrawn || !consent || submitting}
            className="flex h-14 w-full items-center justify-center rounded-control bg-primary font-semibold text-white transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? t('hr.sign.submitting') : t('hr.sign.submit')}
          </button>
          <button type="button" onClick={onCancel} className="flex h-12 w-full items-center justify-center text-meta font-medium text-ink-muted">
            {t('hr.sign.cancel')}
          </button>
        </div>
        <div aria-hidden="true" className="h-safe-bottom w-full" />
      </footer>
    </div>
  )
}

export default SignatureCanvasScreen
