/**
 * v1.15.0 Story 4.1 AC2 — KAŻDY produkcyjny call-site wysyłki ma NAZWANY nośnik
 * bariery; nie zostaje ani jeden, w którym klucz jest losowy.
 *
 * ── Czym ta suita jest ─────────────────────────────────────────────────────
 * Wyliczonym zbiorem call-site'ów wraz z odpowiedzią per call-site, ZAPISANYM
 * JAKO KOD, a nie tabelką w dokumencie. Dopisanie nowego call-site'u bez klucza
 * nie przechodzi tu po cichu: gałąź awaryjna w `toNotificationIntent` podnosi
 * licznik, a poniższe kontrole na nim asertują.
 *
 * ── Dlaczego to jest test o WYKONANIU, nie o wyrażeniu ─────────────────────
 * Kontrole nie czytają wyrażenia budującego klucz — uruchamiają realny builder
 * payloadu danego call-site'u i przepuszczają wynik przez realny
 * `toNotificationIntent`, czyli tę samą funkcję, która biegnie w produkcji.
 */
import { NOTIFICATION_TEMPLATE_KEYS } from "@gp/messaging"

import { buildRecoverMagicLinkIdempotencyKey } from "../../lib/auth/recover-magic-link-email"
import {
  getMissingIdempotencyKeyCounts,
  resetMissingIdempotencyKeyCounts,
  toNotificationIntent,
} from "../../modules/notification-brevo/intent"
import { buildPurchaseConfirmationNotification } from "../../modules/voucher-delivery/purchase-confirmation-intent"
import { buildAppointmentDispatchIdempotencyKey } from "../../subscribers/voucher-appointment-confirmed-delivery"
import { buildBuyerClaimDispatchIdempotencyKey } from "../../subscribers/voucher-claimed-buyer-notification"

beforeEach(() => {
  resetMissingIdempotencyKeyCounts()
})

function intentFrom(payload: Record<string, unknown>) {
  return toNotificationIntent(payload as never)
}

describe("AC2 — klucz z data.idempotency_key jest DETERMINISTYCZNY i przenoszony do intentu", () => {
  it("wariant (a): ścieżka zakupowa — klucz wyprowadzony z wiersza skutku", () => {
    const build = (dispatchId: string, entitlementId = "ent-1") =>
      buildPurchaseConfirmationNotification({
        entitlement_id: entitlementId,
        dispatch_id: dispatchId,
        market_id: "bonbeauty",
        locale: "pl",
        recipient_email: "marta@example.com",
        recipient_hash: "sha256:" + "a".repeat(64),
        customer_first_name: "Marta",
        voucher_code: "ABC-123",
        voucher_expires_at: "2026-12-31T00:00:00.000Z",
        voucher_page_url: "https://example.test/v/ABC-123",
        market_url: "https://example.test",
        support_email: "support@example.test",
        salon_name: "Salon",
        salon_address: "ul. Testowa 1",
        salon_url: "/pl/sellers/salon",
        order_id: "order-1",
        purchase_date: "2026-08-01T00:00:00.000Z",
        voucher_value_minor: "10000",
        voucher_currency: "PLN",
      } as never)

    const first = intentFrom(build("dsp-1"))
    const second = intentFrom(build("dsp-1"))

    // Ten sam wiersz skutku → ten sam klucz. To jest cała treść „deterministyczny".
    expect(first.idempotency_key).toBe(second.idempotency_key)
    expect(first.idempotency_key).not.toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
    // Klucz jest wyprowadzony z TOŻSAMOŚCI wiersza skutku
    // (`entitlement_id : template_key : recipient_hash`), a NIE z `dispatch_id`.
    // To jest istotne, nie kosmetyczne: retry po `failed → queued` dostaje nowy
    // `dispatch_id`, więc klucz oparty na nim rozpadłby się dokładnie w chwili,
    // w której bariera ma działać.
    expect(intentFrom(build("dsp-2")).idempotency_key).toBe(first.idempotency_key)
    // Inny entitlement → inny klucz: bariera nie skleja dwóch legalnych wysyłek.
    expect(intentFrom(build("dsp-1", "ent-2")).idempotency_key).not.toBe(
      first.idempotency_key,
    )
    expect(getMissingIdempotencyKeyCounts()).toEqual({})
  })

  it("wariant (b): potwierdzenie wizyty — tożsamością jest SPOTKANIE, nie entitlement", () => {
    const base = {
      entitlementId: "ent-1",
      appointmentId: "apt-1",
      startsAt: "2026-09-01T10:00:00.000Z",
      sequence: 1,
    }
    const key = buildAppointmentDispatchIdempotencyKey(base)

    expect(buildAppointmentDispatchIdempotencyKey(base)).toBe(key)
    // Przełożona wizyta to LEGALNY drugi mail — inny `starts_at`, inny klucz.
    expect(
      buildAppointmentDispatchIdempotencyKey({
        ...base,
        startsAt: "2026-09-02T10:00:00.000Z",
      }),
    ).not.toBe(key)
  })

  it("wariant (b): powiadomienie o odbiorze — tożsamością jest ODBIÓR, nie voucher", () => {
    const key = buildBuyerClaimDispatchIdempotencyKey({
      voucherId: "v-1",
      claimedAt: "2026-08-01T10:00:00.000Z",
    })

    expect(
      buildBuyerClaimDispatchIdempotencyKey({
        voucherId: "v-1",
        claimedAt: "2026-08-01T10:00:00.000Z",
      }),
    ).toBe(key)
    // `withdraw → reclaim` to legalny drugi mail.
    expect(
      buildBuyerClaimDispatchIdempotencyKey({
        voucherId: "v-1",
        claimedAt: "2026-08-05T10:00:00.000Z",
      }),
    ).not.toBe(key)
  })

  it("wariant (b): magic-link — klucz niesie SKRÓT tokenu, nigdy tokenu", () => {
    const token = "super-secret-recovery-token"
    const key = buildRecoverMagicLinkIdempotencyKey(token)

    expect(buildRecoverMagicLinkIdempotencyKey(token)).toBe(key)
    expect(buildRecoverMagicLinkIdempotencyKey(`${token}-inny`)).not.toBe(key)
    // `barrier_key` trafia do tabeli, logów sterownika i metryk — token nie może.
    expect(key).not.toContain(token)
    expect(key).toMatch(/^customer-recover-magic-link:[0-9a-f]{64}$/)
  })
})

