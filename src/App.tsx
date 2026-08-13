import { Routes, Route, Navigate } from 'react-router-dom'
import { AppShell } from '@/components/shell/AppShell'
import { ComponentGallery } from '@/pages/dev/ComponentGallery'
import { PlaceholderPage } from '@/pages/PlaceholderPage'

/**
 * Phase 0 routing skeleton.
 *
 * Routes below are placeholders that render the correct shell so the navigation
 * can be reviewed end to end. Real screens land in their own phases (spec §19):
 * schedule/availability in Phase 1, clock/trades in Phase 2, and so on.
 * Do NOT build later-phase features here.
 */
export default function App() {
  return (
    <Routes>
      {/* Dev-only gallery, outside the app shell so components are seen bare. */}
      <Route path="/dev/components" element={<ComponentGallery />} />

      <Route element={<AppShell />}>
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
        <Route path="people" element={<PlaceholderPage titleKey="nav.people" phase={0} />} />
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
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
