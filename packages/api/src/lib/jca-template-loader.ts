/**
 * Story v160-7-5: JCA template loader + hydration.
 *
 * Loads PL/EN JCA markdown templates + hydrates with vendor + controller data.
 * Per T2.1 decision: templates bundled in `src/legal/` (build-time access).
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

export type JCALocale = "pl" | "en"

export interface JCAVendorData {
  name: string
  legal_address: string
  tax_id: string
}

export interface JCAControllerData {
  name: string
  legal_address: string
  tax_id: string
}

export interface JCATemplateContext {
  vendor: JCAVendorData
  controller: JCAControllerData
  generation_date: string
  signed_date_placeholder: string
  flag_flip_date: string
  jca_version: string
}

/**
 * Loads the raw markdown template for a locale.
 *
 * Template files live at `src/legal/jca-template.{locale}.md`. Resolution
 * uses `__dirname` relative path so tests + production builds find them
 * consistently.
 */
export function loadTemplate(locale: JCALocale): string {
  const path = resolve(
    __dirname,
    "..",
    "legal",
    `jca-template.${locale}.md`,
  )
  return readFileSync(path, "utf-8")
}

/**
 * Hydrates template placeholders with vendor + controller data.
 *
 * Missing fields rendered as `[BRAK]` (PL) / `[MISSING]` (EN) placeholder
 * to surface gaps for legal review (vs silent blank).
 */
export function hydrateTemplate(
  template: string,
  ctx: JCATemplateContext,
  locale: JCALocale = "pl",
): string {
  const missing = locale === "pl" ? "[BRAK]" : "[MISSING]"

  const get = (val: string | undefined): string =>
    val && val.trim().length > 0 ? val : missing

  return template
    .replace(/\{\{\s*vendor\.name\s*\}\}/g, get(ctx.vendor.name))
    .replace(/\{\{\s*vendor\.legal_address\s*\}\}/g, get(ctx.vendor.legal_address))
    .replace(/\{\{\s*vendor\.tax_id\s*\}\}/g, get(ctx.vendor.tax_id))
    .replace(/\{\{\s*controller\.name\s*\}\}/g, get(ctx.controller.name))
    .replace(
      /\{\{\s*controller\.legal_address\s*\}\}/g,
      get(ctx.controller.legal_address),
    )
    .replace(/\{\{\s*controller\.tax_id\s*\}\}/g, get(ctx.controller.tax_id))
    .replace(/\{\{\s*generation_date\s*\}\}/g, get(ctx.generation_date))
    .replace(
      /\{\{\s*signed_date_placeholder\s*\}\}/g,
      get(ctx.signed_date_placeholder),
    )
    .replace(/\{\{\s*flag_flip_date\s*\}\}/g, get(ctx.flag_flip_date))
    .replace(/\{\{\s*jca_version\s*\}\}/g, get(ctx.jca_version))
}
