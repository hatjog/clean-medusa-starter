/**
 * stripe-payment-intent-link.ts — Story 5.1 AC4 (v1.14.0) — rozwiązanie
 * `order_id` + `market_id` dla webhooka Path Y, gdy metadata PaymentIntenta
 * ich NIE niesie.
 *
 * ── Dlaczego to istnieje (zmierzony defekt, nie hipoteza) ───────────────────
 * Realny zakup 2026-07-28 (`order_01KYMN7XQX06FKHSWFT0QV2NNY`, PI
 * `pi_3TyCqiHG9Rf5NslT0vAfkVtW`, `succeeded`, 250 PLN) zakończył się
 * `webhook_event_processed = 0`, `event_processed = 0`, `entitlement_instance = 0`:
 * klientka zapłaciła, zobaczyła potwierdzenie i NIE dostała vouchera.
 *
 * Przyczyna: metadata PaymentIntenta niesie WYŁĄCZNIE
 * `{ session_id: "payses_..." }`, bo **sesja płatności powstaje zanim zamówienie
 * zaczyna istnieć**. `buildPaymentIntentSucceededEnvelope` wymagał `order_id`
 * i `market_id` wprost z metadata i rzucał `StripeEventMappingError` ⇒ HTTP 400
 * ⇒ zero emisji ⇒ urwany łańcuch issuance.
 *
 * Powiązanie JEST w bazie i to ono jest tu źródłem prawdy:
 *
 *   payment_session(payses_…)  →  payment_collection
 *                              →  order_payment_collection  →  order
 *
 * ── Kontrakt zdarzenia NIENARUSZONY ─────────────────────────────────────────
 * `gp.stripe.payment_intent_succeeded.v1` wymaga, żeby payload ZAWIERAŁ
 * `order_id`/`market_id` — nie narzuca, że pochodzą z `payment_intent.metadata`.
 * Ten moduł rozwiązuje je PRZED zbudowaniem koperty; schemat i walidacja NFR4
 * zostają bez zmian.
 *
 * ── Zasada twarda: NIE ZGADUJEMY RYNKU ──────────────────────────────────────
 * `market_id` pochodzi z danych domenowych zamówienia albo z mapy
 * `sales_channel.metadata->>'gp_market_id'` (ta sama mapa, którą trzyma
 * `loaders/market-context-cache.ts` i którą stosuje `gp-config-sync-*`).
 * Gdy oba źródła milczą — ODRZUCAMY zdarzenie z czytelnym powodem.
 * Gdy oba mówią co innego — ODRZUCAMY jako niejednoznaczne. Cicha podmiana
 * rynku jest gorsza niż 400: wystawiłaby voucher na cudzym rynku, z cudzym
 * nadawcą i cudzym audytem, wyglądając przy tym na sukces.
 *
 * Kolejność `order.metadata` → `sales_channel` jest CELOWO taka sama jak
 * w rdzeniu issuance (`live-issue-from-payment-intent.ts`), żeby `scope.market_id`
 * z koperty nigdy nie rozjechał się z tym, co rdzeń policzyłby samodzielnie.
 */

/** Minimalny kontrakt klienta PG (spójny z rdzeniem live-issue). */
export type PaymentLinkQueryClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => Promise<{ rows: T[]; rowCount?: number | null }>
}

/**
 * Klasy odrzucenia — ROZŁĄCZNE, bo operator ma z nich odczytać, czy patrzy na
 * defekt transportu, danych, czy konfiguracji (Story 5.1 AC4, wymaganie 3).
 *
 *  - `link_unresolved`  — brak `order_id` w metadata i brak linku w bazie
 *                         (sesja nieznana / nigdy nie doszło do zamówienia) → DANE
 *  - `link_ambiguous`   — link wskazuje >1 różnych zamówień → DANE (anomalia)
 *  - `order_not_found`  — `order_id` znane, ale zamówienia nie ma → DANE
 *  - `market_unresolved`— zamówienie jest, ale rynku nie da się przypisać → KONFIG
 *  - `market_ambiguous` — `order.metadata` i `sales_channel` wskazują różne rynki → KONFIG
 */
export type PaymentIntentLinkRejectionReason =
  | "link_unresolved"
  | "link_ambiguous"
  | "order_not_found"
  | "market_unresolved"
  | "market_ambiguous"

