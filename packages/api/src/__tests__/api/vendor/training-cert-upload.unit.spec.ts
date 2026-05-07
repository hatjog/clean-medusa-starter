/**
 * Story v160-cleanup-39-magicbyte-validator (TF-93 + TF-109) — route unit tests.
 *
 * 8 required test cases:
 *   1. Valid PDF buffer + valid vendor token → 200 + audit row "sent"
 *   2. Renamed .exe as .pdf (no %PDF header) → 415 magic_byte_mismatch
 *   3. PNG buffer but .pdf extension → 415 filename_extension_mismatch
 *   4. Buffer size = maxBytes + 1 → 413 size_exceeded
 *   5. Missing vendor token → 401 (no audit row)
 *   6. Invalid/expired vendor token → 401 (no audit row)
 *   7. Cross-vendor: token=vendorA, body.vendor_id=vendorB → 403 cross_vendor_scope_mismatch
 *   8. Client-supplied mimeType="application/pdf" on PNG buffer → 415 (MIME ignored)
 *
 * Plus AC1 contract tests (client mimeType never consulted for accept/reject)
 * and review-fix coverage (F1, F2, F3, F4, F7, F9).
 *
 * Review F5: cases 1-4, 7, 8 invoke the REAL `uploadHandler` (exported from
 * the route module) with a stub `vendorAuth` injected onto req. Previous
 * revision used a parallel simulator that drifted from the real guard chain.
 *
 * Review F8: `MAX_BYTES` is re-derived inside `beforeEach` after a fresh
 * `resetMaxUploadBytesForTests()` so env mutations from sibling tests in the
 * same jest worker cannot leak via the module-level cache.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals"

import { sniffMagicBytes } from "../../../../src/lib/magic-byte-sniffer"
import { validateCertBytes } from "../../../../src/lib/training-cert-validator"
import {
  getMaxUploadBytes,
  resetMaxUploadBytesForTests,
} from "../../../../src/lib/training-cert-upload-config"

// ---------------------------------------------------------------------------
// jest.mock the vendor-notification-log module so we can capture both
// throwing and best-effort audit calls without touching a real DB.
// ---------------------------------------------------------------------------

const auditLog: Array<{
  variant: "throwing" | "best_effort"
  input: Record<string, unknown>
}> = []

let bestEffortShouldFail = false
let throwingShouldFail = false

jest.mock("../../../../src/lib/vendor-notification-log", () => ({
  __esModule: true,
  appendNotificationLog: jest.fn(async (_scope: unknown, input: Record<string, unknown>) => {
    if (throwingShouldFail) {
      throw new Error("simulated_db_failure")
    }
    auditLog.push({ variant: "throwing", input })
    return { id: input["id"] ?? "audit-row", ...input }
  }),
  appendNotificationLogBestEffort: jest.fn(
    async (_scope: unknown, input: Record<string, unknown>) => {
      if (bestEffortShouldFail) {
        // best-effort variant catches its own errors and returns persisted=false
        return {
          entry: { id: input["id"] ?? "audit-row", ...input },
          persisted: false,
          error: "simulated_db_failure",
        }
      }
      auditLog.push({ variant: "best_effort", input })
      return { entry: { id: input["id"] ?? "audit-row", ...input }, persisted: true }
    },
  ),
}))

// Imported AFTER jest.mock so the mock is in place when the module under
// test resolves its own imports.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { uploadHandler } = require("../../../../src/api/vendor/training-cert/upload/route") as {
  uploadHandler: (
    req: any,
    res: any,
    next: any,
  ) => Promise<void>
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PDF_BUF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
const PNG_BUF = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const EXE_BUF = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])

let MAX_BYTES = 0

function buildResMock(): {
  res: any
  status: () => number | undefined
  body: () => Record<string, unknown> | undefined
} {
  let statusCode: number | undefined
  let bodyOut: Record<string, unknown> | undefined
  const res = {
    status(code: number) {
      statusCode = code
      return res
    },
    json(payload: Record<string, unknown>) {
      bodyOut = payload
      return res
    },
  }
  return {
    res,
    status: () => statusCode,
    body: () => bodyOut,
  }
}

function buildReq(opts: {
  buffer?: Buffer | null
  filename?: string | null
  clientMimeType?: string | null
  vendorAuth?: { vendor_id: string; seller_id: string } | null
  bodyVendorId?: string
  queryVendorId?: string
}): any {
  // Default: simulate the multipart fast-path via req.file.
  const req: any = {
    headers: {},
    body: {},
    query: {},
    scope: { resolve: () => undefined },
  }
  if (opts.buffer && opts.filename !== undefined) {
    req.file = {
      buffer: opts.buffer,
      originalname: opts.filename ?? "upload.bin",
      mimetype: opts.clientMimeType ?? "application/octet-stream",
      size: opts.buffer.byteLength,
    }
  } else if (opts.buffer) {
    req.file = {
      buffer: opts.buffer,
      originalname: "upload.bin",
      mimetype: opts.clientMimeType ?? "application/octet-stream",
      size: opts.buffer.byteLength,
    }
  }
  if (opts.bodyVendorId !== undefined) {
    req.body.vendor_id = opts.bodyVendorId
  }
  if (opts.queryVendorId !== undefined) {
    req.query.vendor_id = opts.queryVendorId
  }
  if (opts.vendorAuth !== null) {
    req.vendorAuth = opts.vendorAuth ?? { vendor_id: "vendor_A", seller_id: "seller_A" }
  }
  return req
}

// ---------------------------------------------------------------------------
// Test matrix
// ---------------------------------------------------------------------------

describe("training-cert upload route — real uploadHandler (review F5)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    auditLog.length = 0
    bestEffortShouldFail = false
    throwingShouldFail = false
    resetMaxUploadBytesForTests()
    delete process.env.GP_TRAINING_CERT_MAX_BYTES
    MAX_BYTES = getMaxUploadBytes()
  })

  // Case 1
  it("case-1: valid PDF buffer + valid vendor token → 200 + audit row sent", async () => {
    const req = buildReq({ buffer: PDF_BUF, filename: "training.pdf" })
    const { res, status, body } = buildResMock()

    await uploadHandler(req, res, () => {})

    expect(status()).toBeUndefined() // res.json was called without status() — express default 200
    expect(body()?.["status"]).toBe("pending_review")
    expect(body()?.["vendor_id"]).toBe("vendor_A")
    expect(body()?.["audit_log_id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    ) // F2: UUID
    expect(body()?.["file_path"]).toMatch(/^vendor-training-certs\/vendor_A\/\d+\.pdf$/)
    expect(auditLog).toHaveLength(1)
    expect(auditLog[0].variant).toBe("throwing") // F1: success uses throwing variant
    expect(auditLog[0].input["status"]).toBe("sent")
    expect(auditLog[0].input["error_message"]).toBeNull()
  })

  // Case 2
  it("case-2: renamed .exe as .pdf → 415 magic_byte_mismatch + audit row rejected", async () => {
    const req = buildReq({ buffer: EXE_BUF, filename: "payload.pdf" })
    const { res, status, body } = buildResMock()

    await uploadHandler(req, res, () => {})

    expect(status()).toBe(415)
    expect(body()?.["code"]).toBe("magic_byte_mismatch")
    expect(auditLog).toHaveLength(1)
    expect(auditLog[0].variant).toBe("best_effort") // reject path stays best-effort
    expect(auditLog[0].input["status"]).toBe("rejected")
    expect(auditLog[0].input["error_message"]).toBe("magic_byte_mismatch")
    // F3: real sizeBytes captured
    const meta = auditLog[0].input["metadata"] as Record<string, unknown>
    expect(meta["size_bytes"]).toBe(EXE_BUF.byteLength)
  })

  // Case 3
  it("case-3: PNG buffer with .pdf extension → 415 filename_extension_mismatch", async () => {
    const req = buildReq({ buffer: PNG_BUF, filename: "sneaky.pdf" })
    const { res, status, body } = buildResMock()

    await uploadHandler(req, res, () => {})

    expect(status()).toBe(415)
    expect(body()?.["code"]).toBe("filename_extension_mismatch")
    expect(auditLog).toHaveLength(1)
    expect(auditLog[0].input["status"]).toBe("rejected")
    expect(auditLog[0].input["error_message"]).toBe("filename_extension_mismatch")
  })

  // Case 4
  it("case-4: oversize buffer (maxBytes + 1) → 413 size_exceeded", async () => {
    const oversize = Buffer.alloc(MAX_BYTES + 1)
    oversize[0] = 0x25; oversize[1] = 0x50; oversize[2] = 0x44; oversize[3] = 0x46
    const req = buildReq({ buffer: oversize, filename: "toobig.pdf" })
    const { res, status, body } = buildResMock()

    await uploadHandler(req, res, () => {})

    expect(status()).toBe(413)
    expect(body()?.["code"]).toBe("size_exceeded")
    expect(auditLog).toHaveLength(1)
    expect(auditLog[0].input["status"]).toBe("rejected")
  })

  // Case 5 — real withVendorAuth gate (no x-vendor-token header)
  it("case-5: missing vendor token → 401, no audit row written (real withVendorAuth)", async () => {
    const { withVendorAuth } = await import("../../../../src/lib/vendor-auth")

    const innerCalled = jest.fn()
    const wrapped = withVendorAuth(async (_req, _res, _next) => {
      innerCalled()
    })

    const { res, status } = buildResMock()
    const req = { headers: {}, scope: { resolve: () => undefined } } as any
    await wrapped(req, res, () => {})

    expect(status()).toBe(401)
    expect(innerCalled).not.toHaveBeenCalled()
    expect(auditLog).toHaveLength(0)
  })

  // Case 6 — invalid/empty token still gated by withVendorAuth
  it("case-6: invalid/empty vendor token → 401, no audit row written", async () => {
    const { withVendorAuth } = await import("../../../../src/lib/vendor-auth")

    const innerCalled = jest.fn()
    const wrapped = withVendorAuth(async (_req, _res, _next) => {
      innerCalled()
    })

    const { res, status } = buildResMock()
    const req = {
      headers: { "x-vendor-token": "" },
      scope: { resolve: () => undefined },
    } as any
    await wrapped(req, res, () => {})

    expect(status()).toBe(401)
    expect(innerCalled).not.toHaveBeenCalled()
    expect(auditLog).toHaveLength(0)
  })

  // Case 7 — body cross-vendor mismatch
  it("case-7: cross-vendor body mismatch → 403 cross_vendor_scope_mismatch + sizeBytes preserved (F3)", async () => {
    const req = buildReq({
      buffer: PDF_BUF,
      filename: "cert.pdf",
      bodyVendorId: "vendor_B",
    })
    const { res, status, body } = buildResMock()

    await uploadHandler(req, res, () => {})

    expect(status()).toBe(403)
    expect(body()?.["code"]).toBe("cross_vendor_scope_mismatch")
    expect(auditLog).toHaveLength(1)
    expect(auditLog[0].input["vendor_id"]).toBe("vendor_A") // logged under authenticated id
    // F3: cross-vendor reject must carry real sizeBytes (not the legacy 0)
    const meta = auditLog[0].input["metadata"] as Record<string, unknown>
    expect(meta["size_bytes"]).toBe(PDF_BUF.byteLength)
  })

  // Case 8 — client mimeType ignored
  it("case-8: client mimeType=application/pdf on PNG buffer → 415 (MIME ignored, sniff wins)", async () => {
    const req = buildReq({
      buffer: PNG_BUF,
      filename: "cert.pdf",
      clientMimeType: "application/pdf",
    })
    const { res, status, body } = buildResMock()

    await uploadHandler(req, res, () => {})

    expect(status()).toBe(415)
    expect(["magic_byte_mismatch", "filename_extension_mismatch"]).toContain(
      body()?.["code"],
    )
    expect(auditLog).toHaveLength(1)
    expect(auditLog[0].input["status"]).toBe("rejected")
  })
})

// ---------------------------------------------------------------------------
// Review-fix specific coverage
// ---------------------------------------------------------------------------

describe("review fixes — F1/F2/F3/F4/F7/F9 coverage", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    auditLog.length = 0
    bestEffortShouldFail = false
    throwingShouldFail = false
    resetMaxUploadBytesForTests()
    delete process.env.GP_TRAINING_CERT_MAX_BYTES
    MAX_BYTES = getMaxUploadBytes()
  })

  it("F1: success path returns 500 audit_persistence_failed when DB write throws", async () => {
    throwingShouldFail = true
    const req = buildReq({ buffer: PDF_BUF, filename: "training.pdf" })
    const { res, status, body } = buildResMock()

    await uploadHandler(req, res, () => {})

    expect(status()).toBe(500)
    expect(body()?.["code"]).toBe("audit_persistence_failed")
    // No audit row recorded (throwing variant rejected before push)
    expect(auditLog).toHaveLength(0)
  })

  it("F2: two rapid uploads in same millisecond produce distinct audit_log_ids", async () => {
    const ids = new Set<string>()
    for (let i = 0; i < 5; i++) {
      auditLog.length = 0
      const req = buildReq({ buffer: PDF_BUF, filename: "training.pdf" })
      const { res, body } = buildResMock()
      await uploadHandler(req, res, () => {})
      ids.add(body()?.["audit_log_id"] as string)
    }
    expect(ids.size).toBe(5)
  })

  it("F4: cross-vendor via query.vendor_id is also rejected with 403", async () => {
    const req = buildReq({
      buffer: PDF_BUF,
      filename: "cert.pdf",
      queryVendorId: "vendor_attacker",
    })
    const { res, status, body } = buildResMock()

    await uploadHandler(req, res, () => {})

    expect(status()).toBe(403)
    expect(body()?.["code"]).toBe("cross_vendor_scope_mismatch")
  })

  it("F7: success path preserves caller's .jpeg extension (not coerced to .jpg)", async () => {
    const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
    const req = buildReq({ buffer: jpegBuf, filename: "diploma.jpeg" })
    const { res, body } = buildResMock()

    await uploadHandler(req, res, () => {})

    expect(body()?.["status"]).toBe("pending_review")
    expect(body()?.["file_path"]).toMatch(/\.jpeg$/)
  })

  it("F7: .jpg extension is preserved on .jpg uploads", async () => {
    const jpegBuf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
    const req = buildReq({ buffer: jpegBuf, filename: "diploma.jpg" })
    const { res, body } = buildResMock()

    await uploadHandler(req, res, () => {})

    expect(body()?.["file_path"]).toMatch(/\.jpg$/)
  })

  it("F9: invalid base64 fileData returns 400 invalid_base64 (no silent truncation)", async () => {
    // Build a request that goes through the base64 fallback path (no req.file).
    const req: any = {
      headers: {},
      body: {
        fileData: "@@@@not-valid-base64@@@@",
        filename: "evil.pdf",
      },
      query: {},
      scope: { resolve: () => undefined },
      vendorAuth: { vendor_id: "vendor_A", seller_id: "seller_A" },
    }
    const { res, status, body } = buildResMock()

    await uploadHandler(req, res, () => {})

    expect(status()).toBe(400)
    expect(body()?.["code"]).toBe("invalid_base64")
  })

  it("F9: well-formed base64 of a PDF still works through the fallback path", async () => {
    const req: any = {
      headers: {},
      body: {
        fileData: PDF_BUF.toString("base64"),
        filename: "cert.pdf",
      },
      query: {},
      scope: { resolve: () => undefined },
      vendorAuth: { vendor_id: "vendor_A", seller_id: "seller_A" },
    }
    const { res, body } = buildResMock()

    await uploadHandler(req, res, () => {})

    expect(body()?.["status"]).toBe("pending_review")
  })
})

// ---------------------------------------------------------------------------
// AC1 contract: client mimeType has zero effect on accept/reject
// ---------------------------------------------------------------------------

describe("AC1 contract: client mimeType is informational only", () => {
  it("validateCertBytes has no mimeType parameter — API proves client MIME is excluded", () => {
    const sniffed = sniffMagicBytes(PNG_BUF)
    expect(sniffed).toBe("png")

    const validation = validateCertBytes(
      { filename: "cert.pdf", sizeBytes: PNG_BUF.byteLength, sniffedType: sniffed },
      getMaxUploadBytes(),
    )
    expect(validation.valid).toBe(false)
    expect(validation.errorCode).toBe("filename_extension_mismatch")
  })

  it("PDF buffer with any clientMimeType is accepted when sniff+extension match", () => {
    const sniffed = sniffMagicBytes(PDF_BUF)
    expect(sniffed).toBe("pdf")

    const validation = validateCertBytes(
      { filename: "cert.pdf", sizeBytes: PDF_BUF.byteLength, sniffedType: sniffed },
      getMaxUploadBytes(),
    )
    expect(validation.valid).toBe(true)
  })
})
