import { useAuth } from '@/lib/auth/AuthProvider'
import { MySchedulePage } from './MySchedulePage'
import { ScheduleBuilderPage } from './ScheduleBuilderPage'

/**
 * /schedule is shared by every role, but spec §6 draws two different
 * screens behind it: the admin grid builder, and a staff "My Shifts" view.
 * `schedule.create` is the same signal ScheduleBuilderPage itself uses to
 * gate editing, so it doubles as "does this person build schedules or just
 * read their own" here.
 */
export function ScheduleEntryPage(): JSX.Element {
  const { can } = useAuth()
  return can('schedule.create') ? <ScheduleBuilderPage /> : <MySchedulePage />
}

export default ScheduleEntryPage
