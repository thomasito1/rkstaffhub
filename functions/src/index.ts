/**
 * RK StaffHub — Cloud Functions entry point.
 *
 * Everything exported here exists because it CANNOT be done from the client:
 * setting custom claims, writing `auditLog`, and reading an invite for someone
 * who is not signed in yet. Anything a client could safely do itself belongs in
 * `src/lib/db/*` behind firestore.rules, not here.
 *
 *   getInvite              unauthenticated · invite preview for the accept screen
 *   acceptInvite           authenticated   · bind uid → employee, issue claims
 *   setEmployeeClaims      permissions.manage · re-sync claims after a role change
 *   onEmployeeRoleChange   trigger         · demotions take effect without re-login
 *   recordScheduleOverride schedule.edit   · §6 skill-floor override, atomically
 *                                            assigns the shift AND logs why
 *   recordSchedulePublish  schedule.publish · §6/§17 publish/republish, mode
 *                                            derived from stored state (never
 *                                            trusted from the client), then
 *                                            logs the audit entry the client
 *                                            write path could never write
 *   claimTrade/acceptTrade/
 *   approveTrade/declineTrade  §7 trade transitions firestore.rules denies to
 *                                            a plain client write — each
 *                                            independently re-verifies the
 *                                            shift and recomputes eligibility
 *                                            server-side rather than trusting
 *                                            the client's claimed state
 *   clockIn/clockOut/manualPunch  §8 time clock — server-verified geofence +
 *                                            selfie upload, server timestamp;
 *                                            manualPunch bypasses both by
 *                                            design (punches.edit, below-level)
 *   checkForgottenClockOuts  scheduled · flags (never closes) a 14h+ open
 *                                            punch and notifies managers
 *   sweepExpiredTrades     scheduled · hourly; flips a still-open direct
 *                                            offer to 'expired' at
 *                                            min(expiresAt, shift start)
 *   materializeDailyTasks/
 *   materializeWeeklyTasks/
 *   materializeMonthlyTasks  scheduled · §10 taskInstances materialization,
 *                                            each first sweeps the PRIOR
 *                                            period's still-open instances to
 *                                            'missed' before creating new ones
 *   completeTaskInstance   tasks.complete · claims (if pool) + marks an
 *                                            instance done, atomically
 *
 * Region is the default us-central1, matching `getFunctions(app)` in
 * `src/lib/firebase.ts` — the client passes no region, so changing it here
 * would break every call.
 */

import { setGlobalOptions } from 'firebase-functions/v2'

setGlobalOptions({
  region: 'us-central1',
  // A restaurant of ~35 people. A low ceiling is a cost guardrail, not a
  // capacity estimate.
  maxInstances: 10,
})

export { getInvite, acceptInvite } from './invites'
export { setEmployeeClaims, onEmployeeRoleChange } from './claims'
export { recordScheduleOverride } from './scheduleOverride'
export { recordSchedulePublish } from './schedulePublish'
export { claimTrade, acceptTrade, approveTrade, declineTrade } from './tradeActions'
export { onTradeCreated } from './tradeTriggers'
export { clockIn, clockOut, manualPunch, editPunch, editTipReport } from './punchActions'
export { checkForgottenClockOuts } from './punchScheduled'
export { submitAvailability } from './availabilityActions'
export { sweepExpiredTrades } from './tradeScheduled'
export { materializeDailyTasks, materializeWeeklyTasks, materializeMonthlyTasks } from './tasksScheduled'
export { completeTaskInstance } from './taskActions'
