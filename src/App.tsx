import { Routes, Route, Navigate } from 'react-router-dom'

import { AppShell } from '@/components/shell/AppShell'
import { RequireAuth } from '@/components/guards/RouteGuards'
import { ComponentGallery } from '@/pages/dev/ComponentGallery'
import { PlaceholderPage } from '@/pages/PlaceholderPage'
import { LoginPage } from '@/pages/auth/LoginPage'
import { InviteAcceptPage } from '@/pages/auth/InviteAcceptPage'
import { ForgotPasswordPage } from '@/pages/auth/ForgotPasswordPage'

/**
 * Phase 0 routing.
 *
 * Unauthenticated routes sit outside the shell — login and invite acceptance
 * have their own full-page layouts (mockups 01 and 02) with no rail or tab bar.
 *
 * Everything inside <RequireAuth> renders in the responsive shell. Routes that
 * belong to later phases (spec §19) are PlaceholderPages carrying their phase
 * number; they exist so navigation can be reviewed end to end. Do NOT build
 * later-phase features behind them.
 */
export default function App() {
  return (
    <Routes>
      {/* Unauthenticated */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/invite" element={<InviteAcceptPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />

      {/* Dev-only gallery, outside the shell so components are seen bare. */}
      <Route path="/dev/components" element={<ComponentGallery />} />

      {/* Authenticated app */}
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<PlaceholderPage titleKey="nav.home" phase={6} />} />
        <Route
          path="schedule"
          element={<PlaceholderPage titleKey="nav.schedule" phase={1} />}
        />
        <Route path="clock" element={<PlaceholderPage titleKey="nav.clock" phase={2} />} />
        <Route
          path="shift-pool"
          element={<PlaceholderPage titleKey="nav.shiftPool" phase={2} />}
        />
        <Route path="tasks" element={<PlaceholderPage titleKey="nav.tasks" phase={3} />} />
        <Route path="hr" element={<PlaceholderPage titleKey="nav.hr" phase={4} />} />
        <Route
          path="reports"
          element={<PlaceholderPage titleKey="nav.reports" phase={3} />}
        />
        <Route
          path="settings"
          element={<PlaceholderPage titleKey="nav.settings" phase={0} />}
        />
        <Route path="more" element={<PlaceholderPage titleKey="nav.more" phase={0} />} />

        {/* People routes are added once the employee screens land. */}
        <Route path="people" element={<PlaceholderPage titleKey="nav.people" phase={0} />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
