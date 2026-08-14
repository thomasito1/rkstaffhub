import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Avatar, Button, Modal, useToast } from '@/components/ui'
import { formatDate, formatHours } from '@/lib/format'
import { approveTrade, declineTrade } from '@/lib/scheduling/trades'
import { effectiveSkillFor, type Conflict } from '@/lib/scheduling/tradeEligibility'
import type { Employee, ShiftRole, Trade } from '@/types/models'

import { dateFromIso, employeeName, roleDisplayName, timeLabel } from '../shared'
import { tradeErrorMessage } from '../tradeErrors'
import { useTradeEligibilityCheck } from '../useTradeEligibilityCheck'

/**
 * Approve-trade modal — mockup 17a (passing checklist) / 17b (failing +
 * override). One component renders both states, driven entirely by the LIVE
 * `checkTradeEligibility()` result from `useTradeEligibilityCheck`, never the
 * trade's own stale `eligibilitySnapshot` (spec §7).
 *
 * Judgment call: mockup 17 always shows exactly 4 checklist rows (role,
 * skill, schedule conflict, overtime). Spec §7's four real gating conditions
 * are role coverage, skill level, no double-booking/time-off, and
 * active+department — overtime isn't one of them (tradeEligibility.ts is
 * explicit that it deliberately excludes overtime from trade gating), so that
 * 4th row is rendered as informational-only here and never blocks approval.
 * Department-mismatch/inactive-employee failures are real spec-mandated
 * blocks that the mockup's fixed 4 rows have no slot for — rather than
 * silently swallowing a real block to keep exactly 4 rows, a 5th row appears
 * ONLY when one of those fires (rare: a cross-department claim, or the
 * assignee was deactivated after posting).
 */

function CheckIcon({ className = '' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 2.5 2.5L16 9.5" />
    </svg>
  )
}

function XIcon({ className = '' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="m9.5 9.5 5 5m0-5-5 5" />
    </svg>
  )
}

function AlertIcon({ className = '' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 15.8h.01" />
    </svg>
  )
}

function toDateSafe(value: unknown): Date | null {
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate()
  }
  return null
}

interface ChecklistRow {
  key: string
  ok: boolean
  /** Never blocks approval on its own — informational display only. */
  informational?: boolean
  label: string
  detail: string
}

