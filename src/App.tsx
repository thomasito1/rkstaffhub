import { Routes, Route, Navigate } from 'react-router-dom'

import { AppShell } from '@/components/shell/AppShell'
import { RequireAuth, RequirePermission } from '@/components/guards/RouteGuards'
import { ComponentGallery } from '@/pages/dev/ComponentGallery'
import { PlaceholderPage } from '@/pages/PlaceholderPage'
import { MorePage } from '@/pages/MorePage'
import { SettingsShell } from '@/pages/settings/SettingsShell'
import { RolesHierarchyPage } from '@/pages/settings/RolesHierarchyPage'
import { ShiftTemplatesPage } from '@/pages/settings/ShiftTemplatesPage'
import { TaskManagerPage } from '@/pages/settings/TaskManagerPage'
import { TimeOffAdminPage } from '@/pages/settings/TimeOffAdminPage'
import { TimeOffCalendarPage } from '@/pages/settings/TimeOffCalendarPage'
import { ShiftsAndTipsPage } from '@/pages/settings/ShiftsAndTipsPage'
import { PayrollWorkshopPage } from '@/pages/settings/PayrollWorkshopPage'
import { PolicyLibraryPage } from '@/pages/settings/PolicyLibraryPage'
import { DisciplinaryActionsPage } from '@/pages/settings/DisciplinaryActionsPage'
import { AiProvidersPage } from '@/pages/settings/AiProvidersPage'
import { MyTimeOffPage } from '@/pages/availability/MyTimeOffPage'
import { LoginPage } from '@/pages/auth/LoginPage'
import { InviteAcceptPage } from '@/pages/auth/InviteAcceptPage'
import { ForgotPasswordPage } from '@/pages/auth/ForgotPasswordPage'
import { EmployeeListPage } from '@/pages/people/EmployeeListPage'
import { EmployeeProfilePage } from '@/pages/people/EmployeeProfilePage'
import { MyProfilePage } from '@/pages/people/MyProfilePage'
import { ImportWizardPage } from '@/pages/people/ImportWizardPage'
import { MyAvailabilityPage } from '@/pages/availability/MyAvailabilityPage'
import { AvailabilityRequestsPage } from '@/pages/availability/AvailabilityRequestsPage'
import { GlanceViewPage } from '@/pages/availability/GlanceViewPage'
import { ScheduleEntryPage } from '@/pages/schedule/ScheduleEntryPage'
import { WhosWorkingPage } from '@/pages/schedule/WhosWorkingPage'
import { ShiftPoolPage } from '@/pages/shiftPool/ShiftPoolPage'
import { ClockPage } from '@/pages/clock/ClockPage'
import { MyTasksPage } from '@/pages/tasks/MyTasksPage'
import { HrHubPage } from '@/pages/hr/HrHubPage'

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
        {/* Schedule — Phase 1 (spec §6). Self-guards on schedule.view.
            /schedule splits by role: the admin builder, or staff's own
            "My Shifts" view (ScheduleEntryPage). */}
        <Route path="schedule" element={<ScheduleEntryPage />} />
        <Route path="schedule/whos-working" element={<WhosWorkingPage />} />
        <Route path="clock" element={<ClockPage />} />

        {/* Availability — Phase 1 (spec §5). Each page self-guards its own
            permission; the routes below only need to match each page's
            default cross-link paths. */}
        <Route path="availability" element={<MyAvailabilityPage />} />
        <Route
          path="availability/requests"
          element={
            <AvailabilityRequestsPage
              glancePath="/availability/glance"
              peoplePath="/people"
            />
          }
        />
        <Route
          path="availability/glance"
          element={<GlanceViewPage requestsPath="/availability/requests" />}
        />
        <Route path="time-off" element={<MyTimeOffPage />} />
        <Route path="shift-pool" element={<ShiftPoolPage />} />
        <Route path="tasks" element={<MyTasksPage />} />
        <Route path="hr" element={<HrHubPage />} />
        <Route
          path="reports"
          element={<PlaceholderPage titleKey="nav.reports" phase={3} />}
        />
        <Route path="settings" element={<SettingsShell />}>
          <Route index element={<Navigate to="general" replace />} />
          <Route
            path="general"
            element={<PlaceholderPage titleKey="settings.nav.general" phase={0} />}
          />
          <Route path="roles" element={<RolesHierarchyPage />} />
          <Route path="shift-templates" element={<ShiftTemplatesPage />} />
          <Route path="tasks" element={<TaskManagerPage />} />
          <Route
            path="permissions"
            element={<PlaceholderPage titleKey="settings.nav.permissions" phase={0} />}
          />
          <Route path="time-off" element={<TimeOffAdminPage />} />
          <Route path="time-off/calendar" element={<TimeOffCalendarPage />} />
          <Route path="shifts-and-tips" element={<ShiftsAndTipsPage />} />
          <Route path="payroll" element={<PayrollWorkshopPage />} />
          <Route path="policies" element={<PolicyLibraryPage />} />
          <Route path="discipline" element={<DisciplinaryActionsPage />} />
          <Route path="ai" element={<AiProvidersPage />} />
        </Route>
        <Route path="more" element={<MorePage />} />

        {/* People — Phase 0. The roster and any other person's profile need
            employees.view; your own profile never does. */}
        <Route
          path="people"
          element={
            <RequirePermission permission="employees.view">
              <EmployeeListPage />
            </RequirePermission>
          }
        />
        <Route
          path="people/import"
          element={
            <RequirePermission permission="employees.edit">
              <ImportWizardPage />
            </RequirePermission>
          }
        />
        <Route
          path="people/:employeeId"
          element={
            <RequirePermission permission="employees.view">
              <EmployeeProfilePage />
            </RequirePermission>
          }
        />
        <Route path="profile" element={<MyProfilePage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
