/**
 * `submitSignature` — spec §12's signature flow, shared by BOTH policy
 * signing and disciplinary-action signing (the same "read it, draw a
 * signature, get a PDF, get emailed a copy" mechanics apply to each): the
 * client sends the drawn signature as a small PNG data URL directly in the
 * callable payload (a canvas signature is a few KB, well inside a callable's
 * payload limit — no separate Storage-upload-then-verify round trip needed,
 * unlike the punch selfie flow's larger, camera-captured JPEGs).
 *
 * Unreachable from a client write (firestore.rules: `signatures` denies
 * create/update/delete outright) — the PDF + email leg must be server-side.
 *
 * LANGUAGE (Rafa's ruling): renders in the employee's own `language` where a
 * translated body exists; falls back to English with a note ON THE DOCUMENT
 * itself, never a silent substitution.
 *
 * EMAIL gets the "audit-style guarantee": a failed send never rolls back the
 * signature that already succeeded, and never silently vanishes — it marks
 * `emailPending` on the signature doc, the same `pushPending`/`auditPending`
 * shape this codebase already uses.
 */

import { FieldValue } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/v2/https'
import { logger } from 'firebase-functions'

import { COLLECTIONS, db, storage } from './firebase'
import { resolveActor } from './permissions'
import { displayName, type DisciplinaryActionDoc, type EmployeeDoc, type PolicyDoc, type SignatureTargetType } from './model'
import { signatureImagePath, signedPdfPath, throwHrError } from './hr/helpers'
import { generateSignedPdf } from './hr/pdf'
import { getMailTransport } from './mail'

const MAX_SIGNATURE_BYTES = 500_000
const DATA_URL_RE = /^data:image\/png;base64,(.+)$/

function decodeSignaturePng(dataUrl: string): Buffer {
  const match = DATA_URL_RE.exec(dataUrl)
  if (!match || !match[1]) {
    throwHrError('invalid-argument', 'hr/invalid-signature-image', 'The signature must be a PNG data URL.')
  }
  const buffer = Buffer.from(match[1], 'base64')
  if (buffer.length === 0 || buffer.length > MAX_SIGNATURE_BYTES) {
    throwHrError('invalid-argument', 'hr/invalid-signature-image', 'The signature image is empty or too large.')
  }
  return buffer
}

export interface SubmitSignatureRequest {
  targetType: SignatureTargetType
  targetId: string
  /** "data:image/png;base64,...." from the signing canvas. */
  signatureImageDataUrl: string
}

export interface SubmitSignatureResponse {
  signatureId: string
}

