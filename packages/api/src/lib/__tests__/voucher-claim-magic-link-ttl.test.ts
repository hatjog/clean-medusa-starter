/**
 * voucher-claim-magic-link-ttl.test.ts — Story 7.4 AC1-a (ADR-138 DEC-1).
 *
 * Test-the-test TTL/410 (czysty, bez live PG):
 *   - link świeży (w oknie TTL) ⇒ NIE wygasły (claim OK → 200);
 *   - link wygasły (poza oknem) ⇒ wygasły (→ 410 Gone);
 *   - grandfather: issued_at NULL ⇒ NIE wygasa (legacy, brak baseline);
 *   - rollback: feature-flag off ⇒ NIGDY nie wygasa;
 *   - per-market override TTL + globalny default 24h + fail-safe na śmieci.
 *
 * Rozdział scope tokenów: ten TTL dotyczy voucher-claim, NIE auth-login.
 */

import { describe, it, expect } from "@jest/globals"
import {
  DEFAULT_CLAIM_TOKEN_TTL_HOURS,
  EXPIRED_CLAIM_LINK_GONE_BODY,
  claimTokenExpiryMs,
  isClaimTokenExpired,
  isClaimTokenTtlEnforced,
  resolveClaimTokenTtlHours,
} from "../voucher-claim-magic-link-ttl"

const HOUR_MS = 60 * 60 * 1000
const NOW = Date.parse("2026-06-03T12:00:00.000Z")

describe("Story 7.4 — TTL magic-link voucher-claim (ADR-138 DEC-1)", () => {
  describe("isClaimTokenExpired (rdzeń AC1-a)", () => {
    it("link świeży (1h temu, TTL 24h) ⇒ NIE wygasły", () => {
      expect(
        isClaimTokenExpired({
          issuedAt: new Date(NOW - 1 * HOUR_MS),
          ttlHours: 24,
          now: NOW,
        })
      ).toBe(false)
    })

    it("link wygasły (25h temu, TTL 24h) ⇒ wygasły (→410)", () => {
      expect(
        isClaimTokenExpired({
          issuedAt: new Date(NOW - 25 * HOUR_MS),
          ttlHours: 24,
          now: NOW,
        })
      ).toBe(true)
    })

    it("dokładnie na granicy okna (24h równo) ⇒ NIE wygasły (ostatnia chwila ważności)", () => {
      expect(
        isClaimTokenExpired({
          issuedAt: new Date(NOW - 24 * HOUR_MS),
          ttlHours: 24,
          now: NOW,
        })
      ).toBe(false)
    })

    it("grandfather: issued_at NULL ⇒ NIE wygasa (legacy, brak baseline)", () => {
      expect(
        isClaimTokenExpired({ issuedAt: null, ttlHours: 24, now: NOW })
      ).toBe(false)
    })

    it("rollback: enforced=false ⇒ NIGDY nie wygasa (nawet stary link)", () => {
      expect(
        isClaimTokenExpired({
          issuedAt: new Date(NOW - 1000 * HOUR_MS),
          ttlHours: 24,
          now: NOW,
          enforced: false,
        })
      ).toBe(false)
    })

    it("akceptuje issued_at jako string ISO i jako epoch ms", () => {
      const iso = new Date(NOW - 25 * HOUR_MS).toISOString()
      expect(isClaimTokenExpired({ issuedAt: iso, ttlHours: 24, now: NOW })).toBe(true)
      expect(
        isClaimTokenExpired({ issuedAt: NOW - 25 * HOUR_MS, ttlHours: 24, now: NOW })
      ).toBe(true)
    })

    it("niepoprawny issued_at ⇒ NIE wygasa (fail-safe, nie 410 przez śmieci)", () => {
      expect(
        isClaimTokenExpired({ issuedAt: "not-a-date", ttlHours: 24, now: NOW })
      ).toBe(false)
    })
  })

  describe("isClaimTokenTtlEnforced (feature-flag / rollback)", () => {
    it("default (brak env) ⇒ włączony", () => {
      expect(isClaimTokenTtlEnforced({})).toBe(true)
    })
    it.each(["false", "FALSE", "0", "off", "no"])(
      "VOUCHER_CLAIM_MAGIC_LINK_TTL_ENABLED=%s ⇒ wyłączony (link bez wygasania)",
      (v) => {
        expect(
          isClaimTokenTtlEnforced({ VOUCHER_CLAIM_MAGIC_LINK_TTL_ENABLED: v })
        ).toBe(false)
      }
    )
    it("true ⇒ włączony", () => {
      expect(
        isClaimTokenTtlEnforced({ VOUCHER_CLAIM_MAGIC_LINK_TTL_ENABLED: "true" })
      ).toBe(true)
    })
  })

  describe("resolveClaimTokenTtlHours (per-market + default + fail-safe)", () => {
    it("default = 24h gdy brak konfiguracji", () => {
      expect(resolveClaimTokenTtlHours(null, {})).toBe(DEFAULT_CLAIM_TOKEN_TTL_HOURS)
      expect(DEFAULT_CLAIM_TOKEN_TTL_HOURS).toBe(24)
    })
    it("globalny override", () => {
      expect(
        resolveClaimTokenTtlHours(null, { VOUCHER_CLAIM_MAGIC_LINK_TTL_HOURS: "48" })
      ).toBe(48)
    })
    it("per-market override ma pierwszeństwo nad globalnym", () => {
      expect(
        resolveClaimTokenTtlHours("bonbeauty", {
          VOUCHER_CLAIM_MAGIC_LINK_TTL_HOURS: "48",
          VOUCHER_CLAIM_MAGIC_LINK_TTL_HOURS__BONBEAUTY: "12",
        })
      ).toBe(12)
    })
    it("śmieciowa wartość ⇒ fail-safe do default (NIGDY do bez-wygasania)", () => {
      expect(
        resolveClaimTokenTtlHours(null, { VOUCHER_CLAIM_MAGIC_LINK_TTL_HOURS: "-5" })
      ).toBe(DEFAULT_CLAIM_TOKEN_TTL_HOURS)
      expect(
        resolveClaimTokenTtlHours(null, { VOUCHER_CLAIM_MAGIC_LINK_TTL_HOURS: "abc" })
      ).toBe(DEFAULT_CLAIM_TOKEN_TTL_HOURS)
    })
  })

  describe("claimTokenExpiryMs + payload 410", () => {
    it("liczy moment wygaśnięcia = issued_at + TTL", () => {
      const issued = NOW - 1 * HOUR_MS
      expect(claimTokenExpiryMs(new Date(issued), 24)).toBe(issued + 24 * HOUR_MS)
    })
    it("null gdy issued_at NULL", () => {
      expect(claimTokenExpiryMs(null, 24)).toBeNull()
    })
    it("payload 410 jest neutralny i niesie state EXPIRED_LINK", () => {
      expect(EXPIRED_CLAIM_LINK_GONE_BODY.state).toBe("EXPIRED_LINK")
      expect(EXPIRED_CLAIM_LINK_GONE_BODY.type).toBe("magic_link_expired")
    })
  })
})
