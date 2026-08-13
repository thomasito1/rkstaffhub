/**
 * RK StaffHub — Cloud Functions entry point.
 *
 * Everything exported here exists because it CANNOT be done from the client:
 * setting custom claims, writing `auditLog`, and reading an invite for someone
 * who is not signed in yet. Anything a client could safely do itself belongs in
 * `src/lib/db/*` behind firestore.rules, not here.
 *
 *   getInvite            unauthenticated · invite preview for the accept screen
 *   acceptInvite         authenticated   · bind uid → employee, issue claims
 *   setEmployeeClaims    permissions.manage · re-sync claims after a role change
 *   onEmployeeRoleChange trigger         · demotions take effect without re-login
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
