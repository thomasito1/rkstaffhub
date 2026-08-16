import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState, useToast } from '@/components/ui'
import { RequirePermission } from '@/components/guards/RouteGuards'
import { useAuth } from '@/lib/auth/AuthProvider'
import { listMyTaskInstances } from '@/lib/db'
import { formatDate, formatTime } from '@/lib/format'
import { checkGeofence, MAX_PLAUSIBLE_ACCURACY_METERS } from '@/lib/geofence'
import { queuePunch } from '@/lib/offlineQueue/punchQueue'
import { clockIn, clockOut } from '@/lib/timeClock/punchActions'
import { mintPunchId, uploadPunchSelfie } from '@/lib/timeClock/selfieUpload'

import { ClockHomeScreen, type GeofenceStatus } from './ClockHomeScreen'
import { GeofenceBlockedScreen } from './GeofenceBlockedScreen'
import { SelfieCaptureScreen } from './SelfieCaptureScreen'
import {
  errorKeyFor,
  formatClock12,
  geoErrorKeyFor,
  getCurrentPosition,
  punchRejectionCode,
  toDateOrNull,
} from './shared'
import { PunchSuccessScreen } from './PunchSuccessScreen'
import { TipsConfirmScreen } from './TipsConfirmScreen'
import { TipsNumpadScreen } from './TipsNumpadScreen'
import { useClockData } from './useClockData'
import { useOfflineQueueSync } from './useOfflineQueueSync'

/**
 * Time clock — spec §8, mockups 19–23. The server-side layer (geofence
 * re-verification, selfie verification, offline queue) is already built
 * (functions/src/punchActions.ts, commit 60823eb); this page is the flow
 * around it. Every step's own screen component is a dumb renderer — all the
 * state lives here.
 */

interface Geo {
  lat: number
  lng: number
  accuracy: number
}

type Step =
  | { kind: 'home' }
  | {
      kind: 'blocked'
      punchType: 'in' | 'out'
      reason: 'outside' | 'imprecise'
      distanceMeters: number | null
    }
  | { kind: 'selfie'; punchType: 'in' | 'out'; punchId: string; geo: Geo }
  | { kind: 'tips-numpad'; punchId: string; geo: Geo; selfieBlob: Blob; initialAmount?: number }
  | { kind: 'tips-confirm'; punchId: string; geo: Geo; selfieBlob: Blob; amount: number }
  | {
      kind: 'success'
      punchType: 'in' | 'out'
      deviceTimestamp: string
      clockInAt: Date | null
      tipsAmount: number | null
      pendingSync: boolean
    }

export function ClockPage(): JSX.Element {
  return (
    <RequirePermission permission="timeclock.punchSelf">
      <ClockGate />
    </RequirePermission>
  )
}

/** Spec §8: no clock UI at all for someone not set up to punch (owners/managers). */
function ClockGate(): JSX.Element {
  const { t } = useTranslation()
  const { employee } = useAuth()

  if (!employee || !employee.clockRequired) {
    return (
      <div className="mx-auto max-w-lg pt-10">
        <EmptyState
          illustration="calendar"
          title={t('clock.notApplicable.title')}
          body={t('clock.notApplicable.body')}
        />
      </div>
    )
  }

  // Keyed by employeeId so switching accounts never carries over stale flow state.
  return <ClockScreen key={employee.id} />
}

