/**
 * FCM push send — spec §7 ("every eligible employee gets a push
 * notification"), retrofitted onto schedule publish/republish per Rafa's
 * ruling (Aug 14, 2026) now that this path exists.
 *
 * Notification strings live in `src/locales/{en,es}.json`'s `push` section —
 * the SAME two files `npm run i18n:check` already diffs for parity, reached
 * here via the directory symlink `functions/src/locales -> ../../src/locales`
 * (the same trick as `tradeEligibility.ts`; a namespace import
 * (`import * as en from './locales/en.json'`) avoids needing
 * `esModuleInterop`, which this package's tsconfig doesn't set). Interpolation
 * is a small `{{var}}` replace, not full i18next — Functions has no
 * react-i18next runtime.
 *
 * NEVER THROWS, matching `writeAudit`'s contract: a push failure must not
 * roll back the mutation it's about. `sendPush` reports which employeeIds it
 * could not reach; callers pass that to `markPushPending()` so a failure is
 * durably surfaced (the Schedule/Trade `pushPending` fields), never silently
 * dropped.
 */

import { FieldValue, type DocumentReference } from 'firebase-admin/firestore'
import { getMessaging } from 'firebase-admin/messaging'
import { logger } from 'firebase-functions'

import * as en from './locales/en.json'
import * as es from './locales/es.json'
import { COLLECTIONS, db } from './firebase'
import type { EmployeeDoc, PushCategory } from './model'

type PushLocale = typeof en
const LOCALES: Record<'en' | 'es', PushLocale> = { en, es }

function messageFor(locale: PushLocale, category: PushCategory): { title: string; body: string } {
  switch (category) {
    case 'trade.pool-drop':
      return locale.push.trade.poolDrop
    case 'trade.claimed':
      return locale.push.trade.claimed
    case 'trade.approved':
      return locale.push.trade.approved
    case 'schedule.published':
      return locale.push.schedule.published
    case 'schedule.republished':
      return locale.push.schedule.republished
    case 'punch.forgotten':
      return locale.push.punch.forgotten
  }
}

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match,
  )
}

/** A param that must itself be resolved per-recipient (e.g. a bilingual role name). */
export type BilingualParam = { en: string; es: string }
export type PushParamValue = string | number | BilingualParam

function isBilingualParam(value: PushParamValue): value is BilingualParam {
  return typeof value === 'object' && value !== null
}

function resolveParams(
  params: Record<string, PushParamValue>,
  lang: 'en' | 'es',
): Record<string, string | number> {
  const out: Record<string, string | number> = {}
  for (const [key, value] of Object.entries(params)) {
    out[key] = isBilingualParam(value) ? value[lang] : value
  }
  return out
}

export interface SendPushInput {
  employeeIds: string[]
  category: PushCategory
  /**
   * Interpolation values for the locale template (src/locales/*.json's `push`
   * section). A person's name isn't translated — pass a plain string. A role
   * name IS (ShiftRole.name/nameEs) — pass `{ en, es }` and it resolves per
   * recipient. Dates/times are deliberately NOT per-language here (a fixed,
   * numerals-first format reads fine bilingually) — see callers.
   */
  params?: Record<string, PushParamValue>
}

export interface SendPushResult {
  /** Reached at least one of the employee's registered devices. */
  sent: string[]
  /** No token on file, or every token for that employee failed to send. */
  failed: string[]
}

/**
 * Sends to every registered token for each employee, resolving language and
 * message text per-recipient. A token that FCM reports as
 * `registration-token-not-registered` (uninstalled app, revoked permission)
 * is pruned from that employee's `pushTokens` — best-effort, logged on
 * failure, never thrown.
 */
export async function sendPush(input: SendPushInput): Promise<SendPushResult> {
  const { employeeIds, category, params = {} } = input
  const result: SendPushResult = { sent: [], failed: [] }
  if (employeeIds.length === 0) return result

  const messaging = getMessaging()

  await Promise.all(
    employeeIds.map(async (employeeId) => {
      const ref = db.collection(COLLECTIONS.employees).doc(employeeId)
      const snap = await ref.get()
      if (!snap.exists) {
        result.failed.push(employeeId)
        return
      }

      const employee = snap.data() as EmployeeDoc
      const tokens = employee.pushTokens ?? []
      if (tokens.length === 0) {
        result.failed.push(employeeId)
        return
      }

      const lang = employee.language === 'es' ? 'es' : 'en'
      const locale = LOCALES[lang]
      const resolved = resolveParams(params, lang)
      const { title, body } = messageFor(locale, category)
      const notification = { title: interpolate(title, resolved), body: interpolate(body, resolved) }
      const data: Record<string, string> = { category }
      for (const [key, value] of Object.entries(resolved)) data[key] = String(value)

      let anySent = false
      const deadTokens: string[] = []

      for (const t of tokens) {
        try {
          await messaging.send({ token: t.token, notification, data })
          anySent = true
        } catch (err) {
          const code = (err as { code?: string }).code
          if (code === 'messaging/registration-token-not-registered') {
            deadTokens.push(t.token)
          } else {
            logger.error('push send failed', { employeeId, category, code, err })
          }
        }
      }

      if (deadTokens.length > 0) {
        try {
          await ref.update({ pushTokens: tokens.filter((t) => !deadTokens.includes(t.token)) })
        } catch (err) {
          logger.error('failed to prune dead push tokens', { employeeId, err })
        }
      }

      if (anySent) result.sent.push(employeeId)
      else result.failed.push(employeeId)
    }),
  )

  return result
}

/**
 * Best-effort follow-up to a `sendPush()` that reported failures — same
 * shape as `markAuditPending` (audit.ts): flags the record the push was
 * ABOUT, never throws, and never means the mutation itself needs undoing.
 */
export async function markPushPending(
  ref: DocumentReference,
  category: PushCategory,
  failedEmployeeIds: string[],
): Promise<void> {
  if (failedEmployeeIds.length === 0) return
  try {
    await ref.update({
      pushPending: true,
      pushPendingCategory: category,
      pushPendingEmployeeIds: failedEmployeeIds,
      pushPendingAt: FieldValue.serverTimestamp(),
    })
  } catch (err) {
    logger.error('failed to set pushPending marker after a push send failure', {
      path: ref.path,
      category,
      err,
    })
  }
}
