import {
  PERMISSION_KEYS,
  type AccessRole,
  type PermissionKey,
  type RoleDefaults,
} from '@/types/models'

/**
 * Default permission matrix per access role — spec §4.
 *
 * These are SEED DEFAULTS ONLY. They are written to permissions/roleDefaults on
 * first run and are editable afterwards from Settings → Permissions. Reading
 * this file is not a substitute for reading the Firestore doc at runtime.
 *
 * Effective permission = employee.permissionOverrides[key] ?? roleDefaults[role][key]
 */

function grant(keys: readonly PermissionKey[]): Partial<Record<PermissionKey, boolean>> {
  const out: Partial<Record<PermissionKey, boolean>> = {}
  for (const key of PERMISSION_KEYS) out[key] = keys.includes(key)
  return out
}

const ALL = PERMISSION_KEYS

/** Keys every employee gets — self-service only. */
const SELF_SERVICE: PermissionKey[] = [
  'schedule.view',
  'timeclock.punchSelf',
  'tips.reportSelf',
  'timeoff.request',
  'trades.request',
  'tasks.complete',
]

const SUPERVISOR: PermissionKey[] = [
  ...SELF_SERVICE,
  'availability.viewAll',
  'tips.viewAll',
  'tasks.manage',
  // Inferred: a supervisor who can read the schedule needs the roster to make
  // sense of it. Not explicitly granted in spec §4 — flagged in PROGRESS.md.
  'employees.view',
]

const MANAGER: PermissionKey[] = [
  ...SUPERVISOR,
  'schedule.create',
  'schedule.edit',
  'schedule.publish',
  'availability.approve',
  'trades.approve',
  'trades.manualAssign',
  'punches.viewAll',
  'punches.edit',
  'tips.edit',
  'timeoff.approve',
  'employees.edit',
  'employees.rankSkills',
  'discipline.view',
  'discipline.issue',
  'payroll.view',
  'ai.generateSchedule',
  // Explicitly NOT granted per spec §4: payroll.export, payroll.lockPeriod,
  // employees.editPay, policies.manage, settings.manage, permissions.manage,
  // ai.configureKeys.
]

/** GM gets everything except the AI key vault (spec §4, toggleable). */
const GM: PermissionKey[] = ALL.filter((k) => k !== 'ai.configureKeys')

export const ROLE_DEFAULTS: RoleDefaults = {
  owner: grant(ALL),
  gm: grant(GM),
  manager: grant(MANAGER),
  supervisor: grant(SUPERVISOR),
  staff: grant(SELF_SERVICE),
}

export function defaultsForRole(role: AccessRole): Partial<Record<PermissionKey, boolean>> {
  return ROLE_DEFAULTS[role]
}
