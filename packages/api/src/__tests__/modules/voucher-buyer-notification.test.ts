/**
 * Story v160-6-6: AR45 boundary integration test for buyer claim notification.
 *
 * Mandatory regression gate. Mocks a voucher source record populated with
 * BOTH buyer-side AND recipient-side fields, runs the projection +
 * notification handler, and asserts:
 *
 *   - Positive: rendered email subject + text + html contain the expected
 *     buyer-side fields (seller_name, service_title, claimed_at, voucher_code).
 *   - Negative: rendered output (audit entry + email artifact) contains zero
 *     recipient-side substrings (recipient_email, recipient_name,
 *     recipient_phone, recipient_ip, recipient_user_agent, claim_session_id,
 *     gift_message).
 *
 * Test pattern matches Story 6.5 AR45 grep — JSON-stringify + regex
 * negative-match. Adding new recipient fields to the source is a no-op for
 * the projection (allowlist enforced by type system + projector function).
 */

import {
  handleVoucherClaimedForBuyerNotification,
  type BuyerClaimAuditEntry,
} from "../../subscribers/voucher-claimed-buyer-notification"
import {
  projectBuyerClaimEmailPayload,
  type VoucherClaimSourceRecord,
} from "../../modules/vendor-notifications/buyer-claim-projection"
import {
  renderBuyerClaimHtml,
  renderBuyerClaimSubject,
  renderBuyerClaimText,
} from "../../modules/vendor-notifications/email-templates/buyer-claim/i18n"

