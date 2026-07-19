/**
 * middlewares-config.unit.test.ts — Story 5.1 (FR-10) FINDING-1 regression.
 *
 * Bez `bodyParser: { preserveRawBody: true }` na matcherze
 * `/webhooks/stripe/payment-intent`, `route.ts` (`readRawBody`) dostaje
 * sparsowane body zamiast surowych bajtów i fail-closed odrzuca KAŻDY realny
 * webhook Stripe z 400 `raw_body_unavailable` — niezależnie od poprawności
 * sekretu/sygnatury (zweryfikowane w code review 5-1-F1).
 *
 * Ten test sprawdza realny obiekt zwrócony przez `defineMiddlewares()`
 * (dokładnie ten, który Medusa HTTP loader konsumuje do konfiguracji
 * body-parsera na routerze) — NIE ręcznie wstrzykuje `rawBody` do requestu.
 *
 * Ograniczenie: to nie jest pełny end-to-end dowód, że Express/Medusa
 * middleware stack faktycznie ustawia `req.rawBody` w runtime (wymagałoby
 * to żywego serwera HTTP — poza zakresem unit testu). Dowodem end-to-end
 * jest AC4 tej story (`scripts/stripe-webhook-smoke.sh`, weryfikacja na
 * żywym stacku) — pozostaje VERIFY-ON-STACK.
 */
import { describe, it, expect } from "@jest/globals"

import middlewaresConfig from "../../../../middlewares"

describe("Story 5.1 FINDING-1 — /webhooks/stripe/payment-intent ma preserveRawBody", () => {
  it("konfiguracja routes zawiera matcher z bodyParser.preserveRawBody=true", () => {
    const route = middlewaresConfig.routes?.find(
      (r) => r.matcher === "/webhooks/stripe/payment-intent"
    )
    expect(route).toBeDefined()
    expect(route?.bodyParser?.preserveRawBody).toBe(true)
    expect(route?.methods).toContain("POST")
  })

  it("wzorzec Brevo (referencyjny) też ma preserveRawBody — potwierdza spójność wzorca", () => {
    const brevoRoute = middlewaresConfig.routes?.find(
      (r) => typeof r.matcher !== "string" || r.matcher.includes("brevo")
    )
    expect(brevoRoute?.bodyParser?.preserveRawBody).toBe(true)
  })
})
