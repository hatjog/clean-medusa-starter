/**
 * notification-body-vars.ts — MASZYNOWO CZYTELNY kontrakt zmiennych body
 * emitowanych przez buildery payloadu (Story 5.7, AC5).
 *
 * ── Po co osobny, jawny kontrakt ────────────────────────────────────────────
 * Realny incydent 5.3: szablon handoffu czytał `handoff_url`, a payload niósł
 * `claim_url`. Nazwy nikt nie porównywał, więc przycisk „Otwórz voucher" miał
 * pusty `href`, a wysyłka i tak kończyła się `ledger=sent`. Zielone testy tego
 * nie złapały, bo testowały kształt payloadu wobec SIEBIE, nie wobec manifestu.
 *
 * Ten plik jest jedynym miejscem, w którym lista `body_vars` żyje po stronie
 * kodu. Czytają go trzy niezależne konsumenty:
 *   1. buildery (`handoff-link-intent`, `purchase-confirmation-intent`) —
 *      walidują, że KAŻDA zadeklarowana zmienna ma niepustą wartość,
 *   2. test TypeScript — porównuje kontrakt z rzeczywistym
 *      `Object.keys(notification.data)`,
 *   3. walidator repo `_grow/tools/validate_notification_payload_contract.py`
 *      — zestawia kontrakt z `body_vars` manifestów wszystkich locale.
 *
 * Dlatego kształt tego pliku jest CELOWO prosty (tablice literałów `as const`
 * + mapa `template_key -> tablica`): walidator repo parsuje go statycznie i
 * nie potrzebuje uruchamiać TypeScriptu. Zmiana kształtu na dynamiczny
 * (spread, computed keys, budowanie w runtime) rozbroi warstwę (3).
 */

/** Wymagane zmienne body manifestu `voucher_handoff_link` (wszystkie locale). */
export const VOUCHER_HANDOFF_LINK_BODY_VARS = [
  "customer_first_name",
  "handoff_url",
  "market_url",
  "salon_address",
  "salon_name",
  "support_email",
  "voucher_code",
  "voucher_expires_at",
] as const

/** Wymagane zmienne body manifestu `voucher_purchase_confirmation`. */
export const VOUCHER_PURCHASE_CONFIRMATION_BODY_VARS = [
  "customer_first_name",
  "market_url",
  "order_id",
  "purchase_date",
  "salon_address",
  "salon_name",
  "salon_url",
  "support_email",
  "voucher_code",
  "voucher_currency",
  "voucher_expires_at",
  "voucher_pdf_url",
  "voucher_value",
] as const

/**
 * Kontrakt per `template_key` rejestru AD-6. Klucze MUSZĄ być literałami
 * zgodnymi z `specs/contracts/notifications/templates.yaml` — walidator repo
 * dopasowuje je po nazwie.
 */
export const NOTIFICATION_BODY_VAR_CONTRACT: Readonly<
  Record<string, readonly string[]>
> = {
  voucher_handoff_link: VOUCHER_HANDOFF_LINK_BODY_VARS,
  voucher_purchase_confirmation: VOUCHER_PURCHASE_CONFIRMATION_BODY_VARS,
}

/**
 * Payload nie pokrywa kontraktu szablonu — wysyłka NIE może dojść do skutku.
 *
 * Kod błędu jest stabilny i testowalny; komunikat niesie WYŁĄCZNIE nazwy
 * brakujących zmiennych, nigdy ich wartości (te bywają PII).
 */
export class NotificationBodyVarsIncompleteError extends Error {
  readonly error_code = "VOUCHER_DELIVERY_PAYLOAD_INCOMPLETE"
  readonly template_key: string
  readonly missing_vars: string[]

  constructor(templateKey: string, missingVars: string[]) {
    super(
      `[voucher-delivery] payload '${templateKey}' nie pokrywa kontraktu szablonu — ` +
        `brakujące/puste zmienne: ${missingVars.join(", ")}`,
    )
    this.name = "NotificationBodyVarsIncompleteError"
    this.template_key = templateKey
    this.missing_vars = missingVars
  }
}

/**
 * Fail-loud kontraktu: każda zadeklarowana zmienna musi mieć niepustą wartość
 * tekstową. Pusty string, sam whitespace, `null`/`undefined` i wartość
 * nietekstowa (surowe minor units, obiekt `Date`) są traktowane jednakowo —
 * jako brak pokrycia. Formatowanie należy do buildera, nie do szablonu.
 */
export function assertBodyVarsCovered(
  templateKey: string,
  requiredVars: readonly string[],
  data: Record<string, unknown>,
): void {
  const missing = requiredVars.filter((name) => {
    const value = data[name]
    return typeof value !== "string" || value.trim().length === 0
  })

  if (missing.length > 0) {
    throw new NotificationBodyVarsIncompleteError(templateKey, missing)
  }
}
