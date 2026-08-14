import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Avatar,
  Button,
  EmptyState,
  FilterBar,
  FilterSelect,
  SearchInput,
  Table,
  TableCell,
  TableHead,
  TableRow,
  useToast,
} from '@/components/ui'
import { formatDate } from '@/lib/format'
import { claimTrade, declineTrade } from '@/lib/scheduling/trades'
import type { Trade } from '@/types/models'

import { dateFromIso, employeeName, roleDisplayName, timeLabel } from '../shared'
import { tradeErrorMessage } from '../tradeErrors'
import { shiftKeyFor, type ShiftPoolData } from '../useShiftPoolData'

const ALL = 'all'

/**
 * "Up for grabs" — mockup 16's main table. Pool trades only, via
 * `listOpenTradesForDepartment` per this task's brief; mockup 16 draws one row
 * with a named "Offering to" avatar, which is a direct offer's shape, not a
 * pool drop's — that row isn't reproduced here (ShiftPoolPage.tsx's top
 * comment records this as a resolved mockup/data-model conflict). Also
 * carries the "Awaiting your approval" strip for pool CLAIMS specifically —
 * "Shift pool requests" is the same data as its own dedicated full list.
 */
export function UpForGrabsTab({
  data,
  canApprove,
  canPost,
  onReview,
  onPost,
  onOffer,
  onChanged,
}: {
  data: ShiftPoolData
  canApprove: boolean
  canPost: boolean
  onReview: (trade: Trade) => void
  onPost: () => void
  onOffer: () => void
  onChanged: () => void
}): JSX.Element {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const toast = useToast()

  const [department, setDepartment] = useState(ALL)
  const [roleId, setRoleId] = useState(ALL)
  const [search, setSearch] = useState('')
  const [claimingId, setClaimingId] = useState<string | null>(null)
  const [decliningId, setDecliningId] = useState<string | null>(null)

  const roleOptions = useMemo(() => {
    const ids = [...new Set(data.openPoolTrades.map((tr) => tr.eligibilitySnapshot.roleId))]
    return ids
      .map((id) => data.rolesById.get(id))
      .filter((r): r is NonNullable<typeof r> => Boolean(r))
      .sort((a, b) => a.sortOrder - b.sortOrder)
  }, [data.openPoolTrades, data.rolesById])

  const filtered = useMemo(() => {
    return data.openPoolTrades.filter((trade) => {
      if (department !== ALL && trade.department !== department) return false
      if (roleId !== ALL && trade.eligibilitySnapshot.roleId !== roleId) return false
      if (search.trim()) {
        const q = search.trim().toLowerCase()
        const poster = trade.fromEmployeeId
          ? data.employeesById.get(trade.fromEmployeeId)
          : data.employeesById.get(trade.postedBy)
        const roleName = roleDisplayName(data.rolesById.get(trade.eligibilitySnapshot.roleId), lang)
        const haystack = `${poster ? employeeName(poster) : ''} ${roleName}`.toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
  }, [data.openPoolTrades, data.employeesById, data.rolesById, department, roleId, search, lang])

  async function handleClaim(trade: Trade) {
    setClaimingId(trade.id)
    try {
      await claimTrade(trade.id)
      toast.show({ tone: 'success', message: t('shiftPool.toast.claimed') })
      onChanged()
    } catch (err) {
      toast.show({ tone: 'error', message: tradeErrorMessage(t, err) })
    } finally {
      setClaimingId(null)
    }
  }

  async function handleQuickDecline(trade: Trade) {
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

  return (
    <div className="space-y-4">
      {canApprove && data.poolClaims.length > 0 ? (
        <div className="space-y-2 rounded-card border border-warning bg-page p-4 shadow-sm">
          <div className="flex items-center gap-2">
            <h3 className="text-body font-semibold text-ink">{t('shiftPool.awaitingApproval.title')}</h3>
            <span className="rounded-full bg-warning-tint px-2 py-0.5 text-chip font-bold text-warning">
              {data.poolClaims.length}
            </span>
          </div>
          <div className="divide-y divide-line">
            {data.poolClaims.map((trade) => {
              const claimant = trade.claimedBy ? data.employeesById.get(trade.claimedBy) : undefined
              const poster = trade.fromEmployeeId ? data.employeesById.get(trade.fromEmployeeId) : undefined
              return (
                <div key={trade.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex -space-x-2">
                      {claimant ? (
                        <Avatar firstName={claimant.firstName} lastName={claimant.lastName} photoUrl={claimant.photoUrl} size={28} />
                      ) : null}
                      {poster ? (
                        <Avatar firstName={poster.firstName} lastName={poster.lastName} photoUrl={poster.photoUrl} size={28} />
                      ) : null}
                    </div>
                    <p className="text-meta text-ink">
                      {poster
                        ? t('shiftPool.awaitingApproval.claimLine', {
                            claimant: claimant ? employeeName(claimant) : t('shiftPool.approvalModal.unknownEmployee'),
                            poster: employeeName(poster),
                          })
                        : t('shiftPool.awaitingApproval.claimLineOpenShift', {
                            claimant: claimant ? employeeName(claimant) : t('shiftPool.approvalModal.unknownEmployee'),
                          })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="success" size="md" onClick={() => onReview(trade)}>
                      {t('shiftPool.awaitingApproval.approve')}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={decliningId === trade.id}
                      onClick={() => void handleQuickDecline(trade)}
                    >
                      {t('shiftPool.awaitingApproval.decline')}
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-section font-semibold text-ink">{t('shiftPool.upForGrabs.title')}</h2>
          <span className="tabular text-meta text-ink-muted">
            {t('shiftPool.upForGrabs.count', { count: filtered.length })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {canPost ? (
            <Button variant="primary" onClick={onPost}>
              {t('shiftPool.upForGrabs.postOpenShift')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onOffer}>
            {t('shiftPool.upForGrabs.offerMyShift')}
          </Button>
        </div>
      </div>

      <FilterBar>
        <FilterSelect
          label={t('filters.department')}
          value={department}
          onChange={setDepartment}
          options={[
            { value: ALL, label: t('filters.allDepartments') },
            { value: 'FOH', label: t('departments.FOH') },
            { value: 'BOH', label: t('departments.BOH') },
          ]}
        />
        <FilterSelect
          label={t('filters.role')}
          value={roleId}
          onChange={setRoleId}
          options={[
            { value: ALL, label: t('filters.allRoles') },
            ...roleOptions.map((r) => ({ value: r.id, label: roleDisplayName(r, lang) })),
          ]}
        />
        <div className="ml-auto">
          <SearchInput value={search} onChange={setSearch} placeholder={t('shiftPool.filters.searchPlaceholder')} />
        </div>
      </FilterBar>

      {data.loading ? (
        <div className="h-64 animate-skeleton rounded-card bg-app" />
      ) : filtered.length === 0 ? (
        <EmptyState
          illustration="trades"
          title={t('shiftPool.upForGrabs.emptyTitle')}
          body={t('shiftPool.upForGrabs.emptyBody')}
        />
      ) : (
        <Table>
          <TableHead>
            <TableCell className="flex-[2]">{t('shiftPool.upForGrabs.offeredBy')}</TableCell>
            <TableCell className="flex-[2]">{t('shiftPool.upForGrabs.offeringTo')}</TableCell>
            <TableCell className="flex-[2]">{t('shiftPool.upForGrabs.shift')}</TableCell>
            <TableCell className="flex-1">{t('shiftPool.upForGrabs.department')}</TableCell>
            <TableCell className="flex-1">{t('shiftPool.upForGrabs.role')}</TableCell>
            <TableCell className="flex-[2]" align="right" />
          </TableHead>
          {filtered.map((trade) => {
            const poster = trade.fromEmployeeId ? data.employeesById.get(trade.fromEmployeeId) : undefined
            const postedByEmployee = data.employeesById.get(trade.postedBy)
            const role = data.rolesById.get(trade.eligibilitySnapshot.roleId)
            const shift = data.shiftsByKey.get(shiftKeyFor(trade))
            return (
              <TableRow key={trade.id}>
                <TableCell className="flex-[2]">
                  {poster ? (
                    <>
                      <Avatar firstName={poster.firstName} lastName={poster.lastName} photoUrl={poster.photoUrl} size={28} />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-meta font-semibold text-ink">{employeeName(poster)}</span>
                        <span className="truncate text-chip text-ink-muted">
                          {roleDisplayName(role, lang)} ·{' '}
                          {t('people.levelShort', { level: trade.eligibilitySnapshot.requiredSkillLevel })}
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-dashed border-line text-ink-muted">
                        —
                      </span>
                      <div className="flex min-w-0 flex-col">
                        <span className="text-meta font-semibold text-ink">{t('shiftPool.approvalModal.openShift')}</span>
                        {postedByEmployee ? (
                          <span className="truncate text-chip text-ink-muted">
                            {t('shiftPool.upForGrabs.postedBy', { name: employeeName(postedByEmployee) })}
                          </span>
                        ) : null}
                      </div>
                    </>
                  )}
                </TableCell>
                <TableCell className="flex-[2]">
                  <span className="inline-flex items-center gap-1.5 rounded-md bg-app px-2 py-1 text-chip text-ink-muted">
                    {t('shiftPool.upForGrabs.eligibleRole', { role: roleDisplayName(role, lang) })}
                  </span>
                </TableCell>
                <TableCell className="flex-[2]">
                  {shift ? (
                    <div className="flex flex-col">
                      <span className="tabular text-meta font-medium text-ink">
                        {formatDate(dateFromIso(shift.date), { weekday: 'short', month: 'short', day: 'numeric' }, lang)} ·{' '}
                        {timeLabel(shift.startTime, lang)} – {timeLabel(shift.endTime, lang)}
                      </span>
                      <span className="text-chip text-ink-muted">{shift.station ?? ''}</span>
                    </div>
                  ) : (
                    <span className="text-chip text-ink-muted">—</span>
                  )}
                </TableCell>
                <TableCell className="flex-1 text-meta text-ink">{t(`departments.${trade.department}`)}</TableCell>
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
                  <Button variant="primary" disabled={claimingId === trade.id} onClick={() => void handleClaim(trade)}>
                    {t('shiftPool.upForGrabs.takeShift')}
                  </Button>
                </TableCell>
              </TableRow>
            )
          })}
        </Table>
      )}
    </div>
  )
}
