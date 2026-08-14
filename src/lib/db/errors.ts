/**
 * Shared error handling for the data-access layer.
 *
 * THE RULE (CLAUDE.md, and the note at the top of db/employees): a
 * `permission-denied` from Firestore is a CORRECT outcome — the rules are doing
 * their job and the caller may legitimately not be allowed to see the document.
 * Those reads return `null`. EVERY OTHER ERROR RETHROWS. A dropped connection,
 * a bad index, a malformed query must never reach the UI wearing the "you don't
 * have access" costume, because the user would go ask a manager for a
 * permission they already have while the real fault goes unreported.
 */

import { isFirebaseError } from '@/lib/firebaseError'

/** True only for Firestore's `permission-denied` code. */
export function isPermissionDenied(err: unknown): boolean {
  return isFirebaseError(err, 'permission-denied')
}

/**
 * Run a read, mapping a denial to `null` and letting everything else through.
 *
 * `null` from any caller of this therefore means "absent OR not visible to
 * you" — never render it as an empty state that implies the data does not exist.
 */
export async function readOrNullIfDenied<T>(read: () => Promise<T | null>): Promise<T | null> {
  try {
    return await read()
  } catch (err) {
    if (isPermissionDenied(err)) return null
    throw err
  }
}
