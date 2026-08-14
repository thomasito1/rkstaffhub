import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Avatar, Button, EmptyState, Pill, Table, TableCell, TableHead, TableRow, useToast } from '@/components/ui'
import { cancelTrade, isTradeExpired } from '@/lib/db'
import { formatDate } from '@/lib/format'
import { acceptTrade, declineTrade } from '@/lib/scheduling/trades'
import type { Trade } from '@/types/models'

import { dateFromIso, employeeName, roleDisplayName, timeLabel, tradeStatusTone } from '../shared'
import { tradeErrorMessage } from '../tradeErrors'
import { shiftKeyFor, type ShiftPoolData } from '../useShiftPoolData'

/**
 * "My trades" — every trade the viewer is a party to (poster, direct
 * recipient, or pool claimant), mirroring `listMyTrades()`. Expired direct
 * offers (`isTradeExpired()`, the 48h informational-only window — spec §7's
 * mockup 18c note) render with an Expired pill and no action buttons, so a
 * stale offer never looks actionable.
 */
export function MyTradesTab({
  trades,
  currentEmployeeId,
  data,
  onChanged,
}: {
  trades: Trade[]
  currentEmployeeId: string
  data: ShiftPoolData
  onChanged: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()
  const [busyId, setBusyId] = useState<string | null>(null)

  async function run(trade: Trade, action: () => Promise<unknown>, successKey: string) {
    setBusyId(trade.id)
    try {
      await action()
      toast.show({ tone: 'success', message: t(successKey) })
      onChanged()
    } catch (err) {
      toast.show({ tone: 'error', message: tradeErrorMessage(t, err) })
    } finally {
      setBusyId(null)
    }
  }

  if (data.loading) {
    return <div className="h-64 animate-skeleton rounded-card bg-app" />
  }

  if (trades.length === 0) {
    return (
      <EmptyState illustration="trades" title={t('shiftPool.myTrades.emptyTitle')} body={t('shiftPool.myTrades.emptyBody')} />
    )
  }

  return (
    <Table>
      <TableHead>
        <TableCell className="flex-[2]">{t('shiftPool.myTrades.shift')}</TableCell>
        <TableCell className="flex-1">{t('shiftPool.upForGrabs.role')}</TableCell>
        <TableCell className="flex-[2]">{t('shiftPool.myTrades.withWhom')}</TableCell>
        <TableCell className="flex-1">{t('shiftPool.myTrades.status')}</TableCell>
        <TableCell className="flex-[2]" align="right" />
      </TableHead>
      {trades.map((trade) => {
        const shift = data.shiftsByKey.get(shiftKeyFor(trade))
        const role = data.rolesById.get(trade.eligibilitySnapshot.roleId)
        const expired = isTradeExpired(trade)

        const iAmPoster = trade.postedBy === currentEmployeeId
        const iAmDirectRecipient = trade.type === 'direct' && trade.toEmployeeId === currentEmployeeId
        const iAmClaimant = trade.claimedBy === currentEmployeeId

        const counterpartId = iAmDirectRecipient
          ? trade.fromEmployeeId
          : iAmClaimant
            ? trade.fromEmployeeId
            : trade.type === 'direct'
              ? trade.toEmployeeId
              : null
        const counterpart = counterpartId ? data.employeesById.get(counterpartId) : undefined

        const canCancel = iAmPoster && trade.status === 'open'
        const canAcceptOrDecline = iAmDirectRecipient && trade.status === 'open' && !expired
        const busy = busyId === trade.id

        return (
          <TableRow key={trade.id}>
            <TableCell className="flex-[2]">
              {shift ? (
                <div className="flex flex-col">
                  <span className="tabular text-meta font-medium text-ink">
                    {formatDate(dateFromIso(shift.date), { weekday: 'short', month: 'short', day: 'numeric' }, lang)} ·{' '}
                    {timeLabel(shift.startTime, lang)} – {timeLabel(shift.endTime, lang)}
                  </span>
                </div>
              ) : (
                <span className="text-chip text-ink-muted">—</span>
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
            <TableCell className="flex-[2]">
              {counterpart ? (
                <>
                  <Avatar firstName={counterpart.firstName} lastName={counterpart.lastName} photoUrl={counterpart.photoUrl} size={28} />
                  <span className="truncate text-meta text-ink">{employeeName(counterpart)}</span>
                </>
              ) : (
                <span className="text-meta italic text-ink-muted">
                  {trade.type === 'pool' ? t('shiftPool.myTrades.eligibleCoworkers') : t('shiftPool.approvalModal.openShift')}
                </span>
              )}
            </TableCell>
            <TableCell className="flex-1">
              <Pill tone={expired ? 'declined' : tradeStatusTone(trade.status)}>
                {expired ? t('shiftPool.status.expired') : t(`shiftPool.status.${trade.status}`)}
              </Pill>
            </TableCell>
            <TableCell className="flex-[2]" align="right">
              <div className="flex items-center justify-end gap-2">
                {canAcceptOrDecline ? (
                  <>
                    <Button
                      variant="success"
                      disabled={busy}
                      onClick={() => void run(trade, () => acceptTrade(trade.id), 'shiftPool.toast.accepted')}
                    >
                      {t('shiftPool.myTrades.accept')}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void run(trade, () => declineTrade({ tradeId: trade.id }), 'shiftPool.toast.tradeDeclined')}
                    >
                      {t('shiftPool.awaitingApproval.decline')}
                    </Button>
                  </>
                ) : canCancel ? (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run(trade, () => cancelTrade(trade.id, currentEmployeeId), 'shiftPool.toast.cancelled')}
                  >
                    {t('shiftPool.myTrades.cancel')}
                  </Button>
                ) : null}
              </div>
            </TableCell>
          </TableRow>
        )
      })}
    </Table>
  )
}
