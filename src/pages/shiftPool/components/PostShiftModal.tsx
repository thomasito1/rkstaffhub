import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Avatar, Button, Modal, useToast } from '@/components/ui'
import { createTrade, listPublishedShiftsForDepartment, listShifts } from '@/lib/db'
import { formatDate } from '@/lib/format'
import { effectiveSkillFor } from '@/lib/scheduling/tradeEligibility'
import type { Department, Employee, Shift, ShiftRole } from '@/types/models'

import { dateFromIso, employeeName, roleDisplayName, timeLabel } from '../shared'

/**
 * One modal, two entry points off mockup 16's "Post open shift" button plus
 * spec §7's self-service half of the same flow ("A drops shift" / a direct
 * offer) that the mockup doesn't separately draw:
 *
 *  - mode="manager": pick one of the week's already-OPEN (unassigned) shifts
 *    and drop it straight to the pool (`fromEmployeeId: null`). Gated to
 *    `trades.manualAssign` — firestore.rules' `managerPost()` requires that
 *    permission, not `trades.approve`, for a manager-posted pool drop.
 *  - mode="staff": pick one of the viewer's OWN shifts this week, then choose
 *    to drop it to the pool or offer it directly to an eligible coworker.
 *    Gated to `trades.request` (everyone).
 */
