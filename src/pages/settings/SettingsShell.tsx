import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/lib/auth/AuthProvider'
import { useAiSchedulingEnabled } from '@/pages/settings/AiProvidersPage'
import type { PermissionKey } from '@/types/models'

/**
 * Settings sub-navigation — mockups 32/35/36's shared 220px sub-nav
 * ("General, Roles & hierarchy, Permissions, Time off, AI providers,
 * Integrations, Billing"). Only the Phase 1 tabs are real screens here:
 * Roles & hierarchy (spec §7.1) and Time off (spec §5/§6). The rest of the
 * mockup's list is later-phase (Permissions matrix and General settings are
 * Phase 0 gaps predating this work; AI providers is Phase 5) or was never
 * actually scoped in the spec at all (Integrations, Billing appear in no
 * spec section) — CLAUDE.md's rule against building later-phase scaffolding
 * applies the same way to a sub-nav tab as to a top-level one, so those are
 * left out rather than stubbed with fake placeholders for phases that don't
 * exist.
 */

/**
 * `permission`/`anyOf` decide whether a tab is even SHOWN — same "hide what
 * a viewer can't use" rule RouteGuards.tsx's own header comment states, not
 * the security boundary (each page's own `RequirePermission`/self-guard, and
 * ultimately firestore.rules, are). A tab with neither is a Phase-0
 * placeholder screen (General, Permissions) with nothing sensitive behind
 * it yet, so it stays visible to everyone rather than gated on a permission
 * that doesn't correspond to real functionality.
 */
interface SettingsTab {
  to: string
  labelKey: string
  permission?: PermissionKey
  anyOf?: readonly PermissionKey[]
  /** Also requires `settings/app.featureFlags.aiScheduling` — AI providers only (Phase 5). */
  requiresAiScheduling?: boolean
}

const TABS: readonly SettingsTab[] = [
  { to: '/settings/general', labelKey: 'settings.nav.general' },
  { to: '/settings/roles', labelKey: 'settings.nav.roles', permission: 'settings.manage' },
  { to: '/settings/shift-templates', labelKey: 'settings.nav.shiftTemplates', permission: 'schedule.edit' },
  { to: '/settings/tasks', labelKey: 'settings.nav.tasks', permission: 'tasks.manage' },
  { to: '/settings/permissions', labelKey: 'settings.nav.permissions' },
  { to: '/settings/time-off', labelKey: 'settings.nav.timeOff', permission: 'timeoff.approve' },
  {
    to: '/settings/shifts-and-tips',
    labelKey: 'settings.nav.shiftsAndTips',
    anyOf: ['punches.viewAll', 'tips.viewAll'],
  },
  { to: '/settings/payroll', labelKey: 'settings.nav.payroll', permission: 'payroll.view' },
  { to: '/settings/policies', labelKey: 'settings.nav.policies', permission: 'policies.manage' },
  { to: '/settings/discipline', labelKey: 'settings.nav.discipline', permission: 'discipline.view' },
  {
    to: '/settings/ai',
    labelKey: 'settings.nav.ai',
    permission: 'ai.configureKeys',
    requiresAiScheduling: true,
  },
]

export function SettingsShell(): JSX.Element {
  const { t } = useTranslation()
  const { can } = useAuth()
  // settings/app is readable by any signed-in user (src/lib/db/settings.ts),
  // so subscribing here for the tab-visibility check is cheap and safe even
  // for viewers who will never see the tab (the `canConfigureAi` check below
  // is what actually hides it from everyone but Owner).
  const canConfigureAi = can('ai.configureKeys')
  const aiSchedulingEnabled = useAiSchedulingEnabled()

  const visibleTabs = TABS.filter((tab) => {
    if (tab.requiresAiScheduling && !(canConfigureAi && aiSchedulingEnabled)) return false
    if (tab.permission) return can(tab.permission)
    if (tab.anyOf) return tab.anyOf.some((key) => can(key))
    return true
  })

  return (
    <div className="flex h-full">
      <nav
        aria-label={t('nav.settings')}
        className="w-[220px] shrink-0 border-r border-line bg-page py-4"
      >
        <ul className="flex flex-col gap-0.5 px-2">
          {visibleTabs.map((tab) => (
            <li key={tab.to}>
              <NavLink
                to={tab.to}
                className={({ isActive }) =>
                  [
                    'block rounded-control px-3 py-2 text-meta font-medium transition-colors duration-hover',
                    isActive
                      ? 'bg-primary text-white'
                      : 'text-ink-muted hover:bg-app hover:text-ink',
                  ].join(' ')
                }
              >
                {t(tab.labelKey)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto p-8">
        <Outlet />
      </div>
    </div>
  )
}

export default SettingsShell
