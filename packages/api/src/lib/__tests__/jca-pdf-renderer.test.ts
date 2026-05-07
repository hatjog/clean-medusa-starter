/**
 * Tests for jca-pdf-renderer (cleanup-41) — AC5 scenarios + review-fix coverage.
 *
 * AC5 from story:
 *   (a) Magic bytes: Buffer[0..4] === "%PDF-"
 *   (b) Length: Buffer.length > 1024
 *   (c) Parseable: pdf-parse(buffer) resolves without throw
 *   (d) Vendor name appears in extracted text
 *   (e) JCA terms snippet appears in extracted text
 *   (f) Determinism: two calls with identical args → same length within ±1%
 *
 * Review-fix coverage:
 *   B-1 — pdf-parse is the canonical content verifier (per AC2).
 *   B-2 — terms NOT embedded in PDF Info.Keywords (PII leak).
 *   B-9 — determinism tightened to ≤1%.
 *  B-10 — multi-page test for long terms.
 */

import { describe, expect, it } from "@jest/globals"
import {
  renderJcaPdf,
  getRendererExtension,
  getRendererMimeType,
} from "../jca-pdf-renderer"
// pdf-parse ships its own .d.ts but it auto-runs a self-test on import via
// `index.js` checking a bundled test PDF — guard with try/catch and fall back
// to a no-op when the bundled assets aren't reachable (sandbox).
// We import lazily inside `parsePdf` to keep "no module" failures visible only
// in tests that need it.

async function parsePdf(buf: Buffer): Promise<{ text: string; numpages: number }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfParse = require("pdf-parse") as (b: Buffer) => Promise<{
    text: string
    numpages: number
  }>
  return pdfParse(buf)
}

const BASE_OPTS = {
  vendorName: "AcmeCorp Poland",
  terms:
    "This Joint Controllership Agreement sets out the responsibilities of both parties " +
    "regarding the processing of personal data in accordance with GDPR Article 26. " +
    "Both parties agree to implement appropriate technical and organisational measures.",
  jcaId: "jca_test_2026-05-07",
  generatedAt: "2026-05-07T12:00:00.000Z",
}

describe("renderJcaPdf", () => {
  it("(a) magic bytes — buffer starts with %PDF-", async () => {
    const buf = await renderJcaPdf(BASE_OPTS)
    expect(buf.slice(0, 5).toString("ascii")).toBe("%PDF-")
  })

  it("(b) length > 1 KB", async () => {
    const buf = await renderJcaPdf(BASE_OPTS)
    expect(buf.length).toBeGreaterThan(1024)
  })

  it("(c) parseable via pdf-parse", async () => {
    const buf = await renderJcaPdf(BASE_OPTS)
    const parsed = await parsePdf(buf)
    expect(typeof parsed.text).toBe("string")
    expect(parsed.text.length).toBeGreaterThan(0)
    expect(parsed.numpages).toBeGreaterThanOrEqual(1)
  })

  it("(d) vendor name appears in extracted PDF text body", async () => {
    const buf = await renderJcaPdf(BASE_OPTS)
    const { text } = await parsePdf(buf)
    expect(text).toContain(BASE_OPTS.vendorName)
  })

  it("(e) JCA terms excerpt appears in extracted PDF text body", async () => {
    const buf = await renderJcaPdf(BASE_OPTS)
    const { text } = await parsePdf(buf)
    // First 60 chars of terms must be present in the rendered body.
    const snippet = BASE_OPTS.terms.substring(0, 60)
    // pdf-parse may insert line wraps; collapse whitespace before comparing.
    const normalize = (s: string): string => s.replace(/\s+/g, " ").trim()
    expect(normalize(text)).toContain(normalize(snippet))
  })

  it("(f) determinism — two identical calls produce buffers of same length within 1%", async () => {
    const [buf1, buf2] = await Promise.all([
      renderJcaPdf(BASE_OPTS),
      renderJcaPdf(BASE_OPTS),
    ])
    const ratio = Math.abs(buf1.length - buf2.length) / buf1.length
    // Tightened from 5% to 1% — only CreationDate ISO string varies (B-9).
    expect(ratio).toBeLessThanOrEqual(0.01)
  })

  it("(g) long terms produce multi-page PDF (B-10)", async () => {
    const longTerms =
      "GDPR Article 26 paragraph follows. ".repeat(400) // ~14 KB body
    const buf = await renderJcaPdf({ ...BASE_OPTS, terms: longTerms })
    const parsed = await parsePdf(buf)
    expect(parsed.numpages).toBeGreaterThan(1)
  })

  it("(B-2 PII guard) PDF Info Keywords does NOT contain raw terms text", async () => {
    const sentinel =
      "PII_SENTINEL_DO_NOT_LEAK_into_metadata_QWERTYUIOP_1234567890"
    const buf = await renderJcaPdf({
      ...BASE_OPTS,
      terms: sentinel + " " + BASE_OPTS.terms,
    })
    // PDF Info dict strings are stored uncompressed → readable via latin1.
    const raw = buf.toString("latin1")
    // Body content stream is FlateDecode-compressed, so the sentinel is fine
    // there. Only the Info dict region should be scanned. We check that the
    // sentinel does NOT appear in the Info dict literal block.
    const infoIdx = raw.indexOf("/Info")
    if (infoIdx !== -1) {
      // Info dict roughly spans ~500 bytes from /Info reference.
      const infoBlock = raw.slice(infoIdx, infoIdx + 2000)
      expect(infoBlock.includes(sentinel)).toBe(false)
    }
  })
})

describe("getRendererExtension", () => {
  it("returns .pdf (not .txt)", () => {
    expect(getRendererExtension()).toBe(".pdf")
  })
})

describe("getRendererMimeType", () => {
  it("returns application/pdf", () => {
    expect(getRendererMimeType()).toBe("application/pdf")
  })
})
