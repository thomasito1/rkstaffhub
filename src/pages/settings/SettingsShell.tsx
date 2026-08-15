import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

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

const TABS = [
  { to: '/settings/general', labelKey: 'settings.nav.general' },
  { to: '/settings/roles', labelKey: 'settings.nav.roles' },
  { to: '/settings/shift-templates', labelKey: 'settings.nav.shiftTemplates' },
  { to: '/settings/permissions', labelKey: 'settings.nav.permissions' },
  { to: '/settings/time-off', labelKey: 'settings.nav.timeOff' },
  { to: '/settings/shifts-and-tips', labelKey: 'settings.nav.shiftsAndTips' },
] as const

export function SettingsShell(): JSX.Element {
  const { t } = useTranslation()

  return (
    <div className="flex h-full">
      <nav
        aria-label={t('nav.settings')}
        className="w-[220px] shrink-0 border-r border-line bg-page py-4"
      >
        <ul className="flex flex-col gap-0.5 px-2">
          {TABS.map((tab) => (
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
