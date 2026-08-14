import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Avatar, Button, EmptyState, Pill, Table, TableCell, TableHead, TableRow, useToast } from '@/components/ui'
import { formatDate } from '@/lib/format'
import { declineTrade } from '@/lib/scheduling/trades'
import type { Trade } from '@/types/models'

import { dateFromIso, employeeName, roleDisplayName, timeLabel } from '../shared'
import { tradeErrorMessage } from '../tradeErrors'
import { shiftKeyFor, type ShiftPoolData } from '../useShiftPoolData'

/**
 * "Shift pool requests" (pool claims awaiting sign-off) and "Trade requests"
 * (direct offers the recipient accepted) — spec §7's "Admin dashboard
 * surfaces pending trades as approve/decline cards." Both share this layout;
 * they differ only in which party column reads as the claimant/recipient.
 */
export function ApprovalQueueTab({
  trades,
  kind,
  data,
  onReview,
  onChanged,
}: {
  trades: Trade[]
  kind: 'pool' | 'direct'
  data: ShiftPoolData
  onReview: (trade: Trade) => void
  onChanged: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()
  const [decliningId, setDecliningId] = useState<string | null>(null)

  async function handleDecline(trade: Trade) {
    setDecliningId(trade.id)
    try {
      await declineTrade({ tradeId: trade.id })
      toast.show({ tone: 'success', message: t('shiftPool.toast.tradeDeclined') })
      onChanged()
    } catch (err) {
      toast.show({ tone: 'error', message: tradeErrorMessage(t, err) })
    } finally {
      setDecliningId(null)
    }
  }

  if (data.loading) {
    return <div className="h-64 animate-skeleton rounded-card bg-app" />
  }

  if (trades.length === 0) {
    return (
      <EmptyState
        illustration="trades"
        title={t(kind === 'pool' ? 'shiftPool.poolRequests.emptyTitle' : 'shiftPool.tradeRequests.emptyTitle')}
        body={t(kind === 'pool' ? 'shiftPool.poolRequests.emptyBody' : 'shiftPool.tradeRequests.emptyBody')}
      />
    )
  }

  return (
    <Table>
      <TableHead>
        <TableCell className="flex-[2]">{t('shiftPool.upForGrabs.offeredBy')}</TableCell>
        <TableCell className="flex-[2]">{kind === 'pool' ? t('shiftPool.approvalQueue.claimedBy') : t('shiftPool.approvalQueue.offeredTo')}</TableCell>
        <TableCell className="flex-[2]">{t('shiftPool.upForGrabs.shift')}</TableCell>
        <TableCell className="flex-1">{t('shiftPool.upForGrabs.role')}</TableCell>
        <TableCell className="flex-[2]" align="right" />
      </TableHead>
      {trades.map((trade) => {
        const from = trade.fromEmployeeId ? data.employeesById.get(trade.fromEmployeeId) : undefined
        const to = (trade.type === 'direct' ? trade.toEmployeeId : trade.claimedBy) ?? null
        const toEmployee = to ? data.employeesById.get(to) : undefined
        const role = data.rolesById.get(trade.eligibilitySnapshot.roleId)
        const shift = data.shiftsByKey.get(shiftKeyFor(trade))

        return (
          <TableRow key={trade.id}>
            <TableCell className="flex-[2]">
              {from ? (
                <>
                  <Avatar firstName={from.firstName} lastName={from.lastName} photoUrl={from.photoUrl} size={28} />
                  <span className="truncate text-meta font-semibold text-ink">{employeeName(from)}</span>
                </>
              ) : (
                <span className="text-meta italic text-ink-muted">{t('shiftPool.approvalModal.openShift')}</span>
              )}
            </TableCell>
            <TableCell className="flex-[2]">
              {toEmployee ? (
                <>
                  <Avatar firstName={toEmployee.firstName} lastName={toEmployee.lastName} photoUrl={toEmployee.photoUrl} size={28} />
                  <span className="truncate text-meta font-semibold text-ink">{employeeName(toEmployee)}</span>
                </>
              ) : (
                <span className="text-meta text-ink-muted">{t('shiftPool.approvalModal.unknownEmployee')}</span>
              )}
            </TableCell>
            <TableCell className="flex-[2]">
              {shift ? (
                <div className="flex flex-col">
                  <span className="tabular text-meta font-medium text-ink">
                    {formatDate(dateFromIso(shift.date), { weekday: 'short', month: 'short', day: 'numeric' }, lang)} ·{' '}
                    {timeLabel(shift.startTime, lang)} – {timeLabel(shift.endTime, lang)}
                  </span>
                </div>
              ) : (
                <Pill tone="declined">{t('shiftPool.approvalQueue.shiftChanged')}</Pill>
              )}
            </TableCell>
            <TableCell className="flex-1">
              {role ? (
                <span
                  className="inline-flex items-center rounded-full px-2 py-0.5 text-chip font-semibold"
                  style={{ backgroundColor: `${role.color}1A`, color: role.color }}
                >
                  {roleDisplayName(role, lang)}
                </span>
              ) : null}
            </TableCell>
            <TableCell className="flex-[2]" align="right">
              <div className="flex items-center justify-end gap-2">
                <Button variant="success" onClick={() => onReview(trade)}>
                  {t('shiftPool.approvalQueue.review')}
                </Button>
                <Button variant="secondary" disabled={decliningId === trade.id} onClick={() => void handleDecline(trade)}>
                  {t('shiftPool.awaitingApproval.decline')}
                </Button>
              </div>
            </TableCell>
          </TableRow>
        )
      })}
    </Table>
  )
}