export function TradeApprovalModal({
  trade,
  onClose,
  employeesById,
  rolesById,
  canCoverRoleIds,
  canOverride,
  onDone,
}: {
  trade: Trade | null
  onClose: () => void
  employeesById: Map<string, Employee>
  rolesById: Map<string, ShiftRole>
  canCoverRoleIds: Record<string, string[]>
  canOverride: boolean
  onDone: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()

  const [overrideReason, setOverrideReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const check = useTradeEligibilityCheck(trade, canCoverRoleIds)

  const fromEmployee = trade?.fromEmployeeId ? employeesById.get(trade.fromEmployeeId) ?? null : null
  const toEmployee = check.assignee ?? (check.assigneeId ? employeesById.get(check.assigneeId) ?? null : null)
  const role = check.shift ? rolesById.get(check.shift.roleId) : undefined

  const blockingConflicts = check.result?.blockingConflicts ?? []
  const eligible = check.result !== null && blockingConflicts.length === 0
  const overridableFailure = blockingConflicts.length > 0 && blockingConflicts.every((c) => c.overridable)
  const showOverridePanel = overridableFailure && canOverride

  const rows = useMemo<ChecklistRow[]>(() => {
    if (!check.result || !check.shift || !toEmployee) return []
    const find = (code: Conflict['code']) => blockingConflicts.find((c) => c.code === code)

    const roleConflict = find('wrong-role')
    const skillConflict = find('skill-too-low')
    const timeOffConflict = find('time-off')
    const doubleBookedConflict = find('double-booked')
    const deptConflict = find('wrong-department')
    const inactiveConflict = find('inactive-employee')

    const roleName = roleDisplayName(role, lang)
    const skill = effectiveSkillFor(
      { id: toEmployee.id, status: toEmployee.status, shiftRoles: toEmployee.shiftRoles },
      check.shift.roleId,
      canCoverRoleIds,
    )
    const name = employeeName(toEmployee)

    const out: ChecklistRow[] = [
      {
        key: 'role',
        ok: !roleConflict,
        label: t('shiftPool.approvalModal.checklist.roleCovered'),
        detail: roleConflict
          ? t(roleConflict.messageKey, roleConflict.params)
          : t('shiftPool.approvalModal.checklist.roleCoveredOk', { name, role: roleName }),
      },
      {
        key: 'skill',
        ok: !skillConflict,
        label: t('shiftPool.approvalModal.checklist.skillLevel'),
        detail: skillConflict
          ? t(skillConflict.messageKey, skillConflict.params)
          : t('shiftPool.approvalModal.checklist.skillLevelOk', {
              level: skill,
              required: check.shift.requiredSkillLevel,
            }),
      },
      {
        key: 'schedule',
        ok: !timeOffConflict && !doubleBookedConflict,
        label: t('shiftPool.approvalModal.checklist.noConflict'),
        detail: timeOffConflict
          ? t(timeOffConflict.messageKey, timeOffConflict.params)
          : doubleBookedConflict
            ? t(doubleBookedConflict.messageKey, doubleBookedConflict.params)
            : t('shiftPool.approvalModal.checklist.noConflictOk', {
                date: formatDate(dateFromIso(check.shift.date), { month: 'short', day: 'numeric' }, lang),
              }),
      },
      {
        key: 'overtime',
        ok: true,
        informational: true,
        label: t('shiftPool.approvalModal.checklist.noOvertimeRisk'),
        detail: t('shiftPool.approvalModal.checklist.noOvertimeRiskOk', {
          hours: formatHours(check.projectedHours ?? 0, lang),
        }),
      },
    ]

    if (deptConflict || inactiveConflict) {
      out.push({
        key: 'departmentStatus',
        ok: false,
        label: t('shiftPool.approvalModal.checklist.departmentStatus'),
        detail: [deptConflict, inactiveConflict]
          .filter((c): c is Conflict => Boolean(c))
          .map((c) => t(c.messageKey, c.params))
          .join(' — '),
      })
    }

    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check.result, check.shift, check.projectedHours, toEmployee, role, lang, canCoverRoleIds])

  async function handleApprove(withOverride: boolean) {
    if (!trade) return
    setSubmitting(true)
    setActionError(null)
    try {
      await approveTrade({
        tradeId: trade.id,
        overrideReason: withOverride ? overrideReason.trim() : undefined,
      })
      toast.show({ tone: 'success', message: t('shiftPool.toast.tradeApproved') })
      onDone()
    } catch (err) {
      setActionError(tradeErrorMessage(t, err))
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDecline() {
    if (!trade) return
    setSubmitting(true)
    setActionError(null)
    try {
      await declineTrade({ tradeId: trade.id })
      toast.show({ tone: 'success', message: t('shiftPool.toast.tradeDeclined') })
      onDone()
    } catch (err) {
      setActionError(tradeErrorMessage(t, err))
    } finally {
      setSubmitting(false)
    }
  }

  const requestedAt = trade ? toDateSafe(trade.createdAt) : null

  return (
    <Modal
      open={trade !== null}
      onClose={onClose}
      title={t('shiftPool.approvalModal.title')}
      subtitle={
        requestedAt
          ? t('shiftPool.approvalModal.requestedAt', {
              date: formatDate(requestedAt, { month: 'short', day: 'numeric' }, lang),
              time: formatDate(requestedAt, { hour: 'numeric', minute: '2-digit' }, lang),
            })
          : undefined
      }
      width={560}
      footer={
        trade ? (
          <>
            <Button variant="secondary" onClick={onClose} disabled={submitting}>
              {t('shiftPool.approvalModal.viewSchedules')}
            </Button>
            <div className="ml-auto flex items-center gap-3">
              <Button variant="secondary" disabled={submitting} onClick={() => void handleDecline()}>
                {t('shiftPool.approvalModal.decline')}
              </Button>
              {eligible || check.loading ? (
                <Button variant="primary" disabled={submitting || check.loading} onClick={() => void handleApprove(false)}>
                  {t('shiftPool.approvalModal.approve')}
                </Button>
              ) : (
                <>
                  <Button
                    variant="primary"
                    disabled
                    icon={
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} className="h-4 w-4" aria-hidden="true">
                        <rect x="4" y="10" width="16" height="10" rx="2" />
                        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                      </svg>
                    }
                  >
                    {t('shiftPool.approvalModal.approve')}
                  </Button>
                  {showOverridePanel ? (
                    <Button
                      variant="danger"
                      disabled={submitting || !overrideReason.trim()}
                      onClick={() => void handleApprove(true)}
                    >
                      {t('shiftPool.approvalModal.overrideAndAssign')}
                    </Button>
                  ) : null}
                </>
              )}
            </div>
          </>
        ) : null
      }
    >
      {!trade || check.loading ? (
        <div className="h-64 animate-skeleton rounded-card bg-app" />
      ) : check.loadError || !check.shift ? (
        <p className="text-meta text-danger">{t('shiftPool.approvalModal.loadError')}</p>
      ) : (
        <div className="space-y-6">
          <div className="relative flex items-stretch overflow-hidden rounded-card border border-line">
            <div className="flex-1 p-4">
              <span className="mb-3 block text-micro font-semibold uppercase tracking-wider text-ink-muted">
                {t('shiftPool.approvalModal.from')}
              </span>
              {fromEmployee ? (
                <div className="flex items-center gap-3">
                  <Avatar firstName={fromEmployee.firstName} lastName={fromEmployee.lastName} photoUrl={fromEmployee.photoUrl} size={40} />
                  <div>
                    <p className="text-body font-semibold text-ink">{employeeName(fromEmployee)}</p>
                    <p className="text-chip text-ink-muted">
                      {roleDisplayName(rolesById.get(fromEmployee.shiftRoles.find((r) => r.isPrimary)?.roleId ?? ''), lang)}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-meta italic text-ink-muted">{t('shiftPool.approvalModal.openShift')}</p>
              )}
              <div className="mt-3">
                <span className="inline-flex items-center rounded-md bg-app px-2 py-0.5 text-chip font-semibold text-ink-muted">
                  {t('shiftPool.approvalModal.givingUp')}
                </span>
              </div>
            </div>

            <div className="w-px shrink-0 bg-line" />

            <div className="flex-1 p-4 text-right">
              <span className="mb-3 block text-micro font-semibold uppercase tracking-wider text-ink-muted">
                {t('shiftPool.approvalModal.to')}
              </span>
              {toEmployee ? (
                <div className="flex flex-row-reverse items-center gap-3">
                  <Avatar firstName={toEmployee.firstName} lastName={toEmployee.lastName} photoUrl={toEmployee.photoUrl} size={40} />
                  <div className="text-right">
                    <p className="text-body font-semibold text-ink">{employeeName(toEmployee)}</p>
                    <p className="text-chip text-ink-muted">{roleDisplayName(role, lang)}</p>
                  </div>
                </div>
              ) : (
                <p className="text-meta italic text-ink-muted">{t('shiftPool.approvalModal.unknownEmployee')}</p>
              )}
              <div className="mt-3 flex justify-end">
                <span
                  className={[
                    'inline-flex items-center rounded-md px-2 py-0.5 text-chip font-semibold',
                    eligible ? 'bg-success-tint text-success' : 'bg-danger-tint text-danger',
                  ].join(' ')}
                >
                  {eligible ? t('shiftPool.approvalModal.taking') : t('shiftPool.approvalModal.notEligible')}
                </span>
              </div>
            </div>
          </div>

          <div className="divide-y divide-line overflow-hidden rounded-card border border-line">
            <div className="flex items-center justify-between p-4">
              <span className="text-meta font-medium text-ink-muted">{t('shiftPool.approvalModal.shift')}</span>
              <span className="tabular text-meta font-semibold text-ink">
                {formatDate(dateFromIso(check.shift.date), { weekday: 'long', month: 'short', day: 'numeric' }, lang)} ·{' '}
                {timeLabel(check.shift.startTime, lang)} – {timeLabel(check.shift.endTime, lang)}
              </span>
            </div>
            <div className="flex items-center justify-between p-4">
              <span className="text-meta font-medium text-ink-muted">{t('shiftPool.approvalModal.role')}</span>
              <span className="rounded-md border border-line bg-app px-2 py-0.5 text-chip font-semibold text-ink">
                {t('shiftPool.approvalModal.roleRequired', {
                  role: roleDisplayName(role, lang),
                  level: check.shift.requiredSkillLevel,
                })}
              </span>
            </div>
            <div className="flex items-center justify-between p-4">
              <span className="text-meta font-medium text-ink-muted">{t('shiftPool.approvalModal.station')}</span>
              <span className="text-meta font-semibold text-ink">
                {check.shift.station ?? t('shiftPool.approvalModal.noStation')}
              </span>
            </div>
          </div>

          <div className="overflow-hidden rounded-card border border-line">
            <div
              className={[
                'flex items-center gap-2 px-4 py-2.5',
                eligible ? 'bg-success-tint' : 'bg-danger-tint',
              ].join(' ')}
            >
              {eligible ? (
                <CheckIcon className="h-5 w-5 shrink-0 text-success" />
              ) : (
                <AlertIcon className="h-5 w-5 shrink-0 text-danger" />
              )}
              <span className="text-meta font-semibold text-ink">
                {eligible
                  ? t('shiftPool.approvalModal.checklist.allPassed')
                  : t('shiftPool.approvalModal.checklist.someFailed', {
                      count: rows.filter((r) => !r.ok && !r.informational).length,
                    })}
              </span>
            </div>
            <div className="divide-y divide-line">
              {rows.map((row) => (
                <div key={row.key} className={['flex items-start gap-3 p-4', !row.ok && !row.informational ? 'bg-danger-tint/40' : ''].join(' ')}>
                  {row.ok ? (
                    <CheckIcon className="mt-0.5 h-5 w-5 shrink-0 text-success" />
                  ) : (
                    <XIcon className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
                  )}
                  <div className="flex flex-col">
                    <span className="text-meta font-medium text-ink">{row.label}</span>
                    <span className={`text-chip ${row.ok ? 'text-ink-muted' : 'font-medium text-danger'}`}>
                      {row.detail}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {!eligible ? (
            <div className="rounded-r-lg border-l-4 border-danger bg-danger-tint p-3">
              <p className="text-chip leading-relaxed text-ink">
                {t(blockingConflicts[0]?.messageKey ?? 'shiftPool.approvalModal.checklist.someFailed', blockingConflicts[0]?.params)}
              </p>
            </div>
          ) : null}

          {!eligible && !showOverridePanel ? (
            <p className="text-chip text-ink-muted">{t('shiftPool.approvalModal.cannotOverride')}</p>
          ) : null}

          {showOverridePanel ? (
            <div className="rounded-card border border-line bg-app p-4">
              <h3 className="mb-2 text-meta font-semibold text-ink">{t('shiftPool.approvalModal.override.title')}</h3>
              <p className="mb-4 text-chip text-ink-muted">{t('shiftPool.approvalModal.override.help')}</p>
              <label className="mb-1.5 block text-meta font-medium text-ink">
                {t('shiftPool.approvalModal.override.reason')} <span className="font-bold text-danger">*</span>
              </label>
              <textarea
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
                rows={3}
                placeholder={t('shiftPool.approvalModal.override.reasonPlaceholder')}
                className="h-24 w-full resize-none rounded-control border border-line bg-page p-3 text-meta text-ink focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
          ) : null}

          {actionError ? (
            <div className="rounded-card border border-danger bg-danger-tint p-3 text-chip text-danger">{actionError}</div>
          ) : null}
        </div>
      )}
    </Modal>
  )
}
