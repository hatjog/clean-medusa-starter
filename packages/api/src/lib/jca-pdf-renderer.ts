/**
 * Story v160-7-5: JCA PDF renderer.
 *
 * Per T2.3 decision DEFER acceptable: full PDF rendering (pdfkit/puppeteer)
 * NOT shipped in Wave 15 — instead we ship a stub that returns hydrated
 * markdown as plain text Buffer. Real PDF generation = Sprint 5 polish.
 *
 * Story 7.5 AC1 explicitly permits this DEFER: "ship workflow z markdown-to-
 * html-to-pdf via simple fallback (e.g. plain HTML PDF print) lub stub z .txt
 * output + DEFER w Dev Agent Record (full PDF gen w Sprint 5 polish)".
 */

/**
 * Renders the JCA "PDF" (currently: text Buffer; full PDF deferred).
 *
 * In Sprint 5 polish: replace with pdfkit (pure JS, no headless Chromium dep)
 * to produce true PDF binary. Storage abstraction + admin preview surface
 * already accept Buffer — only this function changes.
 */
export function renderPDF(hydratedMarkdown: string): Buffer {
  // DEFER stub: hydrated markdown → text Buffer.
  // Real impl: pdfkit doc.text(...).pipe(buffer).
  return Buffer.from(hydratedMarkdown, "utf-8")
}

/**
 * Returns the file extension for the rendered output.
 * Stub: ".txt"; real PDF impl: ".pdf".
 */
export function getRendererExtension(): string {
  return ".txt"
}

/**
 * Returns the MIME type for the rendered output.
 * Stub: "text/plain"; real PDF impl: "application/pdf".
 */
export function getRendererMimeType(): string {
  return "text/plain; charset=utf-8"
}
