/**
 * Publish / republish a schedule week — spec §6 + §17, pattern-matched to
 * `scheduleOverride.ts`.
 *
 * `src/lib/db/schedules.ts`'s `publishSchedule()`/`republishSchedule()` already
 * flip the schedule and its draft shifts to `published`/`republished` directly
 * from the client — firestore.rules already permits that write for
 * `schedule.publish` holders. What those functions could NOT do is write the
 * `auditLog` entry spec §17 requires, because `auditLog` is `create: false` for
 * every client. They built the entry and returned it, unwritten, with a TODO.
 *
 * Per Rafa's ruling (Aug 13, 2026): publish must not be used against real data
 * until the audit entry lands. This Function is that landing, built the same
 * way as `recordScheduleOverride`:
 *
 *   1. INDEPENDENTLY VERIFY, don't trust the client. The client does not tell
 *      this Function whether it's a "publish" or a "republish" — that would be
 *      exactly the kind of client-asserted fact the override function refused
 *      to trust for skill conflicts. Instead the Function reads the week's
 *      CURRENT stored status itself and derives the mode from it: anything not
 *      already `published`/`republished` is a first publish; anything already
 *      live is a republish. A client claiming "publish" on an already-live week
 *      is corrected to a republish, not obeyed.
 *   2. State change and audit write are STILL TWO STEPS, not one transaction —
 *      matching scheduleOverride.ts's shape, not folding them together. A
 *      Firestore hiccup on the audit write must not roll back a publish that
 *      already succeeded; `writeAudit()` is explicitly designed to swallow its
 *      own failures for exactly that reason (see audit.ts).
 *   3. The state change itself (steps within step 1's transaction) IS atomic:
 *      every draft shift flips to live and the schedule doc flips status in
 *      one transaction, so nothing can observe a half-published week.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

import { COLLECTIONS, db } from './firebase'
import { requirePermission } from './permissions'
import { writeAudit } from './audit'
import type { ScheduleDoc } from './model'

export interface RecordSchedulePublishRequest {
  weekId: string
}

export interface RecordSchedulePublishResponse {
  weekId: string
  status: 'published' | 'republished'
  publishedShiftIds: string[]
  /**
   * §6: first publish notifies everyone scheduled; a republish notifies only
   * the owners of shifts THIS call flipped from draft — "targeted
   * notifications only to affected employees". Actually sending anything
   * (FCM) is a later phase; this Function only computes and returns who WOULD
   * be notified, same scope as the client code it replaces.
   */
  notifyEmployeeIds: string[]
}

export const recordSchedulePublish = onCall<RecordSchedulePublishRequest>(
  async (request): Promise<RecordSchedulePublishResponse> => {
    const uid = request.auth?.uid
    if (!uid) {
      throw new HttpsError('unauthenticated', 'Sign in required.')
    }

    const { weekId } = request.data
    if (!weekId) {
      throw new HttpsError('invalid-argument', 'weekId is required.')
    }

    const actor = await requirePermission(uid, 'schedule.publish')

    const scheduleRef = db.collection(COLLECTIONS.schedules).doc(weekId)
    const shiftsRef = scheduleRef.collection('shifts')

    const result = await db.runTransaction(async (tx) => {
      // All reads before any write — required by Firestore transactions, and
      // it's also what makes the mode determination independently verified
      // rather than trusted: this read happens INSIDE the same transaction
      // that performs the flip, so no concurrent publish can race it.
      const [scheduleSnap, shiftsSnap] = await Promise.all([tx.get(scheduleRef), tx.get(shiftsRef)])

      const previousStatus = (scheduleSnap.exists
        ? (scheduleSnap.data() as ScheduleDoc).status
        : 'draft') as string
      const wasLive = previousStatus === 'published' || previousStatus === 'republished'
      const mode: 'publish' | 'republish' = wasLive ? 'republish' : 'publish'
      // Explicit annotation: db.runTransaction's generic return-type inference
      // otherwise widens this to `string` when the same literal also flows
      // into tx.set()'s untyped DocumentData parameter.
      const newStatus: 'published' | 'republished' =
        mode === 'publish' ? 'published' : 'republished'

      const draftShiftIds: string[] = []
      const everyoneScheduled = new Set<string>()
      const affectedByThisCall = new Set<string>()

      for (const doc of shiftsSnap.docs) {
        const data = doc.data() as { status?: string; employeeId?: string | null }
        if (data.employeeId) everyoneScheduled.add(data.employeeId)
        if (data.status === 'draft') {
          draftShiftIds.push(doc.id)
          if (data.employeeId) affectedByThisCall.add(data.employeeId)
        }
      }

      for (const shiftId of draftShiftIds) {
        tx.update(shiftsRef.doc(shiftId), {
          status: 'published',
          updatedAt: FieldValue.serverTimestamp(),
        })
      }

      tx.set(
        scheduleRef,
        {
          weekId,
          status: newStatus,
          publishedAt: FieldValue.serverTimestamp(),
          publishedBy: actor.id,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )

      const notifyEmployeeIds = Array.from(
        mode === 'publish' ? everyoneScheduled : affectedByThisCall,
      )

      return {
        weekId,
        status: newStatus,
        publishedShiftIds: draftShiftIds,
        notifyEmployeeIds,
        previousStatus,
      }
    })

    await writeAudit({
      action: 'schedule.publish',
      actorEmployeeId: actor.id,
      actorUid: uid,
      targetType: 'schedule',
      targetId: weekId,
      reason: null,
      before: { status: result.previousStatus },
      after: {
        status: result.status,
        publishedShiftCount: result.publishedShiftIds.length,
        notifiedCount: result.notifyEmployeeIds.length,
      },
    })

    return {
      weekId: result.weekId,
      status: result.status,
      publishedShiftIds: result.publishedShiftIds,
      notifyEmployeeIds: result.notifyEmployeeIds,
    }
  },
)
