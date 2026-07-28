/**
 * stripe-payment-intent-metadata-stamp.ts — Story 5.1 AC4 (v1.14.0), decyzja PO
 * 2026-07-28 **wariant A** (uzupełnienie wariantu B).
 *
 * Gdy `order_id`/`market_id` zostały wyliczone z powiązania płatność→zamówienie,
 * stemplujemy je do `payment_intent.metadata`, żeby KOLEJNE zdarzenia tego
 * PaymentIntenta niosły te fakty wprost — bez zapytań do bazy i bez zależności
 * od tego, czy link nadal istnieje.
 *
 * ── To jest best-effort i musi takie zostać ─────────────────────────────────
 * Ścieżką GŁÓWNĄ jest wariant B (rozwiązanie po linku). Stempel jest wyłącznie
 * przyspieszeniem. Awaria zapisu do Stripe'a (brak klucza, rynek poza
 * `STRIPE_ENABLED_MARKETS`, timeout sieci, brak pakietu SDK) NIE MOŻE wywrócić
 * ani webhooka, ani checkoutu — voucher jest już wtedy wystawiony albo w drodze.
 * Dlatego każda ścieżka błędu kończy się `warn` i `false`, nigdy wyjątkiem.
 *
 * Wołamy PO udanej emisji: stempel nie jest warunkiem issuance, a wołany
 * wcześniej dokładałby opóźnienie sieciowe przed jedynym istotnym side-effectem.
 */
import { EnvSecretsAdapter } from "../secrets/env-adapter"
import { createMarketStripeResolver } from "../secrets/market-resolver"

type StampLogger = {
  info?: (message: string) => void
  warn?: (message: string) => void
}

export type StampPaymentIntentInput = {
  payment_intent_id: string
  order_id: string
  market_id: string
  logger?: StampLogger
}

/**
 * Dopisuje `order_id` + `market_id` do metadata PaymentIntenta.
 *
 * Stripe **scala** metadata przy `update` (klucze nieprzekazane zostają), więc
 * `session_id` ustawiony przez checkout przeżywa — to celowe: nie chcemy zerwać
 * powiązania, po którym rozwiązujemy zdarzenie w wariancie B.
 *
 * Zwraca `true` tylko przy potwierdzonym zapisie.
 */
export async function stampPaymentIntentOrderFacts(
  input: StampPaymentIntentInput
): Promise<boolean> {
  const { payment_intent_id: paymentIntentId, order_id, market_id, logger } = input

  try {
    const resolveKey = createMarketStripeResolver(new EnvSecretsAdapter())
    const apiKey = await resolveKey(market_id, "secret")

    const stripe = createStripeClient(apiKey)
    if (!stripe) {
      logger?.warn?.(
        `[stripe/payment-intent] stempel metadata pominięty dla ${paymentIntentId}: ` +
          "SDK Stripe niedostępne (ścieżka główna B działa dalej)"
      )
      return false
    }

    await stripe.paymentIntents.update(paymentIntentId, {
      metadata: { order_id, market_id },
    })
    logger?.info?.(
      `[stripe/payment-intent] metadata ostemplowane order=${order_id} ` +
        `market=${market_id} payment_intent=${paymentIntentId}`
    )
    return true
  } catch (err) {
    // Best-effort z definicji: rynek poza STRIPE_ENABLED_MARKETS, brak sekretu,
    // błąd sieci. Głośno, ale bez wpływu na wynik webhooka.
    logger?.warn?.(
      `[stripe/payment-intent] stempel metadata nieudany dla ${paymentIntentId} ` +
        `(order=${order_id}, market=${market_id}): ${(err as Error).message} — ` +
        "ścieżka główna (rozwiązanie po linku) pozostaje sprawna"
    )
    return false
  }
}

type StripeLike = {
  paymentIntents: {
    update: (id: string, params: { metadata: Record<string, string> }) => Promise<unknown>
  }
}

/**
 * `require` leniwy — dokładnie ten sam wzorzec, którym provider
 * `payment-stripe-multi-market` ładuje SDK. Pakiet przychodzi tranzytywnie
 * z `@medusajs/payment-stripe`, więc twardy import na górze pliku wiązałby
 * ścieżkę webhooka z obecnością zależności, której ten moduł nie deklaruje.
 */
function createStripeClient(apiKey: string): StripeLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("stripe")
    const StripeCtor = mod.default || mod
    return new StripeCtor(apiKey) as StripeLike
  } catch {
    return null
  }
}
