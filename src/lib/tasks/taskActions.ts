/**
 * Client wrapper for `completeTaskInstance` — see
 * `functions/src/taskActions.ts` for why claiming a pool instance and marking
 * one done cannot be a plain client write (firestore.rules: taskInstances are
 * Cloud-Function-only).
 */
import { httpsCallable, type FunctionsError } from 'firebase/functions'
import { functions } from '@/lib/firebase'

export class TaskActionRejected extends Error {
  constructor(
    message: string,
    public readonly code: FunctionsError['code'],
    public readonly details: unknown,
  ) {
    super(message)
    this.name = 'TaskActionRejected'
  }
}

export interface CompleteTaskInstanceInput {
  instanceId: string
  notes?: string | null
  photoPath?: string | null
}

export interface CompleteTaskInstanceResult {
  instanceId: string
  status: 'done'
  assigneeEmployeeId: string
}

/** Claims (if unclaimed pool) + marks an instance done, atomically, server-side. */
export async function completeTaskInstance(
  input: CompleteTaskInstanceInput,
): Promise<CompleteTaskInstanceResult> {
  const call = httpsCallable<CompleteTaskInstanceInput, CompleteTaskInstanceResult>(
    functions,
    'completeTaskInstance',
  )
  try {
    const res = await call(input)
    return res.data
  } catch (err) {
    const fnErr = err as FunctionsError
    throw new TaskActionRejected(fnErr.message ?? 'Task action failed', fnErr.code, fnErr.details)
  }
}