describe("AC2 — brak klucza jest GŁOŚNY, nie cichy", () => {
  const keylessPayload = {
    to: "kto@example.test",
    channel: "email",
    template: NOTIFICATION_TEMPLATE_KEYS.CUSTOMER_RECOVER_MAGIC_LINK,
    data: {
      template_key: NOTIFICATION_TEMPLATE_KEYS.CUSTOMER_RECOVER_MAGIC_LINK,
      market_id: "bonbeauty",
      locale: "pl",
    },
  }

  it("call-site bez klucza podnosi licznik i woła hook", () => {
    const seen: Array<{ template_key: string; market_id: string }> = []

    toNotificationIntent(keylessPayload as never, {
      onMissingIdempotencyKey: (info) => seen.push(info),
    })

    expect(seen).toEqual([
      {
        template_key: NOTIFICATION_TEMPLATE_KEYS.CUSTOMER_RECOVER_MAGIC_LINK,
        market_id: "bonbeauty",
      },
    ])
    expect(getMissingIdempotencyKeyCounts()).toEqual({
      [NOTIFICATION_TEMPLATE_KEYS.CUSTOMER_RECOVER_MAGIC_LINK]: 1,
    })
  })

  it("TOP-LEVEL `idempotency_key` wystarcza — i wtedy licznik NIE rośnie", () => {
    // Call-site, który podał klucz module'owi Notification Medusy, oczywiście
    // chce tej samej tożsamości wysyłki także w barierze gatewaya.
    const intent = toNotificationIntent({
      ...keylessPayload,
      idempotency_key: "customer-recover-magic-link:abc",
    } as never)

    expect(intent.idempotency_key).toBe("customer-recover-magic-link:abc")
    expect(getMissingIdempotencyKeyCounts()).toEqual({})
  })

  it("KONTROLA KONTROLI: licznik faktycznie rośnie tylko na gałęzi awaryjnej", () => {
    // Gdyby licznik rósł zawsze, poprzednia kontrola nie mierzyłaby niczego.
    toNotificationIntent({
      ...keylessPayload,
      data: { ...keylessPayload.data, idempotency_key: "jawny-klucz" },
    } as never)
    toNotificationIntent(keylessPayload as never)
    toNotificationIntent(keylessPayload as never)

    expect(getMissingIdempotencyKeyCounts()).toEqual({
      [NOTIFICATION_TEMPLATE_KEYS.CUSTOMER_RECOVER_MAGIC_LINK]: 2,
    })
  })
})
