import { createHmac } from "node:crypto"

import {
  MAGIC_LINK_TTL_SECONDS,
  configureMagicLinkRuntime,
  generateMagicLink,
  generateMagicLinkWithClaims,
  resetMagicLinkRuntime,
  verifyMagicLink,
  type MagicLinkClaims,
} from "../../../lib/auth/magic-link"

const SECRET = "test-only-jwt-secret-32-byte-minimum-value"
const NOW = new Date("2026-05-18T08:00:00.000Z")
const PURCHASE_JTI = "00000000-0000-4000-8000-000000000001"
const RECOVER_JTI = "00000000-0000-4000-8000-000000000002"

function base64Url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
}

function signedToken(payload: unknown, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }) {
  const encodedHeader = base64Url(JSON.stringify(header))
  const encodedPayload = base64Url(JSON.stringify(payload))
  const input = `${encodedHeader}.${encodedPayload}`
  const signature = base64Url(createHmac("sha256", SECRET).update(input).digest())
  return `${input}.${signature}`
}

describe("magic link JWT infrastructure", () => {
  const oldJwtSecret = process.env.JWT_SECRET
  const oldNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    process.env.NODE_ENV = "test"
    process.env.JWT_SECRET = SECRET
    configureMagicLinkRuntime({
      isJtiRevoked: async () => false,
      recordIssued: async () => undefined,
    })
  })

  afterEach(() => {
    resetMagicLinkRuntime()
  })

  afterAll(() => {
    if (oldJwtSecret === undefined) {
      delete process.env.JWT_SECRET
    } else {
      process.env.JWT_SECRET = oldJwtSecret
    }
    if (oldNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = oldNodeEnv
    }
  })

  it("generates and verifies purchase links with a 24h TTL", async () => {
    const { token, claims } = generateMagicLinkWithClaims(
      "purchase",
      {
        customer_id: "cus_1",
        market_id: "bonbeauty",
        order_id: "ord_1",
      },
      { now: NOW, jti: PURCHASE_JTI }
    )

    expect(claims.exp - claims.iat).toBe(MAGIC_LINK_TTL_SECONDS.purchase)

    await expect(verifyMagicLink(token, { now: NOW })).resolves.toMatchObject({
      valid: true,
      purpose: "purchase",
      jti: PURCHASE_JTI,
      subject: {
        customer_id: "cus_1",
        market_id: "bonbeauty",
        order_id: "ord_1",
      },
    })
  })

  it("records issuance through the default runtime binding", async () => {
    const recordIssued = jest.fn().mockResolvedValue(undefined)
    configureMagicLinkRuntime({
      isJtiRevoked: async () => false,
      recordIssued,
    })

    const token = await generateMagicLink(
      "recover",
      {
        customer_id: "cus_2",
        market_id: "bonbeauty",
        email: "customer@example.test",
      },
      { now: NOW, jti: RECOVER_JTI }
    )

    expect(token).toEqual(expect.any(String))
    expect(recordIssued).toHaveBeenCalledWith(
      expect.objectContaining({
        claims: expect.objectContaining({
          jti: RECOVER_JTI,
          purpose: "recover",
        }),
      })
    )
  })

  it("generates and verifies recover links with a 7d TTL", async () => {
    const { token, claims } = generateMagicLinkWithClaims(
      "recover",
      {
        customer_id: "cus_2",
        market_id: "bonbeauty",
        email: "customer@example.test",
      },
      { now: NOW, jti: RECOVER_JTI }
    )

    expect(claims.exp - claims.iat).toBe(MAGIC_LINK_TTL_SECONDS.recover)

    await expect(verifyMagicLink(token, { now: NOW })).resolves.toMatchObject({
      valid: true,
      purpose: "recover",
      jti: RECOVER_JTI,
    })
  })

  it("returns expired after signature validation when exp is in the past", async () => {
    const { token } = generateMagicLinkWithClaims(
      "purchase",
      { customer_id: "cus_1" },
      { now: NOW, jti: PURCHASE_JTI }
    )
    const afterExpiry = new Date(
      NOW.getTime() + MAGIC_LINK_TTL_SECONDS.purchase * 1000 + 1000
    )

    await expect(verifyMagicLink(token, { now: afterExpiry })).resolves.toEqual({
      valid: false,
      reason: "expired",
    })
  })

  it("returns invalid for malformed token and bad signature", async () => {
    await expect(verifyMagicLink("not-a-jwt", { now: NOW })).resolves.toEqual({
      valid: false,
      reason: "invalid",
    })

    const { token } = generateMagicLinkWithClaims(
      "recover",
      { customer_id: "cus_1" },
      { now: NOW, jti: RECOVER_JTI }
    )

    await expect(
      verifyMagicLink(`${token.slice(0, -1)}x`, { now: NOW })
    ).resolves.toEqual({
      valid: false,
      reason: "invalid",
    })
  })

  it("returns invalid for wrong algorithm, missing jti, and bad purpose", async () => {
    const validClaims: MagicLinkClaims = {
      jti: RECOVER_JTI,
      purpose: "recover",
      subject: { customer_id: "cus_1" },
      iat: Math.floor(NOW.getTime() / 1000),
      exp: Math.floor(NOW.getTime() / 1000) + MAGIC_LINK_TTL_SECONDS.recover,
    }

    await expect(
      verifyMagicLink(signedToken(validClaims, { alg: "none", typ: "JWT" }), {
        now: NOW,
      })
    ).resolves.toEqual({ valid: false, reason: "invalid" })

    await expect(
      verifyMagicLink(signedToken({ ...validClaims, jti: undefined }), {
        now: NOW,
      })
    ).resolves.toEqual({ valid: false, reason: "invalid" })

    await expect(
      verifyMagicLink(signedToken({ ...validClaims, purpose: "other" }), {
        now: NOW,
      })
    ).resolves.toEqual({ valid: false, reason: "invalid" })
  })

  it("checks revocation after cryptographic validation", async () => {
    const { token } = generateMagicLinkWithClaims(
      "recover",
      { customer_id: "cus_1" },
      { now: NOW, jti: RECOVER_JTI }
    )
    const isJtiRevoked = jest.fn().mockResolvedValue(true)

    await expect(
      verifyMagicLink(token, { now: NOW, isJtiRevoked })
    ).resolves.toEqual({
      valid: false,
      reason: "revoked",
    })
    expect(isJtiRevoked).toHaveBeenCalledWith(RECOVER_JTI)
  })

  it("fails closed when no revocation checker is configured", async () => {
    resetMagicLinkRuntime()

    const { token } = generateMagicLinkWithClaims(
      "recover",
      { customer_id: "cus_1" },
      { now: NOW, jti: RECOVER_JTI }
    )

    await expect(verifyMagicLink(token, { now: NOW })).resolves.toEqual({
      valid: false,
      reason: "invalid",
    })
  })

  it("fails closed when JWT_SECRET is missing or too short", async () => {
    delete process.env.JWT_SECRET
    delete process.env.MAGIC_LINK_TEST_JWT_SECRET

    expect(() =>
      generateMagicLinkWithClaims("recover", { customer_id: "cus_1" }, { now: NOW })
    ).toThrow(/JWT_SECRET/)

    process.env.JWT_SECRET = "short"
    expect(() =>
      generateMagicLinkWithClaims("recover", { customer_id: "cus_1" }, { now: NOW })
    ).toThrow(/at least 32 bytes/)
  })
})
