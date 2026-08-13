/**
 * activate-issued-entitlement.ts — podniesienie ISSUED → ACTIVE po wystawieniu
 * Path Y, w TEJ SAMEJ transakcji co wystawienie.
 *
 * ── Dlaczego ten krok w ogóle istnieje ──────────────────────────────────────
 * `on-order-placed-stripe-retry.ts` obsługuje JEDEN scenariusz — `payment.captured`
 * i `order.placed` OBA już zaszły — a wybiera gałąź wyłącznie po wartości
 * `webhook_event_processed.provider`. Gałąź natywna woła
 * `issueEntitlementsForAllLineItems`, która tworzy wiersz OD RAZU w ACTIVE
 * (ADR-099a: ISSUED jest tam konceptualny). Gałąź Path Y woła
 * `liveIssueEntitlementsWithinTx`, której GRANICĄ jest ISSUED (E3: „issue ≠
 * posting" — okablowanie L4 należy do callera). Bez tego kroku ten sam zakup
 * kończył w RÓŻNYM stanie terminalnym zależnie od tego, które pokolenie webhooka
 * zostawiło ślad, a `redeem-partial-entitlement.ts` przyjmuje wyłącznie
 * `{ACTIVE, REDEEMED_PARTIAL}` — wariant Path Y dawał więc voucher NIEMOŻLIWY
 * do wykorzystania.
 *
 * ZMIERZONE na `gp_mercur` 2026-08-13: wszystkie 3 entitlementy z zakupów tego
 * dnia stały w ISSUED, `POST /vendor/vouchers/<kod>/redeem` → 422, a dziennik
 * tranzycji nie miał po `__genesis__ → ISSUED` ŻADNEJ krawędzi dalej.
 *
 * ── Czego ten plik NIE rozstrzyga ───────────────────────────────────────────
 * Magic-link claim (`/v1/entitlements/claim`, ADR-138) domyka handoff do OBCEGO
 * odbiorcy i pozostaje jedyną drogą dla linku z maila. Tutaj aktywujemy odzysk
 * zakupu, który w gałęzi natywnej NIGDY claimu nie wymagał. Pytanie „które
 * ścieżki wystawienia mają wymagać claimu" jest szersze niż ten regres i idzie
 * osobno do PO.
 *
 * ── Dlaczego w `modules/voucher/**` ─────────────────────────────────────────
 * `specs/contracts/redemption/redemption-producers.v2.yaml` czyni moduł vouchera
 * JEDYNYM producentem zapisów do `entitlement_instance` (ADR-178 §2.1, zawężenie
 * do `entitlement-transition-wiring.ts` z terminem v1.16.0). Subscriber woła tę
 * funkcję, ale sam SQL-a nie pisze — inaczej `validate_redemption_producers.py`
 * ma rację, że rejestr producentów przestaje opisywać rzeczywistość.
 */

/** Minimalny kontrakt klienta PG w obrębie transakcji callera. */
export type ActivateEntitlementPgClient = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>
  ) => Promise<{ rows: T[]; rowCount?: number | null }>
}

/**
 * Podnosi JEDEN wiersz `entitlement_instance` z ISSUED do ACTIVE.
 *
 * Guard `AND state = 'ISSUED'` czyni krok idempotentnym: powtórka `order.placed`
 * po wcześniejszej redempcji nie cofa stanu — `RETURNING` zwraca 0 wierszy,
 * funkcja `false`, a caller NIE emituje wtedy krawędzi ISSUED → ACTIVE (event
 * bez zmiany stanu byłby fałszywym śladem w dzienniku tranzycji).
 */
export async function activateIssuedEntitlement(
  client: ActivateEntitlementPgClient,
  entitlementId: string
): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `UPDATE entitlement_instance
        SET state = 'ACTIVE', updated_at = NOW()
      WHERE id = $1
        AND state = 'ISSUED'
      RETURNING id`,
    [entitlementId]
  )
  return result.rows.length > 0
}
