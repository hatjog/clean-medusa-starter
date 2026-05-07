/**
 * Story v160-cleanup-41: POST /admin/vendors/[id]/jca/generate — generate JCA PDF.
 *
 * Updated from Story 7.5 text-Buffer stub to real pdfkit-backed PDF (TF-100/TF-101).
 * Changes:
 *   - Uses renderJcaPdf() (async, returns real PDF Buffer) instead of renderPDF()
 *   - Streams the PDF binary directly when ?download=1 (consistent .pdf UX)
 *   - JSON metadata response for programmatic callers
 *   - format field added for backwards compat tracking (AC6 Opcja B)
 *
 * Review fixes applied (post-adversarial):
 *   B-3 — JSON response no longer carries PDF Content-Type / Disposition
 *           Streaming variant available via ?download=1 with proper headers
 *   B-5/B-6 — vendor field length-validation (defense in depth, OOM guard)
 *   B-7 — pdf_path removed from JSON response (no persistence in v1.6.0)
 */

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  hydrateTemplate,
  loadTemplate,
  type JCATemplateContext,
} from "../../../../../../lib/jca-template-loader"
import {
  renderJcaPdf,
  unicodeFontsAvailable,
  isWinAnsiSafe,
} from "../../../../../../lib/jca-pdf-renderer"

type GenerateBody = {
  locale?: "pl" | "en"
  vendor?: { name?: string; legal_address?: string; tax_id?: string }
}

type GenerateResponse = {
  vendor_id: string
  bytes: number
  audit_log_id: string
  /** format flag for backwards compat (AC6 Opcja B); new = "pdf" */
  format: "pdf"
}

const MAX_VENDOR_NAME_LEN = 500
const MAX_VENDOR_ADDRESS_LEN = 1000
const MAX_VENDOR_TAX_ID_LEN = 50

export async function POST(
  req: MedusaRequest<GenerateBody>,
  res: MedusaResponse<GenerateResponse | { error: string }>,
): Promise<void> {
  const { id } = req.params as { id: string }
  const body = (req.body ?? {}) as GenerateBody

  // Defense-in-depth: reject oversized vendor fields before pdfkit is invoked.
  if (
    (body.vendor?.name && body.vendor.name.length > MAX_VENDOR_NAME_LEN) ||
    (body.vendor?.legal_address &&
      body.vendor.legal_address.length > MAX_VENDOR_ADDRESS_LEN) ||
    (body.vendor?.tax_id && body.vendor.tax_id.length > MAX_VENDOR_TAX_ID_LEN)
  ) {
    res.status(400).json({
      error:
        "vendor field too long (name<=500, legal_address<=1000, tax_id<=50)",
    })
    return
  }

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

    // Glyph-safety guard for `pl` locale when Unicode fonts not bundled.
    // Prefer 501 with a clear message over silent ?-substitution corruption.
    if (
      locale === "pl" &&
      !unicodeFontsAvailable() &&
      !isWinAnsiSafe(hydrated)
    ) {
      res.status(501).json({
        error:
          "Polish JCA requires DejaVuSans bundle (lib/fonts/) — refusing to render with WinAnsi-only fallback to avoid silent glyph corruption.",
      })
      return
    }

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

    const auditLogId = `jca_generated_${id}_${Date.now()}`

    if (process.env.NODE_ENV !== "test") {
      // eslint-disable-next-line no-console
      console.info(
        `[jca_generated] vendor_id=${id} locale=${locale} bytes=${buffer.byteLength} format=pdf`,
      )
    }

    // Streaming variant: ?download=1 returns the PDF binary directly,
    // honoring TF-101 (real .pdf download with correct Content-Type).
    const wantsDownload =
      typeof req.query?.download === "string" && req.query.download === "1"

    if (wantsDownload) {
      res.setHeader("Content-Type", "application/pdf")
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${id}.pdf"`,
      )
      res.setHeader("X-JCA-Bytes", String(buffer.byteLength))
      res.setHeader("X-JCA-Audit-Log-Id", auditLogId)
      res.status(200).end(buffer)
      return
    }

    // JSON metadata response — no misleading PDF headers (B-3).
    res.json({
      vendor_id: id,
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
