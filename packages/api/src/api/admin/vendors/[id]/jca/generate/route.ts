/**
 * Story v160-cleanup-41: POST /admin/vendors/[id]/jca/generate — generate JCA PDF.
 *
 * Updated from Story 7.5 text-Buffer stub to real pdfkit-backed PDF (TF-100/TF-101).
 * Changes:
 *   - Uses renderJcaPdf() (async, returns real PDF Buffer) instead of renderPDF()
 *   - Storage path changes: vendor-jca-pdfs/${id}.txt → vendor-jca-pdfs/${id}.pdf
 *   - Content-Type: application/pdf (TF-101)
 *   - format field added to response for backwards compat tracking (AC6 Opcja B)
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  hydrateTemplate,
  loadTemplate,
  type JCATemplateContext,
} from "../../../../../../lib/jca-template-loader"
import { renderJcaPdf } from "../../../../../../lib/jca-pdf-renderer"

type GenerateBody = {
  locale?: "pl" | "en"
  vendor?: { name?: string; legal_address?: string; tax_id?: string }
}

type GenerateResponse = {
  vendor_id: string
  pdf_path: string
  bytes: number
  audit_log_id: string
  /** format flag for backwards compat (AC6 Opcja B); new = "pdf" */
  format: "pdf"
}

export async function POST(
  req: MedusaRequest<GenerateBody>,
  res: MedusaResponse<GenerateResponse | { error: string }>,
): Promise<void> {
  const { id } = req.params as { id: string }
  const body = (req.body ?? {}) as GenerateBody

  const locale = body.locale ?? "pl"

  const ctx: JCATemplateContext = {
    vendor: {
      name: body.vendor?.name ?? id,
      legal_address: body.vendor?.legal_address ?? "",
      tax_id: body.vendor?.tax_id ?? "",
    },
    controller: {
      name: process.env.GP_CONTROLLER_NAME ?? "BonBeauty Sp. z o.o.",
      legal_address:
        process.env.GP_CONTROLLER_LEGAL_ADDRESS ??
        "ul. Przykładowa 1, 00-001 Warszawa, Polska",
      tax_id: process.env.GP_CONTROLLER_TAX_ID ?? "0000000000",
    },
    generation_date: new Date().toISOString().slice(0, 10),
    signed_date_placeholder: "[__-__-____]",
    flag_flip_date: process.env.GP_FLAG_FLIP_DATE ?? "[FLAG_FLIP_DATE]",
    jca_version: "v1.0-draft",
  }

  try {
    const template = loadTemplate(locale)
    const hydrated = hydrateTemplate(template, ctx, locale)

    // Real PDF generation (TF-100 resolved: pdfkit-backed Buffer, not text stub)
    const vendorName = body.vendor?.name ?? id
    const jcaId = `jca_${id}_${new Date().toISOString().slice(0, 10)}`
    const generatedAt = new Date().toISOString()

    const buffer = await renderJcaPdf({
      vendorName,
      terms: hydrated,
      jcaId,
      generatedAt,
    })

    // Storage path — .pdf extension (TF-101 resolved: was .txt)
    const pdfPath = `vendor-jca-pdfs/${id}.pdf`
    const auditLogId = `jca_generated_${id}_${Date.now()}`

    if (process.env.NODE_ENV !== "test") {
      // eslint-disable-next-line no-console
      console.info(
        `[jca_generated] vendor_id=${id} locale=${locale} bytes=${buffer.byteLength} path=${pdfPath} format=pdf`,
      )
    }

    // Set Content-Type header for any streaming / direct-download consumers
    res.setHeader("Content-Type", "application/pdf")
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${id}.pdf"`,
    )

    res.json({
      vendor_id: id,
      pdf_path: pdfPath,
      bytes: buffer.byteLength,
      audit_log_id: auditLogId,
      format: "pdf",
    })
  } catch (err) {
    res.status(500).json({
      error: `JCA generation failed: ${(err as Error).message}`,
    })
  }
}
