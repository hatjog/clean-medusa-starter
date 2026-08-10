/**
 * deferred-issuance-marker.unit.spec.ts — ślad deferral dla przegranego wyścigu
 * `payment_intent.succeeded` × `completeCart`.
 *
 * Każdy przypadek pęka po cofnięciu konkretnego członu naprawy — to jest warunek,
 * pod którym ten plik cokolwiek mierzy.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  DEFERRED_ISSUANCE_EVENT_SUFFIX,
  DEFERRED_ISSUANCE_REASON,
  persistDeferredIssuanceMarker,
  RESERVE_WEBHOOK_DELIVERY_SQL,
  STRIPE_PATH_Y_WEBHOOK_PROVIDER,
} from "../../../lib/payment/stripe-payment-intent-transport"

function makeClient(rowCount = 1) {
  const query = jest.fn().mockResolvedValue({ rowCount, rows: [] })
  return { client: { query } as never, query }
}

describe("persistDeferredIssuanceMarker", () => {
  const input = {
    event_id: "evt_123",
    payment_intent_id: "pi_456",
    market_id: "bonbeauty",
  }

  it("pisze przez ten sam SQL co rezerwacja — `ON CONFLICT DO NOTHING`", async () => {
    const { client, query } = makeClient()
    await persistDeferredIssuanceMarker(client, input)

    expect(query.mock.calls[0][0]).toBe(RESERVE_WEBHOOK_DELIVERY_SQL)
    // Idempotencja nie jest tu wymyślana — bierze się z klauzuli konfliktu.
    expect(RESERVE_WEBHOOK_DELIVERY_SQL).toContain("ON CONFLICT")
  })

  it("NIE zajmuje klucza rezerwacji — inaczej ponowienie Stripe'a przestałoby emitować", async () => {
    const { client, query } = makeClient()
    await persistDeferredIssuanceMarker(client, input)

    const [eventId, provider] = query.mock.calls[0][1]
    // Kontrola dodatnia sedna naprawy: gdyby ślad użył gołego `evt_123`,
    // `reserveWebhookDelivery` dostałby później `false` = „już przyjęte",
    // route pominąłby emisję i voucher nie powstałby nigdy.
    expect(eventId).toBe(`evt_123${DEFERRED_ISSUANCE_EVENT_SUFFIX}`)
    expect(eventId).not.toBe("evt_123")
    // `provider` zostaje nasz — kompensacja ścieżki natywnej kasuje po
    // `provider = 'stripe'` i nie wolno jej dosięgnąć wierszy Path Y.
    expect(provider).toBe(STRIPE_PATH_Y_WEBHOOK_PROVIDER)
  })

  it("RZUCA na kolizji przestrzeni kluczy zamiast zamienić naprawę w ciszę", async () => {
    // `event_id` już z sufiksem dałby klucz IDENTYCZNY z kluczem rezerwacji:
    // `reserveWebhookDelivery` zwróciłby `false` = „już przyjęte", route
    // pominąłby emisję i voucher nie powstałby nigdy. Rozłączność kluczy była
    // dotąd samą konwencją — teraz jest asercją.
    const { client, query } = makeClient()
    await expect(
      persistDeferredIssuanceMarker(client, {
        ...input,
        event_id: `evt_123${DEFERRED_ISSUANCE_EVENT_SUFFIX}`,
      })
    ).rejects.toThrow(DEFERRED_ISSUANCE_EVENT_SUFFIX)
    // Guard biegnie PRZED zapisem — kolizja nie zostawia wiersza.
    expect(query).not.toHaveBeenCalled()
  })

  it("koperta ma kształt, po którym łączy odzysk", async () => {
    const { client, query } = makeClient()
    await persistDeferredIssuanceMarker(client, input)

    const envelope = JSON.parse(query.mock.calls[0][1][3])
    // `scope` jako STRING (koperty Path Y noszą obiekt) — JOIN odzysku robi
    // `envelope->>'scope' = 'payment_intent:' || payment.data->>'id'`.
    expect(envelope.scope).toBe("payment_intent:pi_456")
    expect(typeof envelope.scope).toBe("string")
    expect(envelope.event_type).toBe("payment.captured")
    expect(envelope.entitlement_issue_deferred_reason).toBe(DEFERRED_ISSUANCE_REASON)
    expect(DEFERRED_ISSUANCE_REASON).toBe("webhook_before_order")
    // Ślad NIE niesie `entitlement_issue_resolved_at` — inaczej odzysk
    // odfiltrowałby go od razu jako już domknięty.
    expect(envelope).not.toHaveProperty("entitlement_issue_resolved_at")
    // ...ani tablicy domknięć per zamówienie, z tego samego powodu.
    expect(envelope).not.toHaveProperty("entitlement_issue_resolved_orders")
  })

  it("rozróżnia zapis od powtórki, zamiast zgłaszać sukces zawsze", async () => {
    const first = makeClient(1)
    expect(await persistDeferredIssuanceMarker(first.client, input)).toBe(true)

    const repeat = makeClient(0)
    expect(await persistDeferredIssuanceMarker(repeat.client, input)).toBe(false)
  })

  it("przekazuje market_id, także gdy jest nieznany", async () => {
    const { client, query } = makeClient()
    await persistDeferredIssuanceMarker(client, { ...input, market_id: null })
    expect(query.mock.calls[0][1][2]).toBeNull()
  })

  it("propaguje błąd bazy — gwarancję ciszy realizuje WOŁAJĄCY", async () => {
    // Docblock deklarował wcześniej „nigdy nie rzuca", a w ciele nie ma
    // `try/catch`. Kontrakt jest teraz zgodny z kodem: to route opakowuje
    // wywołanie i zachowuje `503`.
    const query = jest.fn().mockRejectedValue(new Error("pg down"))
    await expect(
      persistDeferredIssuanceMarker({ query } as never, input)
    ).rejects.toThrow("pg down")
  })
})

/**
 * Kontrola bramkowania w route'cie.
 *
 * Czyta ŹRÓDŁO, bo import route'u Medusy do testu jednostkowego ciągnie kontener
 * i zamienia kontrolę jednej gałęzi w test integracyjny. Mierzona własność jest
 * wąska i wyrażalna składniowo: zapis śladu MUSI leżeć pod warunkiem wyścigu
 * przejściowego. Odrzucenia trwałe (`link_ambiguous`) śladu nie zostawiają —
 * inaczej odzysk wołałby wystawienie przy każdym `order.placed` tego zamówienia,
 * dla zdarzenia, którego ponowienie nigdy nie naprawi.
 */