export function PostShiftModal({
  open,
  mode,
  onClose,
  weekId,
  currentEmployeeId,
  currentEmployeeDepartment,
  employees,
  rolesById,
  canCoverRoleIds,
  onPosted,
}: {
  open: boolean
  mode: 'manager' | 'staff'
  onClose: () => void
  weekId: string
  currentEmployeeId: string
  /** Staff mode only — see the load effect's comment on why this can't be a bare `listShifts({employeeId})`. */
  currentEmployeeDepartment: Department
  employees: Employee[]
  rolesById: Map<string, ShiftRole>
  canCoverRoleIds: Record<string, string[]>
  onPosted: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()

  const [loadingShifts, setLoadingShifts] = useState(true)
  const [shifts, setShifts] = useState<Shift[]>([])
  const [selectedShiftId, setSelectedShiftId] = useState<string | null>(null)
  const [action, setAction] = useState<'pool' | 'direct'>('pool')
  const [coworkerId, setCoworkerId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSelectedShiftId(null)
    setAction('pool')
    setCoworkerId(null)
    setError(null)
    setLoadingShifts(true)
    void (async () => {
      try {
        // Staff mode deliberately does NOT call `listShifts(weekId, { employeeId })`
        // on its own — firestore.rules' shift-read rule calls a cross-document
        // `myDepartment()` lookup per matched doc for anyone who isn't a
        // schedule editor, and an employeeId-only query (no department/status
        // pushed into the query itself) reliably throws an evaluation error
        // there rather than a clean deny (PROGRESS.md's documented rules-eval
        // issue). `listPublishedShiftsForDepartment()` is the one query shape
        // confirmed clean for a staff caller; narrowing to "my own shifts" is
        // then a client-side filter, same as `schedules.ts`'s own guidance.
        const found =
          mode === 'manager'
            ? await listShifts(weekId, { openOnly: true })
            : (await listPublishedShiftsForDepartment(weekId, currentEmployeeDepartment)).filter(
                (s) => s.employeeId === currentEmployeeId,
              )
        setShifts(found)
      } finally {
        setLoadingShifts(false)
      }
    })()
  }, [open, mode, weekId, currentEmployeeId, currentEmployeeDepartment])

  const selectedShift = shifts.find((s) => s.id === selectedShiftId) ?? null

  const coworkers = useMemo(() => {
    if (!selectedShift) return []
    return employees
      .filter((e) => e.id !== currentEmployeeId && e.status === 'active' && e.department === selectedShift.department)
      .filter(
        (e) =>
          effectiveSkillFor(
            { id: e.id, status: e.status, shiftRoles: e.shiftRoles },
            selectedShift.roleId,
            canCoverRoleIds,
          ) >= selectedShift.requiredSkillLevel,
      )
      .sort((a, b) => a.lastName.localeCompare(b.lastName))
  }, [employees, selectedShift, currentEmployeeId, canCoverRoleIds])

  async function handleSubmit() {
    if (!selectedShiftId) return
    if (mode === 'staff' && action === 'direct' && !coworkerId) return

    setSubmitting(true)
    setError(null)
    try {
      if (mode === 'manager') {
        await createTrade({
          type: 'pool',
          shiftId: selectedShiftId,
          weekId,
          fromEmployeeId: null,
          postedBy: currentEmployeeId,
        })
      } else if (action === 'pool') {
        await createTrade({
          type: 'pool',
          shiftId: selectedShiftId,
          weekId,
          fromEmployeeId: currentEmployeeId,
          postedBy: currentEmployeeId,
        })
      } else {
        await createTrade({
          type: 'direct',
          shiftId: selectedShiftId,
          weekId,
          fromEmployeeId: currentEmployeeId,
          postedBy: currentEmployeeId,
          toEmployeeId: coworkerId,
        })
      }
      toast.show({ tone: 'success', message: t('shiftPool.toast.posted') })
      onPosted()
      onClose()
    } catch {
      setError(t('shiftPool.errors.generic'))
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = Boolean(selectedShiftId) && (mode === 'manager' || action === 'pool' || Boolean(coworkerId))

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'manager' ? t('shiftPool.postShift.managerTitle') : t('shiftPool.postShift.staffTitle')}
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={!canSubmit || submitting} onClick={() => void handleSubmit()}>
            {mode === 'manager' ? t('shiftPool.postShift.post') : t('shiftPool.postShift.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <label className="text-meta font-medium text-ink-muted">{t('shiftPool.postShift.pickShift')}</label>
          {loadingShifts ? (
            <div className="h-10 animate-skeleton rounded-control bg-app" />
          ) : shifts.length === 0 ? (
            <p className="text-chip text-ink-muted">
              {mode === 'manager' ? t('shiftPool.postShift.noOpenShifts') : t('shiftPool.postShift.noOwnShifts')}
            </p>
          ) : (
            <select
              value={selectedShiftId ?? ''}
              onChange={(e) => setSelectedShiftId(e.target.value || null)}
              className="h-10 w-full rounded-control border border-line bg-page px-3 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            >
              <option value="">{t('shiftPool.postShift.selectPlaceholder')}</option>
              {shifts.map((s) => {
                const role = rolesById.get(s.roleId)
                return (
                  <option key={s.id} value={s.id}>
                    {formatDate(dateFromIso(s.date), { weekday: 'short', month: 'short', day: 'numeric' }, lang)} ·{' '}
                    {timeLabel(s.startTime, lang)}–{timeLabel(s.endTime, lang)} · {roleDisplayName(role, lang)}
                  </option>
                )
              })}
            </select>
          )}
        </div>

        {mode === 'staff' && selectedShift ? (
          <div className="space-y-2">
            <label className="text-meta font-medium text-ink-muted">{t('shiftPool.postShift.howToOffer')}</label>
            <div className="flex rounded-control border border-line bg-app p-1">
              <button
                type="button"
                onClick={() => setAction('pool')}
                className={[
                  'flex-1 rounded py-1.5 text-meta font-semibold transition-colors duration-hover',
                  action === 'pool' ? 'bg-page text-primary shadow-sm ring-1 ring-line' : 'text-ink-muted',
                ].join(' ')}
              >
                {t('shiftPool.postShift.dropToPool')}
              </button>
              <button
                type="button"
                onClick={() => setAction('direct')}
                className={[
                  'flex-1 rounded py-1.5 text-meta font-semibold transition-colors duration-hover',
                  action === 'direct' ? 'bg-page text-primary shadow-sm ring-1 ring-line' : 'text-ink-muted',
                ].join(' ')}
              >
                {t('shiftPool.postShift.offerDirect')}
              </button>
            </div>
            <p className="text-chip text-ink-muted">
              {action === 'pool' ? t('shiftPool.postShift.dropToPoolHelp') : t('shiftPool.postShift.offerDirectHelp')}
            </p>
          </div>
        ) : null}

        {mode === 'staff' && selectedShift && action === 'direct' ? (
          <div className="space-y-2">
            <label className="text-meta font-medium text-ink-muted">{t('shiftPool.postShift.pickCoworker')}</label>
            {coworkers.length === 0 ? (
              <p className="text-chip text-ink-muted">{t('shiftPool.postShift.noEligibleCoworkers')}</p>
            ) : (
              <div className="max-h-56 divide-y divide-line overflow-y-auto rounded-card border border-line">
                {coworkers.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setCoworkerId(c.id)}
                    className={[
                      'flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-hover hover:bg-app',
                      coworkerId === c.id ? 'bg-primary-tint' : '',
                    ].join(' ')}
                  >
                    <Avatar firstName={c.firstName} lastName={c.lastName} photoUrl={c.photoUrl} size={28} />
                    <span className="text-meta font-medium text-ink">{employeeName(c)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {error ? <div className="rounded-card border border-danger bg-danger-tint p-3 text-chip text-danger">{error}</div> : null}
      </div>
    </Modal>
  )
}
