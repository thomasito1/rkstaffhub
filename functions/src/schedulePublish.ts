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
 *
 * PUSH RETROFIT (Rafa's ruling, Aug 14 2026): compute-and-return was the
 * original scope; sending is now wired up (functions/src/push.ts) the same
 * way as the audit write — a THIRD best-effort step after it, never rolled
 * back into the transaction. `schedule.published`'s copy needs each
 * recipient's own shift COUNT for the week ("You work 5 shifts this week"),
 * which varies per person, so a first publish sends one call per recipient;
 * `schedule.republished`'s copy has no such per-recipient content, so a
 * republish sends as a single shared-params batch.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'

import { COLLECTIONS, db } from './firebase'
import { requirePermission } from './permissions'
import { markAuditPending, writeAudit } from './audit'
import { markPushPending, sendPush } from './push'
import type { ScheduleDoc } from './model'

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function formatMonthDay(dateStr: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'America/New_York',
  }).format(new Date(`${dateStr}T12:00:00Z`))
}

export interface RecordSchedulePublishRequest {
  weekId: string
}

export interface RecordSchedulePublishResponse {
  weekId: string
  status: 'published' | 'republished'
  /**
   * Every shift this call counted as changed: newly-drafted shifts flipped to
   * `published`, PLUS already-live shifts edited since the last publish
   * (`dirtySincePublish === true` — a time change, reassignment, or
   * cancellation). Both groups are cleared back to clean in this same
   * transaction.
   */
  publishedShiftIds: string[]
  /**
   * §6: first publish notifies everyone scheduled; a republish notifies only
   * the current occupants of shifts THIS call counted as changed —
   * "targeted notifications only to affected employees". Actually sending
   * anything (FCM) is a later phase; this Function only computes and returns
   * who WOULD be notified, same scope as the client code it replaces.
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
      // Already live but edited since — a time change, reassignment, or
      // cancellation made to a published shift. `dirtySincePublish` is the
      // signal (see Shift model + updateShift()/scheduleOverride.ts); without
      // it a republish only ever notices brand-new draft shifts and silently
      // drops reassignments to already-published ones.
      const dirtyLiveShiftIds: string[] = []
      const everyoneScheduled = new Set<string>()
      const affectedByThisCall = new Set<string>()
      // Per-recipient shift count for `schedule.published`'s "you work N
      // shifts this week" copy — counts every shift assigned to them this
      // week, not just the ones this call flipped, matching what a first
      // publish means to the person reading it.
      const shiftCountByEmployee = new Map<string, number>()

      for (const doc of shiftsSnap.docs) {
        const data = doc.data() as {
          status?: string
          employeeId?: string | null
          dirtySincePublish?: boolean
        }
        if (data.employeeId) {
          everyoneScheduled.add(data.employeeId)
          shiftCountByEmployee.set(data.employeeId, (shiftCountByEmployee.get(data.employeeId) ?? 0) + 1)
        }
        if (data.status === 'draft') {
          draftShiftIds.push(doc.id)
          if (data.employeeId) affectedByThisCall.add(data.employeeId)
        } else if (data.dirtySincePublish === true) {
          dirtyLiveShiftIds.push(doc.id)
          if (data.employeeId) affectedByThisCall.add(data.employeeId)
        }
      }

      for (const shiftId of draftShiftIds) {
        tx.update(shiftsRef.doc(shiftId), {
          status: 'published',
          dirtySincePublish: false,
          updatedAt: FieldValue.serverTimestamp(),
        })
      }

      for (const shiftId of dirtyLiveShiftIds) {
        tx.update(shiftsRef.doc(shiftId), {
          dirtySincePublish: false,
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
        publishedShiftIds: [...draftShiftIds, ...dirtyLiveShiftIds],
        notifyEmployeeIds,
        previousStatus,
        mode,
        shiftCountByEmployee,
      }
    })

    const audited = await writeAudit({
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
    if (!audited) await markAuditPending(scheduleRef, 'schedule.publish')

    if (result.notifyEmployeeIds.length > 0) {
      const weekRange = `${formatMonthDay(weekId)} – ${formatMonthDay(addDays(weekId, 6))}`
      const failedAll: string[] = []

      if (result.mode === 'publish') {
        await Promise.all(
          result.notifyEmployeeIds.map(async (employeeId) => {
            const { failed } = await sendPush({
              employeeIds: [employeeId],
              category: 'schedule.published',
              params: { weekRange, shiftCount: result.shiftCountByEmployee.get(employeeId) ?? 0 },
            })
            failedAll.push(...failed)
          }),
        )
      } else {
        const { failed } = await sendPush({
          employeeIds: result.notifyEmployeeIds,
          category: 'schedule.republished',
          params: { weekRange },
        })
        failedAll.push(...failed)
      }

      if (failedAll.length > 0) {
        await markPushPending(
          scheduleRef,
          result.mode === 'publish' ? 'schedule.published' : 'schedule.republished',
          failedAll,
        )
      }
    }

    return {
      weekId: result.weekId,
      status: result.status,
      publishedShiftIds: result.publishedShiftIds,
      notifyEmployeeIds: result.notifyEmployeeIds,
    }
  },
)