export const submitSignature = onCall<SubmitSignatureRequest>(
  async (request): Promise<SubmitSignatureResponse> => {
    const uid = request.auth?.uid
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.')

    const { targetType, targetId, signatureImageDataUrl } = request.data
    if (targetType !== 'policy' && targetType !== 'disciplinaryAction') {
      throw new HttpsError('invalid-argument', 'targetType must be policy or disciplinaryAction.')
    }
    if (!targetId || !signatureImageDataUrl) {
      throw new HttpsError('invalid-argument', 'targetId and signatureImageDataUrl are required.')
    }

    const actor = await resolveActor(uid)
    const signatureBuffer = decodeSignaturePng(signatureImageDataUrl)

    let title: string
    let bodyText: string
    let version: number | null = null
    let languageFallbackNote: string | null = null

    const employeeLanguage = actor.employee.language === 'es' ? 'es' : 'en'

    if (targetType === 'policy') {
      const policySnap = await db.collection(COLLECTIONS.policies).doc(targetId).get()
      if (!policySnap.exists) throw new HttpsError('not-found', 'That policy no longer exists.')
      const policy = policySnap.data() as PolicyDoc

      const hasEs = Boolean(policy.bodyMarkdownEs && policy.titleEs)
      const useEs = employeeLanguage === 'es' && hasEs
      title = useEs ? (policy.titleEs as string) : (policy.title ?? '')
      bodyText = useEs ? (policy.bodyMarkdownEs as string) : (policy.bodyMarkdown ?? '')
      version = policy.version ?? null
      if (employeeLanguage === 'es' && !hasEs) {
        languageFallbackNote = 'Shown in English — no Spanish version of this document exists yet.'
      }
    } else {
      const actionRef = db.collection(COLLECTIONS.disciplinaryActions).doc(targetId)
      const actionSnap = await actionRef.get()
      if (!actionSnap.exists) throw new HttpsError('not-found', 'That disciplinary action no longer exists.')
      const action = actionSnap.data() as DisciplinaryActionDoc

      if (action.employeeId !== actor.id) {
        throwHrError('permission-denied', 'hr/not-own-target', 'You may only sign your own disciplinary action.')
      }
      if (action.status !== 'issued') {
        throwHrError('failed-precondition', 'hr/already-resolved', 'This action has already been resolved.')
      }

      const labels =
        employeeLanguage === 'es'
          ? { title: 'Acción disciplinaria', type: 'Tipo', date: 'Fecha', narrative: 'Descripción' }
          : { title: 'Disciplinary Action', type: 'Type', date: 'Date', narrative: 'Narrative' }
      title = labels.title
      bodyText = `${labels.type}: ${action.type}\n${labels.date}: ${action.date}\n\n${labels.narrative}:\n${action.narrative ?? ''}`
    }

    const signatureRef = db.collection(COLLECTIONS.signatures).doc()
    const signatureId = signatureRef.id
    const imagePath = signatureImagePath(actor.id, signatureId)
    const pdfPath = signedPdfPath(actor.id, signatureId)
    const signedAtIso = new Date().toISOString()

    await storage.bucket().file(imagePath).save(signatureBuffer, { contentType: 'image/png' })

    const pdfBuffer = await generateSignedPdf({
      title,
      bodyText,
      employeeName: displayName(actor.employee),
      employeeNumber: actor.employee.employeeNumber ?? actor.id,
      signedAtIso,
      version,
      signatureImagePngBuffer: signatureBuffer,
      languageFallbackNote,
      refusalNote: null,
    })
    await storage.bucket().file(pdfPath).save(pdfBuffer, { contentType: 'application/pdf' })

    await signatureRef.set({
      employeeId: actor.id,
      targetType,
      targetId,
      policyVersion: targetType === 'policy' ? version : null,
      signatureImagePath: imagePath,
      signedAt: FieldValue.serverTimestamp(),
      pdfStoragePath: pdfPath,
      emailedTo: null,
      emailedAt: null,
      language: employeeLanguage,
      createdAt: FieldValue.serverTimestamp(),
    })

    if (targetType === 'disciplinaryAction') {
      await db
        .collection(COLLECTIONS.disciplinaryActions)
        .doc(targetId)
        .update({ status: 'signed', signatureId, updatedAt: FieldValue.serverTimestamp() })
    }

    await emailSignedCopy(signatureRef.id, actor.employee, pdfBuffer, title)

    return { signatureId }
  },
)

async function emailSignedCopy(
  signatureId: string,
  employee: EmployeeDoc,
  pdfBuffer: Buffer,
  documentTitle: string,
): Promise<void> {
  const ref = db.collection(COLLECTIONS.signatures).doc(signatureId)
  if (!employee.email) {
    await ref.update({ emailPending: true, emailPendingAt: FieldValue.serverTimestamp() })
    return
  }
  try {
    await getMailTransport().send({
      to: employee.email,
      subject: `Signed copy: ${documentTitle}`,
      body: `Attached is your signed copy of "${documentTitle}."`,
      attachments: [{ filename: 'signed-document.pdf', content: pdfBuffer, contentType: 'application/pdf' }],
    })
    await ref.update({ emailedTo: employee.email, emailedAt: FieldValue.serverTimestamp() })
  } catch (err) {
    logger.error('failed to email a signed document copy', { signatureId, err })
    await ref.update({ emailPending: true, emailPendingAt: FieldValue.serverTimestamp() })
  }
}
