/**
 * Signed-document PDF generation — spec §12: "document text + signature
 * image + name + employeeNumber + timestamp + doc version." Uses `pdfkit`
 * (pure JS, no headless browser) to keep this cheap at a Cloud Function's
 * cold start.
 *
 * SIMPLIFICATION, noted rather than hidden: `bodyText` renders as plain
 * text, not rendered Markdown — a real Markdown-to-PDF layout pass is
 * meaningfully more work for a v1 "keep it small" HR hub. The stored
 * `bodyMarkdown`/`bodyMarkdownEs` source text is unaffected; only this
 * PDF's typesetting is plain.
 */

import PDFDocument = require('pdfkit')

export interface SignedPdfInput {
  title: string
  bodyText: string
  employeeName: string
  employeeNumber: string
  signedAtIso: string
  /** Null for a disciplinary action (no version concept) or a refusal-to-sign record. */
  version: number | null
  /** Null for a refusal-to-sign record — there is no signature image to embed. */
  signatureImagePngBuffer: Buffer | null
  /** Set only when the employee's own language has no translated body and this fell back to English — noted ON the document per Rafa's ruling, never silently substituted. */
  languageFallbackNote: string | null
  /** Set only for a refusal-to-sign record. */
  refusalNote: string | null
}

export function generateSignedPdf(input: SignedPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.fontSize(18).fillColor('#000').text(input.title)
    if (input.version != null) {
      doc.fontSize(10).fillColor('#666').text(`Version ${input.version}`)
    }
    doc.moveDown()

    doc.fontSize(11).fillColor('#000').text(input.bodyText)
    doc.moveDown(2)

    doc.fontSize(10).text(`Employee: ${input.employeeName} (#${input.employeeNumber})`)
    doc.text(`Date: ${input.signedAtIso}`)

    if (input.refusalNote) {
      doc.moveDown()
      doc.fontSize(11).fillColor('#a00').text(input.refusalNote)
    }

    if (input.languageFallbackNote) {
      doc.moveDown()
      doc.fontSize(9).fillColor('#666').text(input.languageFallbackNote)
    }

    if (input.signatureImagePngBuffer) {
      doc.moveDown()
      doc.fontSize(10).fillColor('#000').text('Signature:')
      doc.image(input.signatureImagePngBuffer, { fit: [220, 90] })
    }

    doc.end()
  })
}
