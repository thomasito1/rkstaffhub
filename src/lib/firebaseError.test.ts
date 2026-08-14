import { describe, it, expect } from 'vitest'
import { isFirebaseError, firebaseErrorCode } from './firebaseError'

describe('isFirebaseError — the fix for the schedule-override rejection bug', () => {
  it('matches a bare Firestore-shaped code', () => {
    expect(isFirebaseError({ code: 'permission-denied' }, 'permission-denied')).toBe(true)
  })

  it('matches a Functions-wrapped code by its tail', () => {
    expect(isFirebaseError({ code: 'functions/failed-precondition' }, 'failed-precondition')).toBe(
      true,
    )
  })

  it('matches an Auth-prefixed code by its tail', () => {
    expect(isFirebaseError({ code: 'auth/user-not-found' }, 'user-not-found')).toBe(true)
  })

  it('matches a Storage-prefixed code by its tail', () => {
    expect(isFirebaseError({ code: 'storage/unauthorized' }, 'unauthorized')).toBe(true)
  })

  it('is exactly the bug a bare === comparison had: this proves the fix', () => {
    const rejection = { code: 'functions/failed-precondition' }
    // The bug: this is what a bare comparison did, and it never matched.
    expect(rejection.code === 'failed-precondition').toBe(false)
    // The fix: this matches.
    expect(isFirebaseError(rejection, 'failed-precondition')).toBe(true)
  })

  it('does not match an unrelated code', () => {
    expect(isFirebaseError({ code: 'functions/aborted' }, 'failed-precondition')).toBe(false)
  })

  it('does not false-positive on a code that merely ends with similar characters', () => {
    // 'not-failed-precondition' ends with 'failed-precondition' as a raw
    // substring but NOT preceded by '/' — must not match.
    expect(isFirebaseError({ code: 'not-failed-precondition' }, 'failed-precondition')).toBe(
      false,
    )
  })

  it('returns false for a non-Firebase-shaped value', () => {
    expect(isFirebaseError(null, 'permission-denied')).toBe(false)
    expect(isFirebaseError(undefined, 'permission-denied')).toBe(false)
    expect(isFirebaseError('just a string', 'permission-denied')).toBe(false)
    expect(isFirebaseError({}, 'permission-denied')).toBe(false)
    expect(isFirebaseError({ code: 42 }, 'permission-denied')).toBe(false)
  })

  it('extracts the raw code via firebaseErrorCode', () => {
    expect(firebaseErrorCode({ code: 'functions/aborted' })).toBe('functions/aborted')
    expect(firebaseErrorCode(null)).toBeNull()
    expect(firebaseErrorCode({ notCode: 'x' })).toBeNull()
  })
})
