/**
 * Story v160-7-5: POST /admin/vendors/[id]/jca/generate — generate JCA PDF.
 *
 * Loads template + hydrates + renders + (would) persist + (would) dispatch email.
 * Real persistence/email DEFERRED (production wiring shared with Stories 7.1+).
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  hydrateTemplate,
  loadTemplate,
  type JCATemplateContext,
} from "../../../../../../lib/jca-template-loader"
import { renderPDF } from "../../../../../../lib/jca-pdf-renderer"

type GenerateBody = {
  locale?: "pl" | "en"
  vendor?: { name?: string; legal_address?: string; tax_id?: string }
}

type GenerateResponse = {
  vendor_id: string
  pdf_path: string
  bytes: number
  audit_log_id: string
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
    const buffer = renderPDF(hydrated)

    // Storage path (stub — real impl uploads to MinIO or writes to FS).
    const pdfPath = `vendor-jca-pdfs/${id}.txt` // .txt because PDF deferred
    const auditLogId = `jca_generated_${id}_${Date.now()}`

    if (process.env.NODE_ENV !== "test") {
      // eslint-disable-next-line no-console
      console.info(
        `[jca_generated] vendor_id=${id} locale=${locale} bytes=${buffer.byteLength} path=${pdfPath}`,
      )
    }

    res.json({
      vendor_id: id,
      pdf_path: pdfPath,
      bytes: buffer.byteLength,
      audit_log_id: auditLogId,
    })
  } catch (err) {
    res.status(500).json({
      error: `JCA generation failed: ${(err as Error).message}`,
    })
  }
}
