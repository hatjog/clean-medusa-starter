/**
 * provider-detail.test.ts — redakcja i przenoszenie odpowiedzi providera.
 *
 * Testy są pisane wokół REALNEJ odpowiedzi, która zablokowała dostawę
 * 2026-08-01 (HTTP 401 `unauthorized`, „unrecognised IP address 37.31.141.48"),
 * a nie wokół wymyślonego kształtu — bo to właśnie ten kształt przechodził
 * dotąd przez system, gubiąc po drodze i kod, i przyczynę.
 */
import { MessagingProviderError } from "../errors"
import {
  extractProviderDetailMarker,
  extractProviderStatusMarker,
  formatProviderResponseMarkers,
  normalizeProviderErrorCode,
  PROVIDER_DETAIL_MAX_LENGTH,
  sanitizeProviderDetail,
} from "../provider-detail"
import { extractErrorCodeMarker } from "../errors"
import { BrevoAdapter } from "../providers/brevo-adapter"
import type { NotificationIntent } from "../types"

/** Dosłowna odpowiedź Brevo z żywego zakupu (zamówienie 18, 2026-08-01). */
const LIVE_BREVO_401_BODY = {
  code: "unauthorized",
  message:
    "We have detected you are using an unrecognised IP address 37.31.141.48. " +
    "If you performed this action make sure to add the new IP address in this link: " +
    "https://app.brevo.com/security/authorised_ips",
}

describe("normalizeProviderErrorCode", () => {
  it("podnosi kod providera do postaci akceptowanej przez marker [gp_error_code=…]", () => {
    // To jest SEDNO pozycji 2: `unauthorized` nie pasuje do `[A-Z0-9_]+`, więc
    // marker był niewidoczny dla parsera i subscriber zapisywał fallback.
    const code = normalizeProviderErrorCode(
      LIVE_BREVO_401_BODY.code,
      "BREVO_PROVIDER_ERROR",
    )
    expect(code).toBe("BREVO_UNAUTHORIZED")
    expect(code).toMatch(/^[A-Z0-9_]+$/)
    expect(extractErrorCodeMarker(`[gp_error_code=${code}]`)).toBe(code)
  })

  it("nie dubluje prefiksu dla kodów już kanonicznych", () => {
    expect(
      normalizeProviderErrorCode("BREVO_TEMPLATE_NOT_CONFIGURED", "X"),
    ).toBe("BREVO_TEMPLATE_NOT_CONFIGURED")
  })

  it("zamienia separatory na podkreślenia zamiast je gubić", () => {
    expect(normalizeProviderErrorCode("invalid-parameter", "X")).toBe(
      "BREVO_INVALID_PARAMETER",
    )
  })

  it("spada na fallback dla wejścia, które nie jest kodem", () => {
    expect(normalizeProviderErrorCode(undefined, "FALLBACK")).toBe("FALLBACK")
    expect(normalizeProviderErrorCode("   ", "FALLBACK")).toBe("FALLBACK")
    expect(normalizeProviderErrorCode("!!!", "FALLBACK")).toBe("FALLBACK")
  })
})

