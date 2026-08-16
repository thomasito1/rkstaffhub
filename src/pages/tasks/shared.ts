import { RESTAURANT_TZ } from '@/lib/format'
import type { TaskInstance } from '@/types/models'

/**
 * "My Tasks" (spec §10, mockup 27) — shared helpers kept out of the page
 * component so the render tree stays readable, same convention as
 * `pages/shiftPool/shared.ts` / `pages/clock/shared.ts`.
 */

/** "YYYY-MM-DD" in the restaurant's own timezone — same `en-CA` pattern as
 * `ShiftsAndTipsPage.tsx`'s `todayIsoRestaurant()` / `selfieUpload.ts`'s
 * `yearMonthInRestaurantTz()`; must match the server's own period computation. */
export function todayIsoRestaurant(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: RESTAURANT_TZ }).format(new Date())
}

export interface TaskGroups {
  today: TaskInstance[]
  week: TaskInstance[]
  month: TaskInstance[]
}

/**
 * Groups PURELY by cadence — per-shift + daily under "Today", weekly under
 * "This Week", monthly under "This Month". Deliberately not filtered by
 * `period` (that would require parsing/comparing periods against today, which
 * the task brief calls out explicitly as out of scope): this mirrors how the
 * materialization function itself buckets periods, so a `daily` instance is
 * always a "Today" thing by construction. Within each group, open/missed
 * (actionable or notable) instances sort before done ones so a completed
 * history item never buries something that still needs attention — the
 * mockup itself doesn't specify an order, this is a light UX judgment call.
 */
export function groupByCadence(instances: TaskInstance[]): TaskGroups {
  const rank = (i: TaskInstance): number => (i.status === 'done' ? 1 : 0)
  const sorted = [...instances].sort((a, b) => rank(a) - rank(b))
  return {
    today: sorted.filter((i) => i.cadence === 'per-shift' || i.cadence === 'daily'),
    week: sorted.filter((i) => i.cadence === 'weekly'),
    month: sorted.filter((i) => i.cadence === 'monthly'),
  }
}

export interface TodayProgress {
  done: number
  total: number
  fraction: number
}

/**
 * "N of M done today" (mockup 27's progress strip) — scoped to `period ===`
 * today's restaurant-local date, per this task's brief. A DIFFERENT filter
 * than `groupByCadence`'s "Today" bucket above (which is cadence-only, no
 * period filter) — the progress strip is a bounded daily summary, the list
 * below it is the full cadence bucket.
 */
export function todayProgress(instances: TaskInstance[], todayIso: string): TodayProgress {
  const todays = instances.filter(
    (i) => (i.cadence === 'per-shift' || i.cadence === 'daily') && i.period === todayIso,
  )
  const done = todays.filter((i) => i.status === 'done').length
  const total = todays.length
  return { done, total, fraction: total > 0 ? done / total : 0 }
}

/** A Firestore Timestamp-ish value (or a plain unknown) → Date, or null. Same
 * shape as `pages/clock/shared.ts`'s `toDateOrNull` — `completedAt` is typed
 * `unknown` on `TaskInstance` for the same reason `Punch.timestamp` is. */
export function toDateOrNull(value: unknown): Date | null {
  if (value && typeof value === 'object' && 'toDate' in value) {
    try {
      return (value as { toDate(): Date }).toDate()
    } catch {
      return null
    }
  }
  return null
}

/** Whether the photo-proof mechanic applies to this instance at all — gated
 * globally by `featureFlags.taskPhotoProof` (settings/app), regardless of the
 * per-instance `requiresPhoto` field (CLAUDE.md brief for this task). */
export function effectiveRequiresPhoto(instance: TaskInstance, taskPhotoProofEnabled: boolean): boolean {
  return instance.requiresPhoto && taskPhotoProofEnabled
}
