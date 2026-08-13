import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

import { useAuth } from '@/lib/auth/AuthProvider'
import type { PermissionKey } from '@/types/models'

/**
 * Route guards.
 *
 * These keep people out of screens they cannot use. They are NOT a security
 * boundary — firestore.rules is (CLAUDE.md). A guard that is wrong shows an
 * empty screen; a rule that is wrong leaks data.
 */

function FullPageMessage({ title, body }: { title: string; body?: string }) {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 text-center">
      <h1 className="text-section font-semibold text-ink">{title}</h1>
      {body ? <p className="mt-2 max-w-sm text-meta text-ink-muted">{body}</p> : null}
    </div>
  )
}

/** Requires an authenticated session bound to an employee record. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth()
  const location = useLocation()
  const { t } = useTranslation()

  if (status === 'loading') {
    return <FullPageMessage title={t('app.loading')} />
  }

  if (status === 'signed-out') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }

  // Authenticated with Firebase but no employee claim — the invite was never
  // accepted, or the account was archived. Do not drop them on a blank app.
  if (status === 'no-employee') {
    return (
      <FullPageMessage
        title={t('auth.notLinkedTitle')}
        body={t('auth.notLinkedBody')}
      />
    )
  }

  return <>{children}</>
}

/** Requires a specific permission. Renders a plain refusal, never a redirect loop. */
export function RequirePermission({
  permission,
  children,
}: {
  permission: PermissionKey
  children: ReactNode
}) {
  const { can, status } = useAuth()
  const { t } = useTranslation()

  if (status === 'loading') return <FullPageMessage title={t('app.loading')} />

  if (!can(permission)) {
    return (
      <FullPageMessage
        title={t('auth.noPermissionTitle')}
        body={t('auth.noPermissionBody')}
      />
    )
  }

  return <>{children}</>
}

/**
 * Conditional rendering by permission — for buttons and menu items rather than
 * whole routes. Renders nothing when the permission is absent.
 */
export function Can({
  permission,
  children,
  fallback = null,
}: {
  permission: PermissionKey
  children: ReactNode
  fallback?: ReactNode
}) {
  const { can } = useAuth()
  return <>{can(permission) ? children : fallback}</>
}
