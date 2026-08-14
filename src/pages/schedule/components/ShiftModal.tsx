import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Avatar, Button, Modal, useToast } from '@/components/ui'
import { formatDate } from '@/lib/format'
import { isFirebaseError } from '@/lib/firebaseError'
import {
  effectiveSkillFor,
  type Conflict,
  type ShiftLike,
} from '@/lib/scheduling/conflicts'
import {
  recordScheduleOverride,
  ScheduleOverrideRejected,
} from '@/lib/scheduling/override'
import type { Employee, Shift, SkillLevel } from '@/types/models'
import type { ScheduleData } from '../useScheduleData'

/**
 * Add/edit shift modal — mockup 12's layout, including the eligible-employees
 * preview list and the skill-floor override flow (spec §6).
 *
 * The date a shift falls on is fixed by which grid cell was clicked (or, when
 * creating from a role band's "Add employee" affordance, chosen from the
 * week's seven dates) — it is never itself editable here, matching the
 * mockup's read-only date subtitle.
 */

const SKILL_LEVELS: SkillLevel[] = [1, 2, 3]

const FIELD_CLASS =
  'h-10 w-full rounded-control border border-line bg-page px-3 text-meta text-ink ' +
  'focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:bg-app disabled:text-ink-muted'

function dateFromIso(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`)
}

function employeeName(e: Employee): string {
  const first = e.preferredName?.trim() ? e.preferredName : e.firstName
  return `${first} ${e.lastName}`.trim()
}

interface Candidate {
  employee: Employee
  skill: number
  direct: boolean
  conflicts: Conflict[]
}

export function ShiftModal({
  open,
  onClose,
  data,
  shift,
  defaultDate,
  defaultRoleId,
  defaultEmployeeId,
  canEdit,
}: {
  open: boolean
  onClose: () => void
  data: ScheduleData
  /** Editing this shift, or `null` when creating a new one. */
  shift: Shift | null
  /** Preset date for a new shift (the cell that was clicked). */
  defaultDate?: string
  /** Preset role for a new shift (the band that was clicked). */
  defaultRoleId?: string
  /** Preset candidate for a new shift (the employee row that was clicked). */
  defaultEmployeeId?: string | null
  canEdit: boolean
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()

  const firstActiveRoleId = data.roles.find((r) => r.active)?.id ?? data.roles[0]?.id ?? ''

  const [date] = useState(() => shift?.date ?? defaultDate ?? data.weekDates[0] ?? '')
  const [roleId, setRoleId] = useState(() => shift?.roleId ?? defaultRoleId ?? firstActiveRoleId)
  const [station, setStation] = useState(() => shift?.station ?? '')
  const [startTime, setStartTime] = useState(() => shift?.startTime ?? '17:00')
  const [endTime, setEndTime] = useState(() => shift?.endTime ?? '21:00')
  const [requiredSkillLevel, setRequiredSkillLevel] = useState<SkillLevel>(
    () => shift?.requiredSkillLevel ?? 1,
  )
  const [isOnCall, setIsOnCall] = useState(() => shift?.isOnCall ?? false)
  const [notes, setNotes] = useState(() => shift?.notes ?? '')
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(
    () => shift?.employeeId ?? defaultEmployeeId ?? null,
  )
  const [overrideReason, setOverrideReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  // Reset local state every time the modal is opened for a (possibly
  // different) shift — Modal stays mounted, so props alone won't do it.
  useEffect(() => {
    if (!open) return
    setRoleId(shift?.roleId ?? defaultRoleId ?? firstActiveRoleId)
    setStation(shift?.station ?? '')
    setStartTime(shift?.startTime ?? '17:00')
    setEndTime(shift?.endTime ?? '21:00')
    setRequiredSkillLevel(shift?.requiredSkillLevel ?? 1)
    setIsOnCall(shift?.isOnCall ?? false)
    setNotes(shift?.notes ?? '')
    setSelectedEmployeeId(shift?.employeeId ?? defaultEmployeeId ?? null)
    setOverrideReason('')
    setSubmitError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shift?.id])

  const role = data.rolesById.get(roleId)
  const roleName = role ? (lang.startsWith('es') && role.nameEs ? role.nameEs : role.name) : roleId

  const draftShift: ShiftLike = useMemo(
    () => ({
      id: shift?.id,
      date,
      startTime,
      endTime,
      roleId,
      requiredSkillLevel,
      employeeId: null,
    }),
    [shift?.id, date, startTime, endTime, roleId, requiredSkillLevel],
  )

  const candidates = useMemo<Candidate[]>(() => {
    return data.employees
      .filter((e) => e.status === 'active')
      .map((employee) => {
        const skill = effectiveSkillFor(
          { id: employee.id, status: employee.status, shiftRoles: employee.shiftRoles },
          roleId,
          data.canCoverRoleIds,
        )
        return {
          employee,
          skill,
          direct: employee.shiftRoles.some((r) => r.roleId === roleId),
          conflicts: data.conflictsFor(draftShift, employee.id),
        }
      })
      .sort(
        (a, b) =>
          b.skill - a.skill ||
          a.employee.lastName.localeCompare(b.employee.lastName) ||
          a.employee.firstName.localeCompare(b.employee.firstName),
      )
  }, [data, roleId, draftShift])

  const selected = selectedEmployeeId
    ? candidates.find((c) => c.employee.id === selectedEmployeeId)
    : null
  const selectedBlocks = selected?.conflicts.filter((c) => c.severity === 'block') ?? []
  const selectedWarns = selected?.conflicts.filter((c) => c.severity === 'warn') ?? []
  const needsOverride = selectedBlocks.length > 0 && selectedBlocks.every((c) => c.overridable)
  const blockedNonOverridable = selectedBlocks.some((c) => !c.overridable)

  const fieldsDisabled = !canEdit || needsOverride || submitting

  function buildPayload(employeeId: string | null) {
    return {
      employeeId,
      date,
      startTime,
      endTime,
      roleId,
      requiredSkillLevel,
      department: role?.department ?? 'FOH',
      station: station.trim() ? station.trim() : null,
      notes: notes.trim() ? notes.trim() : null,
      isOnCall,
    }
  }

  async function handleSave() {
    setSubmitting(true)
    setSubmitError(null)
    try {
      if (shift) {
        await data.updateShift(shift.id, buildPayload(selectedEmployeeId))
      } else {
        await data.createShift(buildPayload(selectedEmployeeId))
      }
      toast.show({ tone: 'success', message: t('scheduleBuilder.modal.toast.saved') })
      onClose()
    } catch {
      setSubmitError(t('scheduleBuilder.modal.toast.saveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleAssignAnyway() {
    if (!selectedEmployeeId) return
    const reason = overrideReason.trim()
    if (!reason) return

    setSubmitting(true)
    setSubmitError(null)
    try {
      let shiftId = shift?.id
      if (!shiftId) {
        const created = await data.createShift(buildPayload(null))
        shiftId = created.id
      }
      await recordScheduleOverride({
        weekId: data.weekId,
        shiftId,
        employeeId: selectedEmployeeId,
        reason,
      })
      toast.show({ tone: 'success', message: t('scheduleBuilder.modal.toast.overrideSaved') })
      await data.reload()
      onClose()
    } catch (err) {
      if (err instanceof ScheduleOverrideRejected) {
        // See src/lib/firebaseError.ts: FunctionsErrorCode arrives prefixed
        // ('functions/failed-precondition'), so a bare `===` against the short
        // name never fires. isFirebaseError() matches on the code's tail.
        setSubmitError(
          isFirebaseError(err, 'failed-precondition')
            ? t('scheduleBuilder.modal.override.errorPrecondition')
            : isFirebaseError(err, 'aborted')
              ? t('scheduleBuilder.modal.override.errorAborted')
              : t('scheduleBuilder.modal.override.errorGeneric'),
        )
      } else {
        setSubmitError(t('scheduleBuilder.modal.toast.saveFailed'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete() {
    if (!shift) return
    setSubmitting(true)
    try {
      await data.deleteShift(shift.id)
      toast.show({ tone: 'success', message: t('scheduleBuilder.modal.toast.deleted') })
      onClose()
    } catch {
      setSubmitError(t('scheduleBuilder.modal.toast.deleteFailed'))
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={shift ? t('scheduleBuilder.modal.editTitle') : t('scheduleBuilder.modal.createTitle')}
      subtitle={date ? formatDate(dateFromIso(date), { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }, lang) : undefined}
      width={640}
      footer={
        <>
          {shift ? (
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={submitting || !canEdit}
              className="mr-auto text-meta font-semibold text-danger hover:underline disabled:opacity-40"
            >
              {t('scheduleBuilder.modal.deleteShift')}
            </button>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          {needsOverride ? (
            <Button
              variant="danger"
              disabled={!canEdit || submitting || !overrideReason.trim()}
              onClick={() => void handleAssignAnyway()}
            >
              {t('conflicts.overrideCta')}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!canEdit || submitting || blockedNonOverridable}
              onClick={() => void handleSave()}
            >
              {t('scheduleBuilder.modal.saveShift')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-6">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Field label={t('scheduleBuilder.modal.role')}>
              <select
                value={roleId}
                onChange={(e) => setRoleId(e.target.value)}
                disabled={fieldsDisabled}
                className={FIELD_CLASS}
              >
                {data.roles
                  .filter((r) => r.active || r.id === roleId)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {lang.startsWith('es') && r.nameEs ? r.nameEs : r.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label={t('scheduleBuilder.modal.station')}>
              <input
                type="text"
                value={station}
                onChange={(e) => setStation(e.target.value)}
                disabled={fieldsDisabled}
                placeholder={t('scheduleBuilder.modal.stationPlaceholder')}
                className={FIELD_CLASS}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label={t('scheduleBuilder.modal.start')}>
              <input
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                disabled={fieldsDisabled}
                className={`${FIELD_CLASS} tabular`}
              />
            </Field>
            <Field label={t('scheduleBuilder.modal.end')}>
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                disabled={fieldsDisabled}
                className={`${FIELD_CLASS} tabular`}
              />
            </Field>
          </div>

          <div className="space-y-2">
            <label className="text-meta font-medium text-ink-muted">
              {t('scheduleBuilder.modal.requiredSkill')}
            </label>
            <div className="flex rounded-control border border-line bg-app p-1">
              {SKILL_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  disabled={fieldsDisabled}
                  onClick={() => setRequiredSkillLevel(level)}
                  className={[
                    'flex-1 rounded py-1.5 text-meta font-semibold transition-colors duration-hover disabled:opacity-40',
                    requiredSkillLevel === level
                      ? 'bg-page text-primary shadow-sm ring-1 ring-line'
                      : 'text-ink-muted',
                  ].join(' ')}
                >
                  {t('people.levelShort', { level })}
                </button>
              ))}
            </div>
            <p className="text-chip text-ink-muted">{t('scheduleBuilder.modal.requiredSkillHelp')}</p>
          </div>

          <div className="flex items-center justify-between border-t border-line pt-4">
            <div className="flex flex-col">
              <span className="text-meta font-medium text-ink">{t('scheduleBuilder.modal.onCall')}</span>
              <p className="text-chip text-ink-muted">{t('scheduleBuilder.modal.onCallHelp')}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={isOnCall}
              disabled={fieldsDisabled}
              onClick={() => setIsOnCall((v) => !v)}
              className={[
                'relative h-5 w-10 shrink-0 rounded-full transition-colors duration-hover disabled:opacity-40',
                isOnCall ? 'bg-primary' : 'bg-line',
              ].join(' ')}
            >
              <span
                className={[
                  'absolute top-0.5 h-4 w-4 rounded-full bg-page shadow-sm transition-transform duration-hover',
                  isOnCall ? 'translate-x-[22px]' : 'translate-x-0.5',
                ].join(' ')}
              />
            </button>
          </div>

          <Field label={t('scheduleBuilder.modal.notes')}>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={fieldsDisabled}
              rows={3}
              className={`${FIELD_CLASS} h-auto resize-none py-2`}
            />
          </Field>
        </div>

        {needsOverride && selected ? (
          <div className="rounded-card border border-danger bg-danger-tint p-4">
            <p className="text-meta font-semibold text-danger">{t('conflicts.blockedTitle')}</p>
            <p className="mt-1 text-chip text-ink">
              {selectedBlocks.map((c) => t(c.messageKey, c.params)).join(' — ')}
            </p>
            <label className="mt-3 block text-chip font-medium text-ink-muted">
              {t('conflicts.overrideReasonLabel')}
            </label>
            <textarea
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              rows={2}
              className={`${FIELD_CLASS} mt-1 h-auto resize-none py-2`}
              placeholder={t('conflicts.overrideReasonHelp')}
            />
            <p className="mt-1 text-chip text-ink-muted">{t('conflicts.overrideReasonHelp')}</p>
          </div>
        ) : selected && selectedWarns.length > 0 ? (
          <div className="rounded-card border border-warning bg-warning-tint p-4">
            <p className="text-meta font-semibold text-warning">{t('conflicts.warningTitle')}</p>
            <p className="mt-1 text-chip text-ink">
              {selectedWarns.map((c) => t(c.messageKey, c.params)).join(' — ')}
            </p>
          </div>
        ) : null}

        {submitError ? (
          <div className="rounded-card border border-danger bg-danger-tint p-3 text-chip text-danger">
            {submitError}
          </div>
        ) : null}

        <div className="overflow-hidden rounded-card border border-line">
          <div className="flex items-center justify-between border-b border-line bg-app px-4 py-3">
            <h3 className="text-meta font-semibold text-ink">
              {t('scheduleBuilder.modal.eligibleTitle')}
            </h3>
            <span className="text-chip text-ink-muted">{t('scheduleBuilder.modal.eligibleSorted')}</span>
          </div>
          <div className="max-h-72 divide-y divide-line overflow-y-auto">
            <button
              type="button"
              disabled={!canEdit || submitting}
              onClick={() => setSelectedEmployeeId(null)}
              className={[
                'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-hover hover:bg-app disabled:cursor-not-allowed',
                selectedEmployeeId === null ? 'bg-primary-tint' : '',
              ].join(' ')}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-line text-ink-muted">
                —
              </span>
              <span className="text-meta font-medium italic text-ink-muted">
                {t('scheduleBuilder.modal.leaveOpen')}
              </span>
            </button>

            {candidates.map((candidate) => (
              <CandidateRow
                key={candidate.employee.id}
                candidate={candidate}
                roleName={roleName}
                selected={selectedEmployeeId === candidate.employee.id}
                disabled={!canEdit || submitting}
                onSelect={() => setSelectedEmployeeId(candidate.employee.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <label className="text-meta font-medium text-ink-muted">{label}</label>
      {children}
    </div>
  )
}

function CandidateRow({
  candidate,
  roleName,
  selected,
  disabled,
  onSelect,
}: {
  candidate: Candidate
  roleName: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
}): JSX.Element {
  const { t } = useTranslation()
  const { employee, skill, direct, conflicts } = candidate

  const blocks = conflicts.filter((c) => c.severity === 'block')
  const warns = conflicts.filter((c) => c.severity === 'warn')
  const nonOverridable = blocks.find((c) => !c.overridable)
  const overridable = blocks.find((c) => c.overridable)
  const roleMismatch =
    nonOverridable?.code === 'wrong-role' || nonOverridable?.code === 'inactive-employee'
  const rowDisabled = disabled || Boolean(nonOverridable)

  const skillLabel =
    skill > 0 ? t('scheduleBuilder.modal.eligibleSkill', { role: roleName, level: skill }) : roleName

  let badgeTone: 'success' | 'warning' | 'danger' | 'muted' = 'success'
  let badgeText: string
  if (nonOverridable) {
    badgeTone = roleMismatch ? 'muted' : 'danger'
    badgeText = roleMismatch
      ? t('scheduleBuilder.modal.notEligible')
      : t(nonOverridable.messageKey, nonOverridable.params)
  } else if (overridable) {
    badgeTone = 'warning'
    badgeText = t(overridable.messageKey, overridable.params)
  } else if (warns.length > 0) {
    badgeTone = 'warning'
    badgeText = warns.map((w) => t(w.messageKey, w.params)).join(' — ')
  } else {
    badgeText = direct ? t('scheduleBuilder.modal.available') : t('scheduleBuilder.modal.canCover')
  }

  const badgeClass = {
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
    muted: 'text-ink-muted',
  }[badgeTone]

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={rowDisabled}
      className={[
        'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-hover',
        rowDisabled ? 'cursor-not-allowed opacity-40 grayscale' : 'hover:bg-app',
        selected ? 'bg-primary-tint' : '',
      ].join(' ')}
    >
      <Avatar firstName={employee.firstName} lastName={employee.lastName} photoUrl={employee.photoUrl} size={28} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-meta font-semibold text-ink">{employeeName(employee)}</span>
        <span className="flex items-center gap-2">
          <span className="truncate text-chip text-ink-muted">{skillLabel}</span>
          <span className={`truncate text-chip font-medium ${badgeClass}`}>{badgeText}</span>
        </span>
      </span>
      {selected ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="h-4 w-4 shrink-0 text-primary" aria-hidden="true">
          <path d="m5 13 4 4L19 7" />
        </svg>
      ) : roleMismatch ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true">
          <rect x="4" y="10" width="16" height="10" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      ) : null}
    </button>
  )
}
