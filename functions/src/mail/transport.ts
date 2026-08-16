/**
 * Mail transport seam — Phase 4 (spec §12): "emails a copy to the employee,"
 * gated behind an interface so a real provider (SendGrid, Nodemailer+SMTP,
 * etc.) can be swapped in at deploy time without touching the
 * signature/PDF pipeline that calls it. See `./index.ts` for which
 * implementation is active.
 */

export interface MailAttachment {
  filename: string
  content: Buffer
  contentType: string
}

export interface MailMessage {
  to: string
  subject: string
  body: string
  attachments?: MailAttachment[]
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>
}
