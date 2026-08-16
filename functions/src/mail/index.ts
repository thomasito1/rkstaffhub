import { LoggedStubMailTransport } from './loggedStubTransport'
import type { MailTransport } from './transport'

export type { MailAttachment, MailMessage, MailTransport } from './transport'

let transport: MailTransport | null = null

/** The active mail transport — the stub today; swap the implementation constructed here for a real one at deploy time. */
export function getMailTransport(): MailTransport {
  if (!transport) transport = new LoggedStubMailTransport()
  return transport
}
