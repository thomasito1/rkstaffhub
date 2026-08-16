/**
 * Dev/emulator default transport — logs what WOULD have been sent instead of
 * sending anything real, and always "succeeds." This is deliberate: it lets
 * the whole signature → PDF → email pipeline be exercised end to end against
 * the emulator without a real mail account, the same spirit as
 * `functions/src/zenzap.ts`'s log-only webhook stub.
 *
 * NOT wired to a real provider. Swapping in one (SendGrid, Nodemailer+SMTP)
 * is a deploy-time change tracked in PROGRESS.md's deploy checklist alongside
 * the VAPID key — not built in this pass.
 */

import { logger } from 'firebase-functions'

import type { MailMessage, MailTransport } from './transport'

export class LoggedStubMailTransport implements MailTransport {
  async send(message: MailMessage): Promise<void> {
    logger.info('mail (stub, not actually sent): would deliver', {
      to: message.to,
      subject: message.subject,
      bodyPreview: message.body.slice(0, 200),
      attachmentCount: message.attachments?.length ?? 0,
      attachmentNames: message.attachments?.map((a) => a.filename) ?? [],
    })
  }
}
