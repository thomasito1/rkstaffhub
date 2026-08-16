/**
 * Disciplinary action issuance + refusal-to-sign — spec §4/§12/§17: the MOST
 * sensitive class in this app (Rafa's ruling). `issueDisciplinaryAction` is a
 * §17 mutation via callable with the audit guarantee, matching
 * `recordScheduleOverride`'s shape (state write, then a best-effort audit
 * follow-up that never rolls back an already-committed action). Signing an
 * issued action is `submitSignature` (signatures.ts, shared with policy
 * signing); `recordRefusedToSign` is this file's own terminal path for when
 * an employee won't sign — witnessed, and given the same PDF/email/audit
 * treatment as a real signature, since the disciplinary record needs to be
 * equally durable either way.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'

import { COLLECTIONS, db, storage } from './firebase'
import { requirePermission } from './permissions'
import { markAuditPending, writeAudit } from './audit'
import { displayName, type DisciplinaryActionDoc, type DisciplinaryActionType, type EmployeeDoc } from './model'
import { requireBelowLevelTarget, signedPdfPath, throwHrError } from './hr/helpers'
import { generateSignedPdf } from './hr/pdf'
import { getMailTransport } from './mail'

function actionRef(actionId: string) {
  return db.collection(COLLECTIONS.disciplinaryActions).doc(actionId)
}

export interface IssueDisciplinaryActionRequest {
  employeeId: string
  type: DisciplinaryActionType
  date: string
  policyRefs?: string[]
  narrative: string
}

export interface IssueDisciplinaryActionResponse {
  actionId: string
}

export const issueDisciplinaryAction = onCall<IssueDisciplinaryActionRequest>(
  async (request): Promise<IssueDisciplinaryActionResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { employeeId, type, date, policyRefs, narrative } = request.data
    if (!employeeId || !type || !date || !narrative?.trim()) {
      throw new HttpsError('invalid-argument', 'employeeId, type, date, and narrative are required.')
    }

    const actor = await requirePermission(uid, 'discipline.issue')
    const target = await requireBelowLevelTarget(actor, employeeId)

    const ref = db.collection(COLLECTIONS.disciplinaryActions).doc()
    await ref.set({
      employeeId,
      type,
      date,
      issuedBy: actor.id,
      policyRefs: policyRefs ?? [],
      narrative: narrative.trim(),
      signatureId: null,
      status: 'issued',
      refusedWitnessEmployeeId: null,
      refusedAt: null,
      employeeAccessRole: target.accessRole ?? 'staff',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

    const audited = await writeAudit({
      action: 'discipline.issue',
      actorEmployeeId: actor.id,
      actorUid: uid,
      targetType: 'disciplinaryAction',
      targetId: ref.id,
      reason: 'issue',
      before: null,
      after: { type, date, employeeId },
    })
    if (!audited) await markAuditPending(ref, 'discipline.issue')

    return { actionId: ref.id }
  },
)

export interface RecordRefusedToSignRequest {
  actionId: string
  witnessEmployeeId: string
}

export interface RecordRefusedToSignResponse {
  actionId: string
}

export const recordRefusedToSign = onCall<RecordRefusedToSignRequest>(
  async (request): Promise<RecordRefusedToSignResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { actionId, witnessEmployeeId } = request.data
    if (!actionId || !witnessEmployeeId) {
      throw new HttpsError('invalid-argument', 'actionId and witnessEmployeeId are required.')
    }

    const actor = await requirePermission(uid, 'discipline.issue')

    const ref = actionRef(actionId)
    const snap = await ref.get()
    if (!snap.exists) throw new HttpsError('not-found', 'That disciplinary action no longer exists.')
    const action = snap.data() as DisciplinaryActionDoc
    if (!action.employeeId) throw new HttpsError('failed-precondition', 'This action is missing its employee.')
    await requireBelowLevelTarget(actor, action.employeeId)

    if (action.status !== 'issued') {
      throwHrError('failed-precondition', 'hr/already-resolved', 'This action has already been resolved.')
    }

    const witnessSnap = await db.collection(COLLECTIONS.employees).doc(witnessEmployeeId).get()
    if (!witnessSnap.exists) throw new HttpsError('not-found', 'That witness employee does not exist.')
    const witness = witnessSnap.data() as EmployeeDoc

    const targetSnap = await db.collection(COLLECTIONS.employees).doc(action.employeeId).get()
    const target = targetSnap.exists ? (targetSnap.data() as EmployeeDoc) : undefined

    await ref.update({
      status: 'refused-to-sign',
      refusedWitnessEmployeeId: witnessEmployeeId,
      refusedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

    const audited = await writeAudit({
      action: 'discipline.issue',
      actorEmployeeId: actor.id,
      actorUid: uid,
      targetType: 'disciplinaryAction',
      targetId: actionId,
      reason: 'refused-to-sign',
      before: { status: 'issued' },
      after: { status: 'refused-to-sign', witnessEmployeeId },
    })
    if (!audited) await markAuditPending(ref, 'discipline.issue')

    if (target) {
      await recordRefusalPdfAndEmail(actionId, action, target, displayName(witness))
    }

    return { actionId }
  },
)

/** Same PDF/email/audit-guarantee treatment a real signature gets — a refusal is just as durable a record. */
async function recordRefusalPdfAndEmail(
  actionId: string,
  action: DisciplinaryActionDoc,
  target: EmployeeDoc,
  witnessName: string,
): Promise<void> {
  const language = target.language === 'es' ? 'es' : 'en'
  const labels =
    language === 'es'
      ? { title: 'Acción disciplinaria — se negó a firmar', type: 'Tipo', date: 'Fecha', narrative: 'Descripción' }
      : { title: 'Disciplinary Action — Refused to Sign', type: 'Type', date: 'Date', narrative: 'Narrative' }
  const refusalNote =
    language === 'es'
      ? `El empleado se negó a firmar. Testigo: ${witnessName}.`
      : `Employee refused to sign. Witness: ${witnessName}.`

  const pdfBuffer = await generateSignedPdf({
    title: labels.title,
    bodyText: `${labels.type}: ${action.type ?? ''}\n${labels.date}: ${action.date ?? ''}\n\n${labels.narrative}:\n${action.narrative ?? ''}`,
    employeeName: displayName(target),
    employeeNumber: target.employeeNumber ?? action.employeeId ?? '',
    signedAtIso: new Date().toISOString(),
    version: null,
    signatureImagePngBuffer: null,
    languageFallbackNote: null,
    refusalNote,
  })

  const pdfPath = signedPdfPath(action.employeeId ?? 'unknown', actionId)
  await storage.bucket().file(pdfPath).save(pdfBuffer, { contentType: 'application/pdf' })

  const ref = actionRef(actionId)
  await ref.update({ pdfStoragePath: pdfPath })

  if (!target.email) {
    await ref.update({ emailPending: true, emailPendingAt: FieldValue.serverTimestamp() })
    return
  }
  try {
    await getMailTransport().send({
      to: target.email,
      subject: `Disciplinary record: ${labels.title}`,
      body: `Attached is a copy of your disciplinary record.`,
      attachments: [{ filename: 'disciplinary-record.pdf', content: pdfBuffer, contentType: 'application/pdf' }],
    })
    await ref.update({ emailedAt: FieldValue.serverTimestamp(), emailedTo: target.email })
  } catch (err) {
    logger.error('failed to email a refused-to-sign disciplinary record', { actionId, err })
    await ref.update({ emailPending: true, emailPendingAt: FieldValue.serverTimestamp() })
  }
}
