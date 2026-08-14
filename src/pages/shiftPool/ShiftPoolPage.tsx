import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { RequirePermission } from '@/components/guards/RouteGuards'
import { useAuth } from '@/lib/auth/AuthProvider'
import type { Trade } from '@/types/models'

import { ApprovalQueueTab } from './components/ApprovalQueueTab'
import { MyTradesTab } from './components/MyTradesTab'
import { PostShiftModal } from './components/PostShiftModal'
import { TradeApprovalModal } from './components/TradeApprovalModal'
import { UpForGrabsTab } from './components/UpForGrabsTab'
import { useShiftPoolData } from './useShiftPoolData'

/**
 * Shift Pool — mockups 16 (board) and 17a/17b (approval modal), spec §7.
 *
 * Two mockup/spec judgment calls, recorded here rather than left implicit:
 *
 * 1. Mockup 16's secondary nav has FOUR items — "Shift pool requests",
 *    "Up for grabs", "Trade requests", "My trades" — while spec §7's own UI
 *    text describes three ("Requests (badge) / Up for grabs / My trades").
 *    Read against the mockup's badge counts (pool-requests=1 matching the
 *    page's own "Awaiting your approval" strip badge; trade-requests=2,
 *    never surfaced in that strip), the natural split is by TRADE STATUS:
 *    "Shift pool requests" = pool trades claimed and awaiting sign-off,
 *    "Trade requests" = direct offers the recipient already accepted,
 *    awaiting sign-off. Implemented as two tabs over
 *    `listTradesAwaitingApproval()`'s two buckets.
 *
 * 2. Mockup 16's "Up for grabs" table draws one row with a named "Offering
 *    to" avatar (a direct-offer shape) alongside three genuine pool rows
 *    ("Eligible bartenders" etc). This task's own data-layer brief scopes
 *    "Up for grabs" to `listOpenTradesForDepartment()`, which is pool-only by
 *    construction — so that one row isn't reproduced; the tab shows pool
 *    drops exclusively, each rendering its "Offering to" cell as the eligible
 *    role group the mockup's other three rows already establish.
 */
export function ShiftPoolPage(): JSX.Element {
  return (
    <RequirePermission permission="trades.request">
      <ShiftPoolScreen />
    </RequirePermission>
  )
}

type TabKey = 'grabs' | 'poolRequests' | 'tradeRequests' | 'mine'

function ShiftPoolScreen(): JSX.Element {
  const { t } = useTranslation()
  const { employee, can } = useAuth()

  const canApprove = can('trades.approve')
  const canManagerPost = can('trades.manualAssign')

  const data = useShiftPoolData(employee?.id, canApprove)

  const [tab, setTab] = useState<TabKey>('grabs')
  const [reviewTrade, setReviewTrade] = useState<Trade | null>(null)
  const [postMode, setPostMode] = useState<'manager' | 'staff' | null>(null)

  const tabs: { key: TabKey; label: string; badge?: number; visible: boolean }[] = [
    { key: 'poolRequests', label: t('shiftPool.nav.poolRequests'), badge: data.poolClaims.length, visible: canApprove },
    { key: 'grabs', label: t('shiftPool.nav.upForGrabs'), badge: data.openPoolTrades.length, visible: true },
    { key: 'tradeRequests', label: t('shiftPool.nav.tradeRequests'), badge: data.directPending.length, visible: canApprove },
    { key: 'mine', label: t('shiftPool.nav.myTrades'), visible: true },
  ]

  return (
    <div className="mx-auto flex max-w-6xl gap-8">
      <aside className="w-60 shrink-0">
        <nav className="flex flex-col gap-1">
          {tabs
            .filter((tabDef) => tabDef.visible)
            .map((tabDef) => (
              <button
                key={tabDef.key}
                type="button"
                onClick={() => setTab(tabDef.key)}
                className={[
                  'flex items-center justify-between rounded-control px-3 py-2 text-left transition-colors duration-hover',
                  tab === tabDef.key ? 'bg-primary text-white shadow-sm' : 'text-ink-muted hover:bg-app',
                ].join(' ')}
              >
                <span className={`text-meta ${tab === tabDef.key ? 'font-semibold' : 'font-medium'}`}>{tabDef.label}</span>
                {tabDef.badge ? (
                  <span
                    className={[
                      'rounded-full px-2 py-0.5 text-chip font-bold',
                      tab === tabDef.key ? 'bg-white text-primary' : 'bg-warning-tint text-warning',
                    ].join(' ')}
                  >
                    {tabDef.badge}
                  </span>
                ) : null}
              </button>
            ))}
        </nav>
        <div className="mt-8 rounded-card-lg border border-line bg-app p-4">
          <h4 className="mb-2 text-meta font-semibold text-ink">{t('shiftPool.howItWorks.title')}</h4>
          <p className="text-chip leading-relaxed text-ink-muted">{t('shiftPool.howItWorks.body')}</p>
        </div>
      </aside>

      <div className="min-w-0 flex-1 space-y-6">
        <div>
          <h1 className="text-title-lg font-semibold tracking-tight text-ink">{t('shiftPool.title')}</h1>
          <p className="mt-0.5 text-meta text-ink-muted">{t('shiftPool.subtitle')}</p>
        </div>

        {tab === 'grabs' ? (
          <UpForGrabsTab
            data={data}
            canApprove={canApprove}
            canPost={canManagerPost}
            onReview={setReviewTrade}
            onPost={() => setPostMode('manager')}
            onOffer={() => setPostMode('staff')}
            onChanged={() => void data.reload()}
          />
        ) : tab === 'poolRequests' ? (
          <ApprovalQueueTab
            trades={data.poolClaims}
            kind="pool"
            data={data}
            onReview={setReviewTrade}
            onChanged={() => void data.reload()}
          />
        ) : tab === 'tradeRequests' ? (
          <ApprovalQueueTab
            trades={data.directPending}
            kind="direct"
            data={data}
            onReview={setReviewTrade}
            onChanged={() => void data.reload()}
          />
        ) : employee ? (
          <MyTradesTab
            trades={data.myTrades}
            currentEmployeeId={employee.id}
            data={data}
            onChanged={() => void data.reload()}
          />
        ) : null}
      </div>

      <TradeApprovalModal
        trade={reviewTrade}
        onClose={() => setReviewTrade(null)}
        employeesById={data.employeesById}
        rolesById={data.rolesById}
        canCoverRoleIds={data.canCoverRoleIds}
        canOverride={can('trades.manualAssign')}
        onDone={() => {
          setReviewTrade(null)
          void data.reload()
        }}
      />

      {employee ? (
        <PostShiftModal
          open={postMode !== null}
          mode={postMode ?? 'staff'}
          onClose={() => setPostMode(null)}
          weekId={data.weekId}
          currentEmployeeId={employee.id}
          currentEmployeeDepartment={employee.department}
          employees={data.employees}
          rolesById={data.rolesById}
          canCoverRoleIds={data.canCoverRoleIds}
          onPosted={() => void data.reload()}
        />
      ) : null}
    </div>
  )
}

export default ShiftPoolPage
