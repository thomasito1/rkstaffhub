import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button, Modal } from '@/components/ui'
import {
  requestAndRegisterPush,
  type PushRegistrationResult,
} from '@/lib/push/registerForPush'

/**
 * In-context permission prompt for FCM push (CLAUDE.md: never at login — this
 * is deliberately NOT wired into AuthProvider or App.tsx). A caller mounts it
 * and controls `open` itself, from whatever moment is actually "in context"
 * (e.g. a future Shift Pool page's first visit).
 *
 * Visuals reuse the existing Modal/Button primitives untouched — no new
 * styles invented, per CLAUDE.md's "do not restyle mockup designs" rule
 * (this screen has no mockup, so the safest move is to look exactly like
 * every other confirm-style modal already in the app).
 */
export interface PushPermissionPromptProps {
  open: boolean
  onClose: () => void
  /** Whose employees/{id}.pushTokens this registration writes to. */
  employeeId: string
  /**
   * Context-specific "why", already translated by the caller. Defaults to
   * the Shift Pool copy — the only caller this ships with today — so a
   * future context can pass its own without this component needing to know
   * about it.
   */
  reason?: string
  /** Fires after the Allow flow resolves, whatever the outcome. */
  onResult?: (result: PushRegistrationResult) => void
}

export function PushPermissionPrompt({
  open,
  onClose,
  employeeId,
  reason,
  onResult,
}: PushPermissionPromptProps) {
  const { t } = useTranslation()
  const [pending, setPending] = useState(false)

  async function handleAllow() {
    setPending(true)
    try {
      const result = await requestAndRegisterPush(employeeId)
      onResult?.(result)
    } finally {
      setPending(false)
      onClose()
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('push.prompt.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {t('push.prompt.notNow')}
          </Button>
          <Button variant="primary" onClick={() => void handleAllow()} disabled={pending}>
            {t('push.prompt.allow')}
          </Button>
        </>
      }
    >
      <p className="text-body text-ink">{reason ?? t('push.prompt.reason.shiftPool')}</p>
    </Modal>
  )
}
