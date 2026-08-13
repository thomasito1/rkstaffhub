import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { doc, onSnapshot } from 'firebase/firestore'

import { auth, db } from '@/lib/firebase'
import { setLanguage, type Language } from '@/i18n'
import { ROLE_DEFAULTS } from '@/lib/permissions/defaults'
import {
  hasPermission,
  canAccessSensitive,
  type Actor,
  type SensitiveTarget,
} from '@/lib/permissions'
import type {
  Employee,
  PermissionKey,
  RoleDefaults,
} from '@/types/models'

/**
 * Session + effective-permission context.
 *
 * Holds three things that must move together:
 *   1. the Firebase user (authentication)
 *   2. their employee record (identity in this product)
 *   3. the live permissions/roleDefaults doc (authorization inputs)
 *
 * roleDefaults is a live subscription, not a one-shot read: an owner editing
 * the matrix in Settings must take effect for everyone without a reload.
 *
 * SECURITY: everything here decides what to SHOW. Enforcement lives in
 * firestore.rules and Cloud Functions (CLAUDE.md).
 */

export type AuthStatus = 'loading' | 'signed-out' | 'no-employee' | 'ready'

interface AuthContextValue {
  status: AuthStatus
  user: User | null
  employee: Employee | null
  /** Permission overrides for the signed-in employee, from private/admin. */
  overrides: Partial<Record<PermissionKey, boolean>>
  roleDefaults: RoleDefaults
  /** Effective-permission check for the signed-in employee. */
  can: (key: PermissionKey) => boolean
  /** Below-level rule against a specific person. */
  canAccess: (target: SensitiveTarget | null | undefined) => boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [overrides, setOverrides] = useState<Partial<Record<PermissionKey, boolean>>>({})
  const [roleDefaults, setRoleDefaults] = useState<RoleDefaults>(ROLE_DEFAULTS)
  const [authResolved, setAuthResolved] = useState(false)
  const [employeeResolved, setEmployeeResolved] = useState(false)

  // 1. Firebase auth state.
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      setUser(u)
      setAuthResolved(true)
      if (!u) {
        setEmployee(null)
        setOverrides({})
        setEmployeeResolved(true)
      } else {
        setEmployeeResolved(false)
      }
    })
  }, [])

  // 2. The employee record, resolved from the employeeId custom claim.
  //    The claim is set by a Cloud Function on invite acceptance and role
  //    change (spec §2), so it is authoritative and avoids a lookup query.
  useEffect(() => {
    if (!user) return

    let cancelled = false
    let unsubEmployee: (() => void) | undefined
    let unsubAdmin: (() => void) | undefined

    void (async () => {
      // force refresh so a just-issued claim is visible immediately
      const token = await user.getIdTokenResult(true)
      const employeeId = token.claims.employeeId as string | undefined

      if (cancelled) return

      if (!employeeId) {
        // Authenticated but not yet bound to an employee — invite not accepted.
        setEmployee(null)
        setEmployeeResolved(true)
        return
      }

      unsubEmployee = onSnapshot(
        doc(db, 'employees', employeeId),
        (snap) => {
          setEmployee(snap.exists() ? ({ id: snap.id, ...snap.data() } as Employee) : null)
          setEmployeeResolved(true)
        },
        () => setEmployeeResolved(true),
      )

      // Own overrides are always readable (isSelf in firestore.rules).
      unsubAdmin = onSnapshot(
        doc(db, 'employees', employeeId, 'private', 'admin'),
        (snap) => {
          const data = snap.data() as
            | { permissionOverrides?: Partial<Record<PermissionKey, boolean>> }
            | undefined
          setOverrides(data?.permissionOverrides ?? {})
        },
        () => setOverrides({}),
      )
    })()

    return () => {
      cancelled = true
      unsubEmployee?.()
      unsubAdmin?.()
    }
  }, [user])

  // 3. Live role defaults — an edit in Settings applies without a reload.
  useEffect(() => {
    if (!user) return
    return onSnapshot(
      doc(db, 'permissions', 'roleDefaults'),
      (snap) => {
        const data = snap.data() as { defaults?: RoleDefaults } | undefined
        if (data?.defaults) setRoleDefaults(data.defaults)
      },
      // Fall back to seed defaults; the UI degrades to fewer affordances,
      // never to more, because rules still enforce the real answer.
      () => setRoleDefaults(ROLE_DEFAULTS),
    )
  }, [user])

  // 4. Apply the employee's language preference (spec §14).
  useEffect(() => {
    if (employee?.language) setLanguage(employee.language as Language)
  }, [employee?.language])

  const value = useMemo<AuthContextValue>(() => {
    const actor: Actor | null = employee
      ? {
          id: employee.id,
          accessRole: employee.accessRole,
          department: employee.department,
          permissionOverrides: overrides,
        }
      : null

    const status: AuthStatus = !authResolved || !employeeResolved
      ? 'loading'
      : !user
        ? 'signed-out'
        : !employee
          ? 'no-employee'
          : 'ready'

    return {
      status,
      user,
      employee,
      overrides,
      roleDefaults,
      can: (key) => hasPermission(actor, key, roleDefaults),
      canAccess: (target) => canAccessSensitive(actor, target),
      signOut: async () => {
        const { signOut: fbSignOut } = await import('firebase/auth')
        await fbSignOut(auth)
      },
    }
  }, [user, employee, overrides, roleDefaults, authResolved, employeeResolved])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside an AuthProvider')
  return ctx
}

/** Convenience hook for a single permission check. */
export function useCan(key: PermissionKey): boolean {
  return useAuth().can(key)
}