/** Skąd faktycznie wzięliśmy każdy komponent — do logu i audytu operatora. */
export type PaymentIntentLinkSource = {
  order_id: "metadata" | "payment_session_link"
  market_id: "metadata" | "order_metadata" | "sales_channel"
}

export type PaymentIntentLinkResolution =
  | {
      ok: true
      order_id: string
      market_id: string
      source: PaymentIntentLinkSource
    }
  | {
      ok: false
      reason: PaymentIntentLinkRejectionReason
      detail: string
    }

/** Wskazówki odczytane z faktu Stripe (metadata + id PaymentIntenta). */
export type PaymentIntentLinkHints = {
  payment_intent_id: string
  /** `metadata.order_id` / `gp_order_id`, gdy jest. */
  order_id?: string | null
  /** `metadata.market_id` / `gp_market_id`, gdy jest. */
  market_id?: string | null
  /** `metadata.session_id` — jedyne, co realnie niesie sesja checkoutu. */
  session_id?: string | null
}

/**
 * `order_id` po istniejącym linku płatności. Dopasowujemy sesję po jej ID
 * (`metadata.session_id`) ALBO po identyfikatorze PaymentIntenta zapisanym
 * w `payment_session.data` — Stripe provider Medusy trzyma tam surowy obiekt PI
 * (ten sam wzorzec czyta `subscribers/stripe-payment-audit.ts`), więc zdarzenie
 * bez `session_id` też jest rozwiązywalne.
 *
 * `DISTINCT` + kontrola liczności: jedna kolekcja płatności może mieć wiele
 * sesji (retry), ale POWINNA wskazywać jedno zamówienie. Więcej niż jedno =
 * anomalia danych, nie „weź pierwsze".
 */
export const RESOLVE_ORDER_BY_PAYMENT_LINK_SQL = `
  SELECT DISTINCT opc.order_id
    FROM payment_session ps
    JOIN order_payment_collection opc
      ON opc.payment_collection_id = ps.payment_collection_id
     AND opc.deleted_at IS NULL
   WHERE ps.deleted_at IS NULL
     AND (
           ($1::text IS NOT NULL AND ps.id = $1)
        OR ($2::text IS NOT NULL AND ps.data->>'id' = $2)
        OR ($2::text IS NOT NULL AND ps.data->>'payment_intent' = $2)
     )
`

/**
 * Kontekst rynkowy zamówienia. `sales_channel.metadata->>'gp_market_id'` to ta
 * sama mapa kanał→rynek, którą ładuje `loaders/market-context-cache.ts`
 * (publishable key → sales_channel → market) — czyli SSOT przypisania rynku
 * w runtime, a nie wartość domyślna.
 */
export const RESOLVE_ORDER_MARKET_CONTEXT_SQL = `
  SELECT o.id                            AS order_id,
         o.metadata                      AS order_metadata,
         o.sales_channel_id              AS sales_channel_id,
         sc.metadata->>'gp_market_id'    AS sales_channel_market_id
    FROM "order" o
    LEFT JOIN sales_channel sc
      ON sc.id = o.sales_channel_id
     AND sc.deleted_at IS NULL
   WHERE o.id = $1
     AND o.deleted_at IS NULL
   LIMIT 1
`

type OrderMarketContextRow = {
  order_id: string | null
  order_metadata: Record<string, unknown> | null
  sales_channel_id: string | null
  sales_channel_market_id: string | null
}

/**
 * Rozwiązuje `order_id` + `market_id` dla faktu `payment_intent.succeeded`.
 *
 * Kolejność (decyzja PO 2026-07-28, wariant B):
 *   1. metadata PaymentIntenta (gdy checkout zdążył je ostemplować),
 *   2. link `payment_session → payment_collection → order_payment_collection → order`.
 *
 * `market_id` z metadata jest honorowany, ale i tak weryfikowany względem
 * zamówienia — metadata są mutowalne z zewnątrz (Stripe API), a rynek decyduje
 * o izolacji najemcy. Rozbieżność ⇒ `market_ambiguous`, nie „ufamy metadata".
 *
 * Rzuca WYŁĄCZNIE gdy zawiedzie sama baza — błąd I/O nie jest odrzuceniem
 * zdarzenia (to sytuacja do ponowienia przez Stripe, nie do 400); rozróżnienie
 * należy do wołającego.
 */
