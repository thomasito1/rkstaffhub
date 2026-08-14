/**
 * Outbound webhook STUB for Leah/ZenZap (spec §7, §20): "write a webhook stub
 * `notifyZenZap(payload)` Cloud Function that Tom can later wire to
 * Leah/ZenZap — build the stub, log payloads, don't integrate now."
 *
 * This function makes NO outbound call and touches NO other Firestore
 * project — CLAUDE.md: "this app must NEVER touch the existing Leah/ERP
 * Firestore project." It only logs the payload it WOULD send, via Cloud
 * Logging (`logger.info`), so Tom can inspect real payload shapes in
 * production before wiring the real integration.
 *
 * ZenZapPayload IS the integration contract. Every field below is what a real
 * webhook call needs — do not shrink this shape without checking with Tom.
 * Currently only called from the pool-drop notification path
 * (tradeTriggers.ts) per spec §7's exact wording; `eventType` is typed as the
 * full `PushCategory` union so the same stub can be reused for other events
 * later without changing this contract.
 */

import { logger } from 'firebase-functions'
import type { Department, PushCategory } from './model'

export interface ZenZapShiftSummary {
  weekId: string
  shiftId: string
  date: string
  startTime: string
  endTime: string
  roleId: string
  department: Department
}

export interface ZenZapPayload {
  eventType: PushCategory
  employeeIds: string[]
  shift: ZenZapShiftSummary
  /** App-relative path the notification should open to, e.g. "/shift-pool". */
  deepLink: string
  /** ISO 8601, server-side wall clock at the moment the event fired. */
  occurredAt: string
}

export async function notifyZenZap(payload: ZenZapPayload): Promise<void> {
  logger.info('notifyZenZap (stub — no outbound call made; see zenzap.ts header)', { payload })
}