describe("sanitizeProviderDetail — higiena", () => {
  it("redaguje adres IP, ale ZOSTAWIA diagnostyczną treść", () => {
    const detail = sanitizeProviderDetail(LIVE_BREVO_401_BODY)

    expect(detail).toBeTruthy()
    // Przyczyna MUSI zostać czytelna — inaczej kolumna jest bezużyteczna.
    expect(detail).toContain("unrecognised IP address")
    // …ale sam adres (dane osobowe wg RODO) NIE może trafić do ledgera.
    expect(detail).not.toContain("37.31.141.48")
    expect(detail).toContain("<redacted:ip>")
  })

  it("redaguje adres e-mail cytowany przez providera", () => {
    const detail = sanitizeProviderDetail({
      message: "Invalid email address: klientka@example.com",
    })
    expect(detail).not.toContain("klientka@example.com")
    expect(detail).toContain("<redacted:email>")
  })

  it.each([
    ["klucz Brevo", "api-key xkeysib-0123456789abcdef0123456789abcdef rejected"],
    ["Brevo SMTP", "xsmtpsib-0123456789abcdef0123456789abcdef failed"],
    ["klucz Stripe", "sk_test_0123456789abcdefghij is invalid"],
    ["webhook secret", "whsec_0123456789abcdefghij mismatch"],
    ["bearer", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh"],
    ["DSN", "postgres://user:s3cr3tpass@db:5432/gp_mercur unreachable"],
    ["przypisanie", "BREVO_API_KEY=xkeysib-deadbeefdeadbeefdeadbeef"],
  ])("nigdy nie przepuszcza sekretu (%s)", (_label, raw) => {
    const detail = sanitizeProviderDetail(raw) ?? ""

    expect(detail).toMatch(/<redacted:(secret|token)>/)
    for (const secretish of [
      "xkeysib-0123456789abcdef0123456789abcdef",
      "xsmtpsib-0123456789abcdef0123456789abcdef",
      "sk_test_0123456789abcdefghij",
      "whsec_0123456789abcdefghij",
      "eyJhbGciOiJIUzI1NiJ9.abcdefgh",
      "s3cr3tpass",
      "xkeysib-deadbeefdeadbeefdeadbeef",
    ]) {
      expect(detail).not.toContain(secretish)
    }
  })

  it("redaguje długi nieznany token (reguła ostatniej szansy)", () => {
    const detail = sanitizeProviderDetail(
      "rejected credential AbCdEf0123456789AbCdEf0123456789 for account",
    )
    expect(detail).not.toContain("AbCdEf0123456789AbCdEf0123456789")
    expect(detail).toContain("<redacted:token>")
  })

  it("usuwa nawiasy kwadratowe, żeby nie rozbić markera", () => {
    const detail = sanitizeProviderDetail("provider said [oops] and [more]")
    expect(detail).not.toContain("[")
    expect(detail).not.toContain("]")
  })

  it("spłaszcza wielolinijkową odpowiedź do jednej linii", () => {
    const detail = sanitizeProviderDetail("first line\nsecond\tline\r\nthird")
    expect(detail).toBe("first line second line third")
  })

  it("jest IDEMPOTENTNA — powtórna redakcja nie zjada placeholderów", () => {
    const once = sanitizeProviderDetail(LIVE_BREVO_401_BODY)
    const twice = sanitizeProviderDetail(once)
    expect(twice).toBe(once)
  })

  it("przycina do twardego limitu", () => {
    const detail = sanitizeProviderDetail("x ".repeat(1000))
    expect(detail!.length).toBeLessThanOrEqual(PROVIDER_DETAIL_MAX_LENGTH)
  })

  it("zwraca null, gdy nie ma czego zapisać", () => {
    expect(sanitizeProviderDetail(null)).toBeNull()
    expect(sanitizeProviderDetail({})).toBeNull()
    expect(sanitizeProviderDetail("   ")).toBeNull()
  })
})

describe("markery odpowiedzi providera", () => {
  it("round-trip: format → extract", () => {
    const detail = sanitizeProviderDetail(LIVE_BREVO_401_BODY)
    const suffix = formatProviderResponseMarkers({
      status_code: 401,
      detail,
    })

    expect(extractProviderStatusMarker(`prefix${suffix}`)).toBe(401)
    expect(extractProviderDetailMarker(`prefix${suffix}`)).toBe(detail)
  })

  it("przeżywa DWUKROTNE przepakowanie wyjątku przez Medusę", () => {
    // Dokładnie to robi runtime: `notification-module-service.js` opakowuje
    // `e.message` w MedusaError, a `promiseAll({ aggregateErrors: true })`
    // opakowuje to jeszcze raz. Marker jest jedynym nośnikiem, który to
    // przechodzi — pola `status_code`/`cause` giną.
    const detail = sanitizeProviderDetail(LIVE_BREVO_401_BODY)
    const inner = `Brevo provider request failed (BREVO_UNAUTHORIZED, HTTP 401)${formatProviderResponseMarkers(
      { status_code: 401, detail },
    )}`
    const repackagedOnce = `Failed to send notification with id noti_01:\n${inner}`
    const repackagedTwice = `notification: ${repackagedOnce}`

    expect(extractProviderStatusMarker(repackagedTwice)).toBe(401)
    expect(extractProviderDetailMarker(repackagedTwice)).toBe(detail)
  })

  it("brak markera znaczy brak informacji, nie pusty string", () => {
    expect(extractProviderStatusMarker("nothing here")).toBeNull()
    expect(extractProviderDetailMarker("nothing here")).toBeNull()
    expect(formatProviderResponseMarkers({ status_code: null, detail: null })).toBe("")
  })

  it("odrzuca status spoza zakresu HTTP", () => {
    expect(formatProviderResponseMarkers({ status_code: 42, detail: null })).toBe("")
    expect(formatProviderResponseMarkers({ status_code: 999, detail: null })).toBe("")
  })
})

describe("BrevoAdapter — realna odpowiedź 401 z żywego zakupu", () => {
  const intent: NotificationIntent = {
    flow_id: "voucher_purchase_delivery",
    template_key: "voucher_purchase_confirmation",
    channel: "email",
    locale: "pl",
    consent_basis: "transactional",
    idempotency_key: "voucher-delivery:test",
    recipient: { email: "klientka@example.com", market_id: "bonbeauty" },
    variables: {},
  } as unknown as NotificationIntent

  function adapterRejectingWith(error: unknown): BrevoAdapter {
    return new BrevoAdapter(
      {
        async sendTransacEmail() {
          throw error
        },
      },
      {
        senders: { bonbeauty: { email: "no-reply@example.com", name: "GP" } },
        templates: { voucher_purchase_confirmation: 42 },
      },
    )
  }

  it("niesie kod klasy błędu ORAZ zredagowaną przyczynę", async () => {
    const httpError = Object.assign(
      new Error("Brevo API returned an error response"),
      { status: 401, body: LIVE_BREVO_401_BODY },
    )

    const rejection = await adapterRejectingWith(httpError)
      .send(intent)
      .then(
        () => null,
        (error: unknown) => error as MessagingProviderError,
      )

    expect(rejection).toBeInstanceOf(MessagingProviderError)
    // 1. Klasa błędu przestaje ginąć przez małe litery w `body.code`.
    expect(rejection!.error_code).toBe("BREVO_UNAUTHORIZED")
    expect(rejection!.status_code).toBe(401)
    // 2. Przyczyna jest przenoszona — i jest ZREDAGOWANA.
    expect(rejection!.provider_detail).toContain("unrecognised IP address")
    expect(rejection!.provider_detail).not.toContain("37.31.141.48")
    // 3. Markery są w `message`, bo tylko one przeżyją drogę do subscribera.
    expect(extractProviderStatusMarker(rejection!.message)).toBe(401)
    expect(extractProviderDetailMarker(rejection!.message)).toBe(
      rejection!.provider_detail,
    )
    // 4. Żadne PII ani sekret nie wyciekają do komunikatu wyjątku.
    expect(rejection!.message).not.toContain("klientka@example.com")
    expect(rejection!.message).not.toContain("37.31.141.48")
  })

  it("dla porażki bez odpowiedzi HTTP nie zmyśla statusu", async () => {
    const rejection = await adapterRejectingWith(
      new MessagingProviderError("Brevo API key is not configured", {
        error_code: "BREVO_API_KEY_NOT_CONFIGURED",
        preflight: true,
      }),
    )
      .send(intent)
      .then(
        () => null,
        (error: unknown) => error as MessagingProviderError,
      )

    expect(rejection!.error_code).toBe("BREVO_API_KEY_NOT_CONFIGURED")
    expect(rejection!.status_code).toBeUndefined()
    expect(extractProviderStatusMarker(rejection!.message)).toBeNull()
  })
})