export async function resolvePaymentIntentLink(
  client: PaymentLinkQueryClient,
  hints: PaymentIntentLinkHints
): Promise<PaymentIntentLinkResolution> {
  const metadataOrderId = normalize(hints.order_id)
  const metadataMarketId = normalize(hints.market_id)
  const sessionId = normalize(hints.session_id)

  let orderId = metadataOrderId
  let orderIdSource: PaymentIntentLinkSource["order_id"] = "metadata"

  if (!orderId) {
    const linked = await client.query<{ order_id: string | null }>(
      RESOLVE_ORDER_BY_PAYMENT_LINK_SQL,
      [sessionId ?? null, hints.payment_intent_id]
    )
    const orderIds = unique(
      linked.rows.map((row) => normalize(row.order_id)).filter(isPresent)
    )
    if (orderIds.length === 0) {
      return {
        ok: false,
        reason: "link_unresolved",
        detail:
          `payment_intent ${hints.payment_intent_id} nie niesie order_id w metadata ` +
          `(metadata.session_id=${sessionId ?? "brak"}) i nie ma powiązania ` +
          "payment_session → payment_collection → order_payment_collection → order " +
          "— zdarzenie nie da się przypisać do zamówienia",
      }
    }
    if (orderIds.length > 1) {
      return {
        ok: false,
        reason: "link_ambiguous",
        detail:
          `payment_intent ${hints.payment_intent_id} wskazuje ${orderIds.length} różnych ` +
          `zamówień (${orderIds.join(", ")}) — anomalia danych; NIE wybieramy ` +
          "pierwszego z brzegu",
      }
    }
    orderId = orderIds[0]
    orderIdSource = "payment_session_link"
  }

  const contextResult = await client.query<OrderMarketContextRow>(
    RESOLVE_ORDER_MARKET_CONTEXT_SQL,
    [orderId]
  )
  const context = contextResult.rows[0]
  if (!context || !normalize(context.order_id)) {
    return {
      ok: false,
      reason: "order_not_found",
      detail:
        `order ${orderId} (źródło: ${orderIdSource}) nie istnieje albo jest usunięte ` +
        `— payment_intent ${hints.payment_intent_id} bez zamówienia do obsłużenia`,
    }
  }

  const orderMarketId =
    readNestedString(context.order_metadata, ["gp", "market_id"]) ??
    readNestedString(context.order_metadata, ["market_id"])
  const salesChannelMarketId = normalize(context.sales_channel_market_id)

  const candidates: Array<{
    value: string
    source: PaymentIntentLinkSource["market_id"]
  }> = []
  if (metadataMarketId) candidates.push({ value: metadataMarketId, source: "metadata" })
  if (orderMarketId) candidates.push({ value: orderMarketId, source: "order_metadata" })
  if (salesChannelMarketId) {
    candidates.push({ value: salesChannelMarketId, source: "sales_channel" })
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "market_unresolved",
      detail:
        `order ${orderId} nie ma market_id ani w metadata (gp.market_id / market_id), ` +
        `ani przez sales_channel ${context.sales_channel_id ?? "brak"} ` +
        "(metadata->>'gp_market_id') — rynek jest nieprzypisywalny; odrzucamy " +
        "zamiast podstawiać wartość domyślną",
    }
  }

  const distinct = unique(candidates.map((candidate) => candidate.value))
  if (distinct.length > 1) {
    return {
      ok: false,
      reason: "market_ambiguous",
      detail:
        `order ${orderId} ma sprzeczne przypisania rynku: ` +
        candidates.map((c) => `${c.source}=${c.value}`).join(", ") +
        " — cicha podmiana rynku byłaby groźniejsza niż odrzucenie",
    }
  }

  return {
    ok: true,
    order_id: orderId,
    market_id: candidates[0].value,
    source: { order_id: orderIdSource, market_id: candidates[0].source },
  }
}

function normalize(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function isPresent(value: string | null): value is string {
  return value !== null
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function readNestedString(
  source: Record<string, unknown> | null | undefined,
  path: readonly string[]
): string | null {
  let cursor: unknown = source
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return normalize(cursor)
}