describe("buyer-claim notification — Story v160-6-6 AR45 integration", () => {
  const sourceWithRecipientFields: VoucherClaimSourceRecord = {
    // Allowlisted (must reach projection):
    buyer_email: "marta.gift@example.com",
    buyer_locale: "pl",
    seller_name: "Salon Anna Beauty",
    seller_handle: "anna-beauty-warszawa",
    service_title: "Manicure hybrydowy 60 min",
    claimed_at: "2026-05-02T14:30:00Z",
    voucher_code: "ABC-123",
    // Block-listed (recipient-side — MUST NOT leak to email):
    recipient_email: "ania.recipient@example.com",
    recipient_name: "Ania Kowalska",
    recipient_phone: "+48555000111",
    recipient_ip: "192.0.2.42",
    recipient_user_agent: "Mozilla/5.0 (recipient browser)",
    claim_session_id: "sess_recipient_xxxx",
    recipient_address: "ul. Recipient 7, 00-001 Warszawa",
    gift_message: "Wesołych urodzin Aniu!",
  }

  describe("projectBuyerClaimEmailPayload — type + value boundary", () => {
    it("includes ONLY the 7 allowlisted fields (positive)", () => {
      const projected = projectBuyerClaimEmailPayload(sourceWithRecipientFields)
      expect(projected).not.toBeNull()
      expect(projected!.buyer_email).toBe("marta.gift@example.com")
      expect(projected!.locale).toBe("pl")
      expect(projected!.seller_name).toBe("Salon Anna Beauty")
      expect(projected!.seller_handle).toBe("anna-beauty-warszawa")
      expect(projected!.service_title).toBe("Manicure hybrydowy 60 min")
      expect(projected!.claimed_at).toBe("2026-05-02T14:30:00Z")
      expect(projected!.voucher_code).toBe("ABC-123")
    })

    it("strips ALL recipient-side fields from JSON serialisation (negative AR45)", () => {
      const projected = projectBuyerClaimEmailPayload(sourceWithRecipientFields)
      const json = JSON.stringify(projected)
      expect(json).not.toMatch(/recipient_email/i)
      expect(json).not.toMatch(/recipient_name/i)
      expect(json).not.toMatch(/recipient_phone/i)
      expect(json).not.toMatch(/recipient_ip/i)
      expect(json).not.toMatch(/recipient_user_agent/i)
      expect(json).not.toMatch(/claim_session_id/i)
      expect(json).not.toMatch(/gift_message/i)
      expect(json).not.toMatch(/ania\.recipient/i)
      expect(json).not.toMatch(/Ania Kowalska/i)
      expect(json).not.toMatch(/\+48555000111/)
      expect(json).not.toMatch(/192\.0\.2\.42/)
      expect(json).not.toMatch(/Wesołych urodzin/)
    })

    it("returns null when mandatory field missing (defensive)", () => {
      const partial: VoucherClaimSourceRecord = {
        ...sourceWithRecipientFields,
        seller_name: null,
      }
      expect(projectBuyerClaimEmailPayload(partial)).toBeNull()
    })

    it("defaults locale to pl when buyer_locale missing or unsupported", () => {
      const noLocale: VoucherClaimSourceRecord = {
        ...sourceWithRecipientFields,
        buyer_locale: null,
      }
      expect(projectBuyerClaimEmailPayload(noLocale)?.locale).toBe("pl")
      const garbageLocale: VoucherClaimSourceRecord = {
        ...sourceWithRecipientFields,
        buyer_locale: "ua",
      }
      expect(projectBuyerClaimEmailPayload(garbageLocale)?.locale).toBe("pl")
    })
  })

  describe("rendered email artifacts — locale + AR45 grep", () => {
    it("PL subject + text + html include allowlisted fields, exclude recipient PII", () => {
      const projected = projectBuyerClaimEmailPayload(sourceWithRecipientFields)!
      const subject = renderBuyerClaimSubject("pl", projected)
      const text = renderBuyerClaimText("pl", projected)
      const html = renderBuyerClaimHtml("pl", projected)

      expect(subject).toContain("zrealizowany")
      expect(text).toContain("Salon Anna Beauty")
      expect(text).toContain("Manicure hybrydowy 60 min")
      expect(text).toContain("ABC-123")
      expect(html).toContain("Salon Anna Beauty")
      expect(html).toContain("Manicure hybrydowy 60 min")

      const fullArtifact = `${subject}\n${text}\n${html}`
      expect(fullArtifact).not.toMatch(/ania\.recipient/i)
      expect(fullArtifact).not.toMatch(/Ania Kowalska/i)
      expect(fullArtifact).not.toMatch(/\+48555000111/)
      expect(fullArtifact).not.toMatch(/192\.0\.2\.42/)
      expect(fullArtifact).not.toMatch(/sess_recipient/i)
      expect(fullArtifact).not.toMatch(/Wesołych urodzin/)
    })

    it("EN subject contains 'claimed', body excludes recipient PII", () => {
      const enProjected = projectBuyerClaimEmailPayload({
        ...sourceWithRecipientFields,
        buyer_locale: "en",
      })!
      const subject = renderBuyerClaimSubject("en", enProjected)
      const text = renderBuyerClaimText("en", enProjected)
      expect(subject).toContain("claimed")
      expect(text).not.toMatch(/ania\.recipient/i)
      expect(text).not.toMatch(/recipient_/i)
    })
  })

  describe("handleVoucherClaimedForBuyerNotification — handler integration", () => {
    it("returns audit entry status=sent when source resolves cleanly", async () => {
      const fetcher = {
        fetchVoucherClaimSource: jest
          .fn<Promise<VoucherClaimSourceRecord | null>, [string]>()
          .mockResolvedValue(sourceWithRecipientFields),
      }
      const entry = await handleVoucherClaimedForBuyerNotification(
        { voucher_id: "vch_1" },
        { fetcher },
      )
      expect(entry.notification_type).toBe("buyer_claim_notification")
      expect(entry.status).toBe("sent")
      expect(entry.email_to).toBe("marta.gift@example.com")
      expect(entry.locale).toBe("pl")
      expect(fetcher.fetchVoucherClaimSource).toHaveBeenCalledWith("vch_1")
    })

    it("AR45: serialised audit entry contains zero recipient-side substrings", async () => {
      const fetcher = {
        fetchVoucherClaimSource: jest
          .fn<Promise<VoucherClaimSourceRecord | null>, [string]>()
          .mockResolvedValue(sourceWithRecipientFields),
      }
      const entry = await handleVoucherClaimedForBuyerNotification(
        { voucher_id: "vch_1" },
        { fetcher },
      )
      const json = JSON.stringify(entry)
      expect(json).not.toMatch(/recipient_/i)
      expect(json).not.toMatch(/ania\.recipient/i)
      expect(json).not.toMatch(/Ania Kowalska/i)
      expect(json).not.toMatch(/sess_recipient/i)
    })

    it("returns status=failed when source not found", async () => {
      const fetcher = {
        fetchVoucherClaimSource: jest
          .fn<Promise<VoucherClaimSourceRecord | null>, [string]>()
          .mockResolvedValue(null),
      }
      const entry: BuyerClaimAuditEntry =
        await handleVoucherClaimedForBuyerNotification(
          { voucher_id: "vch_missing" },
          { fetcher },
        )
      expect(entry.status).toBe("failed")
      expect(entry.error_message).toBe("voucher source not found")
    })

    it("returns status=failed when projection returns null (missing mandatory)", async () => {
      const fetcher = {
        fetchVoucherClaimSource: jest
          .fn<Promise<VoucherClaimSourceRecord | null>, [string]>()
          .mockResolvedValue({
            buyer_email: "marta.gift@example.com",
            // missing seller_name, etc.
          }),
      }
      const entry = await handleVoucherClaimedForBuyerNotification(
        { voucher_id: "vch_partial" },
        { fetcher },
      )
      expect(entry.status).toBe("failed")
      expect(entry.email_to).toBe("marta.gift@example.com")
      expect(entry.error_message).toContain("projection failed")
    })
  })
})
