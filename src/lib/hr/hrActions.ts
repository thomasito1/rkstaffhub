/**
 * Client wrappers for the Phase 4 HR Cloud Functions — see
 * `functions/src/disciplinaryActions.ts`/`signatures.ts` for what each
 * independently re-verifies (below-level target, status transitions) and
 * why none of this can be a plain client write (firestore.rules denies
 * create/update/delete outright on `disciplinaryActions` and `signatures`).
 */
import { httpsCallable, type FunctionsError } from 'firebase/functions'
import { functions } from '@/lib/firebase'
import type { DisciplinaryActionType, SignatureTargetType } from '@/types/models'

export class HrActionRejected extends Error {
  constructor(
    message: string,
    public readonly code: FunctionsError['code'],
    public readonly details: unknown,
  ) {
    super(message)
    this.name = 'HrActionRejected'
  }
}

async function callHrAction<Req, Res>(name: string, input: Req): Promise<Res> {
  const call = httpsCallable<Req, Res>(functions, name)
  try {
    const res = await call(input)
    return res.data
  } catch (err) {
    const fnErr = err as FunctionsError
    throw new HrActionRejected(fnErr.message ?? 'That action failed', fnErr.code, fnErr.details)
  }
}

export interface IssueDisciplinaryActionInput {
  employeeId: string
  type: DisciplinaryActionType
  date: string
  policyRefs?: string[]
  narrative: string
}

export interface IssueDisciplinaryActionResult {
  actionId: string
}

/** discipline.issue, below-level enforced server-side — the audited §17 mutation that opens a new action in `status: 'issued'`. */
export function issueDisciplinaryAction(input: IssueDisciplinaryActionInput): Promise<IssueDisciplinaryActionResult> {
  return callHrAction('issueDisciplinaryAction', input)
}

export interface RecordRefusedToSignResult {
  actionId: string
}

/** Witnessed refusal path — same PDF/email/audit treatment as a real signature, since no Signature doc exists for a refusal. */
export function recordRefusedToSign(actionId: string, witnessEmployeeId: string): Promise<RecordRefusedToSignResult> {
  return callHrAction('recordRefusedToSign', { actionId, witnessEmployeeId })
}

export interface SubmitSignatureResult {
  signatureId: string
}

/**
 * Shared by policy signing and disciplinary-action signing. `signatureImageDataUrl`
 * must be a `data:image/png;base64,...` string from the signing canvas.
 */
export function submitSignature(
  targetType: SignatureTargetType,
  targetId: string,
  signatureImageDataUrl: string,
): Promise<SubmitSignatureResult> {
  return callHrAction('submitSignature', { targetType, targetId, signatureImageDataUrl })
}