describe("route: ślad tylko dla wyścigu przejściowego", () => {
  const ROUTE = readFileSync(
    join(__dirname, "../../../api/webhooks/stripe/payment-intent/route.ts"),
    "utf8"
  )

  it("wywołanie śladu jest bramkowane `retryableLinkRace`", () => {
    const gate = ROUTE.indexOf("if (retryableLinkRace")
    const call = ROUTE.indexOf("persistDeferredIssuanceMarker(handle.client")
    expect(gate).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(gate)
  })

  it("kluczem śladu jest `deliveryEventId`, nie `stripeEvent.id`", () => {
    // Transport ma dla zdarzenia bez `id` świadomy fallback
    // `deliveryEventId = stripeEvent.id ?? "stripe:pi:<pi>"`. Bramka na
    // `stripeEvent.id` zostawiała takie zdarzenia zupełnie bez śladu.
    const call = ROUTE.indexOf("persistDeferredIssuanceMarker(handle.client")
    const body = ROUTE.slice(call, call + 400)
    expect(body).toContain("event_id: deliveryEventId")
    expect(body).not.toContain("event_id: stripeEvent.id")
    expect(ROUTE).toContain("const deliveryEventId = stripeEvent.id ??")
  })

  it("pominięcie śladu ZOSTAWIA sygnał — cisza jest nieodróżnialna od awarii", () => {
    // `logger.info` leżał WEWNĄTRZ gałęzi zapisu, więc pominięcie nie miało
    // żadnego nośnika. Operator szukający, czemu odzysk nic nie znalazł, nie
    // miał czego czytać.
    const gate = ROUTE.indexOf("if (retryableLinkRace")
    const branch = ROUTE.slice(gate, gate + 2200)
    const elseIdx = branch.indexOf("} else {")
    expect(elseIdx).toBeGreaterThan(-1)
    const elseBranch = branch.slice(elseIdx)
    expect(elseBranch).toContain("logger.warn")
    expect(elseBranch).toContain("POMINIETY")
  })

  it("porażka zapisu śladu NIE zmienia klasy odrzucenia", () => {
    // `503` vs `400` to kontrakt z retry Stripe'a i z operatorem. Ślad jest
    // dodatkiem; jego wyjątek nie może awansować odpowiedzi do `500`.
    const call = ROUTE.indexOf("persistDeferredIssuanceMarker(handle.client")
    const after = ROUTE.slice(call, call + 1800)
    expect(after).toContain("catch")
    expect(after).toContain("logger.warn")
    expect(after).toContain("res.status(retryableLinkRace ? 503 : 400)")
  })
})