function ClockScreen(): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()
  const { employee } = useAuth()
  const data = useClockData(employee)

  const [step, setStep] = useState<Step>({ kind: 'home' })
  const [busy, setBusy] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [geofence, setGeofence] = useState<GeofenceStatus>({ state: 'checking', secondsAgo: 0 })
  // Best-effort "you have N open tasks" banner (spec §10) — surfaced on the
  // clock-out success screen only. `null` until a fresh count resolves; reset
  // at the start of every new punch attempt so a stale count never survives
  // into a different flow.
  const [openTaskCount, setOpenTaskCount] = useState<number | null>(null)

  useOfflineQueueSync(
    useCallback(() => {
      void data.refreshQueuedCount()
      void data.refreshOpenPunch()
    }, [data]),
  )

  // Live "Verified Ns ago" tick for the home chip.
  useEffect(() => {
    const id = window.setInterval(() => {
      setGeofence((g) => (g.state === 'verified' ? { ...g, secondsAgo: g.secondsAgo + 1 } : g))
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  // Best-effort passive check for the home screen's chip — display-only, per
  // src/lib/geofence.ts's own header. The real check happens again, fresh,
  // the moment the employee taps Clock In/Out (handlePrimaryAction).
  useEffect(() => {
    if (!data.settings || step.kind !== 'home') return
    let cancelled = false
    void getCurrentPosition()
      .then((pos) => {
        if (cancelled || !data.settings) return
        const check = checkGeofence(
          { lat: pos.coords.latitude, lng: pos.coords.longitude },
          { lat: data.settings.geofence.lat, lng: data.settings.geofence.lng },
          data.settings.geofence.radiusMeters,
        )
        setGeofence({ state: check.insideFence ? 'verified' : 'outside', secondsAgo: 0 })
      })
      .catch(() => {
        if (!cancelled) setGeofence({ state: 'unavailable', secondsAgo: 0 })
      })
    return () => {
      cancelled = true
    }
    // Re-check once per settings load / return to home, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.settings, step.kind])

  const restaurantName = data.settings?.restaurant.name ?? t('clock.notApplicable.title')
  const role = data.todaysShift ? data.rolesById.get(data.todaysShift.roleId) : undefined
  const roleLabel = data.todaysShift
    ? `${lang.startsWith('es') && role?.nameEs ? role.nameEs : (role?.name ?? data.todaysShift.roleId)} · L${data.todaysShift.requiredSkillLevel}`
    : null

  const goHome = useCallback(() => setStep({ kind: 'home' }), [])

  async function handlePrimaryAction() {
    if (!employee || !data.settings || busy) return
    setBusy(true)
    setOpenTaskCount(null)
    const punchType: 'in' | 'out' = data.openPunch ? 'out' : 'in'
    try {
      const punchId = mintPunchId()
      let position: GeolocationPosition
      try {
        position = await getCurrentPosition()
      } catch (err) {
        toast.show({ tone: 'error', message: t(geoErrorKeyFor(err)) })
        return
      }
      const { latitude: lat, longitude: lng, accuracy } = position.coords
      const geofenceSettings = data.settings.geofence

      if (accuracy > MAX_PLAUSIBLE_ACCURACY_METERS) {
        setStep({ kind: 'blocked', punchType, reason: 'imprecise', distanceMeters: null })
        return
      }

      const check = checkGeofence({ lat, lng }, { lat: geofenceSettings.lat, lng: geofenceSettings.lng }, geofenceSettings.radiusMeters)
      if (!check.insideFence) {
        setGeofence({ state: 'outside', secondsAgo: 0 })
        setStep({ kind: 'blocked', punchType, reason: 'outside', distanceMeters: check.distanceMeters })
        return
      }

      setGeofence({ state: 'verified', secondsAgo: 0 })
      setStep({ kind: 'selfie', punchType, punchId, geo: { lat, lng, accuracy } })
    } finally {
      setBusy(false)
    }
  }

  function handleSelfieCaptured(blob: Blob) {
    if (step.kind !== 'selfie') return
    if (step.punchType === 'out' && employee?.tipsRequired) {
      setStep({ kind: 'tips-numpad', punchId: step.punchId, geo: step.geo, selfieBlob: blob })
    } else {
      void finalizePunch(step.punchType, step.punchId, step.geo, blob, undefined)
    }
  }

  function handleTipsContinue(amount: number) {
    if (step.kind !== 'tips-numpad') return
    setStep({ kind: 'tips-confirm', punchId: step.punchId, geo: step.geo, selfieBlob: step.selfieBlob, amount })
  }

  function handleNoTips() {
    if (step.kind !== 'tips-numpad') return
    setStep({ kind: 'tips-confirm', punchId: step.punchId, geo: step.geo, selfieBlob: step.selfieBlob, amount: 0 })
  }

  function handleEditAmount() {
    if (step.kind !== 'tips-confirm') return
    setStep({
      kind: 'tips-numpad',
      punchId: step.punchId,
      geo: step.geo,
      selfieBlob: step.selfieBlob,
      initialAmount: step.amount,
    })
  }

  async function handleConfirmClockOut() {
    if (step.kind !== 'tips-confirm') return
    await finalizePunch('out', step.punchId, step.geo, step.selfieBlob, step.amount)
  }

  /**
   * The final atomic step (spec §8/§15): gathers the bundle captured earlier
   * (selfie, geo/accuracy from the geofence tap, tip amount from the numpad)
   * plus a device timestamp captured HERE, and either submits it live or
   * queues it — never re-captures anything, never leaves data stale in
   * between.
   */
  async function finalizePunch(
    punchType: 'in' | 'out',
    punchId: string,
    geo: Geo,
    selfieBlob: Blob,
    tipsAmount: number | undefined,
  ) {
    if (!employee) return
    setSubmitting(true)
    const deviceTimestamp = new Date().toISOString()
    const clockInAt = punchType === 'out' ? toDateOrNull(data.openPunch?.timestamp) : null

    try {
      if (!navigator.onLine) throw new Error('offline')

      await uploadPunchSelfie(employee.id, punchId, selfieBlob)
      if (punchType === 'in') {
        await clockIn({ punchId, lat: geo.lat, lng: geo.lng, accuracy: geo.accuracy, deviceTimestamp })
      } else {
        await clockOut({
          punchId,
          lat: geo.lat,
          lng: geo.lng,
          accuracy: geo.accuracy,
          deviceTimestamp,
          tipsAmount,
        })
      }

      setStep({
        kind: 'success',
        punchType,
        deviceTimestamp,
        clockInAt,
        tipsAmount: tipsAmount ?? null,
        pendingSync: false,
      })
      void data.refreshOpenPunch()
      void data.refreshQueuedCount()

      // Spec §10: "You have N open tasks" on the clock-out success screen —
      // informational only, never blocks or delays the success screen above.
      // Best-effort: a failed fetch just means no banner, never an error.
      if (punchType === 'out') {
        void listMyTaskInstances(employee.id, employee.department)
          .then((instances) => setOpenTaskCount(instances.filter((i) => i.status === 'open').length))
          .catch(() => {})
      }
    } catch (err) {
      const code = punchRejectionCode(err)
      if (code) {
        // A definitive business rejection — the server said no for a real
        // reason (already open, stale selfie, etc). Never queue this; tell
        // the employee and send them back to Home.
        toast.show({ tone: 'error', message: t(`clock.errors.${errorKeyFor(code)}`) })
        goHome()
        void data.refreshOpenPunch()
      } else {
        // Offline, or a genuine connectivity/infra failure — queue exactly
        // what was captured and let the offline-sync listener replay it.
        await queuePunch({
          punchId,
          kind: punchType,
          employeeId: employee.id,
          selfieBlob,
          lat: geo.lat,
          lng: geo.lng,
          accuracy: geo.accuracy,
          deviceTimestamp,
          tipsAmount,
          queuedAt: new Date().toISOString(),
        })
        void data.refreshQueuedCount()
        setStep({
          kind: 'success',
          punchType,
          deviceTimestamp,
          clockInAt,
          tipsAmount: tipsAmount ?? null,
          pendingSync: true,
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (data.loading || !employee) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4 pb-4">
        <div className="h-24 animate-skeleton rounded-card-lg bg-app" />
        <div className="h-32 animate-skeleton rounded-card-lg bg-app" />
        <div className="h-24 animate-skeleton rounded-card-lg bg-app" />
      </div>
    )
  }

  if (step.kind === 'blocked') {
    return (
      <div className="mx-auto max-w-2xl pb-4">
        <header className="pb-2 pt-2">
          <h1 className="text-title font-semibold leading-tight text-ink">{t('clock.home.title')}</h1>
          <p className="tabular mt-0.5 text-meta text-ink-muted">
            {t('clock.home.dateTime', {
              date: formatDate(new Date(), { weekday: 'long', month: 'short', day: 'numeric' }, lang),
              time: formatTime(new Date(), lang),
            })}
          </p>
        </header>
        <GeofenceBlockedScreen
          punchType={step.punchType}
          reason={step.reason}
          distanceMeters={step.distanceMeters}
          radiusMeters={data.settings?.geofence.radiusMeters ?? 0}
          restaurantName={restaurantName}
          secondsAgo={0}
          retrying={busy}
          onTryAgain={() => void handlePrimaryAction()}
        />
      </div>
    )
  }

  if (step.kind === 'selfie') {
    // JUDGMENT CALL on step numbering: mockup 20 (selfie, shared by both
    // flows) hardcodes "Step 2 of 2" — read literally that only fits
    // clock-in/non-tipped clock-out, where the Home tap counts as the
    // implicit step 1. Mockup 22a (numpad) is unambiguous at "Step 2 of 3"
    // and 22b/22d at "Step 3 of 3" for the tipped clock-out flow, which only
    // leaves room for selfie at "Step 1 of 3" there — otherwise two
    // different screens would both read "Step 2 of 3".
    const tippedOut = step.punchType === 'out' && employee.tipsRequired
    return (
      <SelfieCaptureScreen
        punchType={step.punchType}
        stepOf={tippedOut ? { step: 1, total: 3 } : { step: 2, total: 2 }}
        onCancel={goHome}
        onCaptured={handleSelfieCaptured}
      />
    )
  }

  if (step.kind === 'tips-numpad') {
    const hours = data.openPunch
      ? (Date.now() - (toDateOrNull(data.openPunch.timestamp)?.getTime() ?? Date.now())) / 3_600_000
      : 0
    return (
      <TipsNumpadScreen
        shiftHours={hours}
        initialAmount={step.initialAmount}
        onBack={goHome}
        onContinue={handleTipsContinue}
        onNoTips={handleNoTips}
      />
    )
  }

  if (step.kind === 'tips-confirm') {
    const inAt = toDateOrNull(data.openPunch?.timestamp)
    const hours = inAt ? (Date.now() - inAt.getTime()) / 3_600_000 : 0
    return (
      <TipsConfirmScreen
        amount={step.amount}
        clockInTime={inAt ? formatTime(inAt, lang) : '—'}
        clockOutTime={formatTime(new Date(), lang)}
        hours={hours}
        roleLabel={roleLabel}
        onEdit={handleEditAmount}
        onGoBack={handleEditAmount}
        onConfirm={() => void handleConfirmClockOut()}
        submitting={submitting}
      />
    )
  }

  if (step.kind === 'success') {
    const punchMoment = new Date(step.deviceTimestamp)
    const hoursWorked = step.clockInAt ? (punchMoment.getTime() - step.clockInAt.getTime()) / 3_600_000 : null
    return (
      <div className="mx-auto flex max-w-2xl flex-col px-2 pb-4 pt-8">
        <PunchSuccessScreen
          punchType={step.punchType}
          employeeFirstName={employee.preferredName?.trim() ? employee.preferredName : employee.firstName}
          employeeLastName={employee.lastName}
          heroTime={formatTime(punchMoment, lang)}
          clockInTime={step.clockInAt ? formatTime(step.clockInAt, lang) : null}
          clockOutTime={step.punchType === 'out' ? formatTime(punchMoment, lang) : null}
          dateLabel={formatDate(punchMoment, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }, lang)}
          shiftLabel={
            data.todaysShift ? `${formatClock12(data.todaysShift.startTime)} – ${formatClock12(data.todaysShift.endTime)}` : null
          }
          roleLabel={roleLabel}
          station={data.todaysShift?.station ?? null}
          restaurantName={restaurantName}
          clockOutReminder={data.todaysShift ? formatClock12(data.todaysShift.endTime) : null}
          hoursWorked={hoursWorked}
          tipsAmount={step.tipsAmount}
          pendingSync={step.pendingSync}
          openTaskCount={step.punchType === 'out' ? openTaskCount : null}
          onDone={goHome}
        />
      </div>
    )
  }

  return (
    <ClockHomeScreen
      hasOpenPunch={data.openPunch !== null}
      todaysShift={data.todaysShift}
      coworkers={data.coworkers}
      role={role}
      geofence={geofence}
      restaurantName={restaurantName}
      recentPunches={data.recentPunches}
      pendingSyncCount={data.queuedCount}
      busy={busy}
      onPrimaryAction={() => void handlePrimaryAction()}
    />
  )
}

export default ClockPage
