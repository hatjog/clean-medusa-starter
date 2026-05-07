/**
 * Story v160-cleanup-39-magicbyte-validator (TF-93) — unit tests for
 * the magic-byte sniffer (9 cases: 3 happy + 6 negative).
 */

import { describe, it, expect } from "@jest/globals"
import { sniffMagicBytes } from "../../../src/lib/magic-byte-sniffer"

// ---------------------------------------------------------------------------
// Happy path — valid signatures
// ---------------------------------------------------------------------------

describe("sniffMagicBytes — happy paths", () => {
  it("recognises a PDF buffer (%PDF header)", () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])
    expect(sniffMagicBytes(buf)).toBe("pdf")
  })

  it("recognises a PNG buffer (8-byte signature)", () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(sniffMagicBytes(buf)).toBe("png")
  })

  it("recognises a JPEG buffer (FF D8 FF)", () => {
    // JPEG with APP0 marker
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46])
    expect(sniffMagicBytes(buf)).toBe("jpeg")
  })
})

// ---------------------------------------------------------------------------
// Negative path — unrecognised / malformed inputs
// ---------------------------------------------------------------------------

describe("sniffMagicBytes — negative paths", () => {
  it("returns null for an empty buffer", () => {
    expect(sniffMagicBytes(Buffer.alloc(0))).toBeNull()
  })

  it("returns null for a 2-byte truncated JPEG (too short)", () => {
    const buf = Buffer.from([0xff, 0xd8])
    // 2 bytes — matches 2/3 of JPEG sig but not the third byte
    // NOTE: JPEG sig is FF D8 FF; only 2 bytes means we can't confirm
    expect(sniffMagicBytes(buf)).toBeNull()
  })

  it("returns null for a near-miss PDF header (%PDg instead of %PDF)", () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x67, 0x0a, 0x0a, 0x0a, 0x0a])
    expect(sniffMagicBytes(buf)).toBeNull()
  })

  it("returns null for a ZIP file (PK\\x03\\x04 header)", () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
    expect(sniffMagicBytes(buf)).toBeNull()
  })

  it("returns null for a Windows EXE (MZ header)", () => {
    const buf = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])
    expect(sniffMagicBytes(buf)).toBeNull()
  })

  it("returns null for random noise bytes", () => {
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe, 0xba, 0xbe])
    expect(sniffMagicBytes(buf)).toBeNull()
  })
})
