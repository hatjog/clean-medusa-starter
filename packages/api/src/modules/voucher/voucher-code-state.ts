/**
 * voucher-code-state.ts — JEDYNY producent stanu kodu vouchera
 * (`UPDATE voucher SET status`), v1.15.0 Story 5.9 (FR-12, AD-17, SM-7).
 *
 * ── Po co osobny plik ───────────────────────────────────────────────────────
 * Do tej story stan kodu vouchera przestawiały DWA miejsca, i to w dwóch
 * różnych granicach transakcyjnych:
 *
 *   (1) `service.ts` — `claim()` i `redeemForSeller()` piszą `status='claimed'`
 *       pod row-lockiem, w transakcji realizacji;
 *   (2) `jobs/entitlement-expiry-sweeper.ts` — bulk `UPDATE voucher SET
 *       status='expired' WHERE status IN ('idle','consent_pending')`, wykonany
 *       JEDNYM zapytaniem PO pętli wygaszania uprawnień, czyli poza transakcją
 *       którejkolwiek tranzycji uprawnienia.
 *
 * Zapisu przy zwrocie nie było wcale: `workflows/refund-entitlement.ts` pisał
 * `entitlement_instance` i `voucher_event`, a wiersza `voucher` nie dotykał —
 * kod zwróconego vouchera zostawał `idle`/`consent_pending` i przechodził
 * realizację. To jest defekt, który 5.9 zamyka.
 *
 * Ten plik jest odpowiedzią na obie połowy problemu naraz: JEDEN producent
 * (kontrakt `specs/contracts/redemption/redemption-producers.v1.yaml`, tabela
 * `voucher`) i zapis WYŁĄCZNIE na `client`-cie wołającego, czyli w JEGO
 * transakcji (AD-17, atomowość jako własność transakcji, nie obietnica
 * w komentarzu).
 *
 * ── Kontrakt szwu `client` ──────────────────────────────────────────────────
 * Żadna funkcja w tym pliku NIE otwiera własnego połączenia ani transakcji:
 * nie ma tu `pool.connect()`, `BEGIN`, `COMMIT` ani `ROLLBACK`. Wołający podaje
 * swój `client`, więc zapis stanu kodu leży w tej samej DB-tx, co zmiana stanu
 * uprawnienia — rollback wołającego cofa OBA wiersze. Bramka
 * `_grow/tools/validate_voucher_code_invalidation.py` sprawdza ten szew
 * statycznie (człon „producent nie otwiera własnej transakcji").
 *
 * ── Mapowanie unieważnień pochodzi z kontraktu, nie z pomysłu autora ─────────
 * `INVALIDATING_ENTITLEMENT_STATE_TO_VOUCHER_STATUS` jest LUSTREM sekcji
 * `invalidating_transitions` w
 * `specs/contracts/redemption/voucher-state-vocabulary.v1.yaml`. Rozjazd
 * w którąkolwiek stronę czerwieni bramkę — dzięki temu dopisanie stanu
 * unieważniającego do słownika BEZ producenta stanu kodu jest błędem bramki,
 * a nie cichym niczym (dokładnie tak przeszłoby niezauważone `'expired'`
 * dołożone do CHECK-a w v1.11.0).
 */

import { EntitlementInstanceState } from "./models/entitlement"
import type { VoucherStatus } from "./models/types"

/** Minimalny kształt klienta — ten sam, którego używają `service.ts` i workflowy. */
export type VoucherCodeStateClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>
  ): Promise<{ rows: T[]; rowCount?: number | null }>
}

/**
 * Stan uprawnienia unieważniający uprawnienie → stan kodu vouchera.
 *
 * LUSTRO `invalidating_transitions.map` z kontraktu słownika. NIE dopisuj tu
 * pozycji bez dopisania jej w kontrakcie (i odwrotnie) — bramka porównuje obie
 * strony i czerwieni się na rozjeździe w KAŻDĄ stronę.
 */
export const INVALIDATING_ENTITLEMENT_STATE_TO_VOUCHER_STATUS: Readonly<
  Partial<Record<EntitlementInstanceState, VoucherStatus>>
> = {
  [EntitlementInstanceState.REFUNDED]: "refunded",
  [EntitlementInstanceState.EXPIRED]: "expired",
  [EntitlementInstanceState.VOIDED]: "withdrawn",
}

/** Zbiór stanów unieważniających — DERYWOWANY z mapy, nie wypisany drugi raz. */
export const INVALIDATING_ENTITLEMENT_STATES: ReadonlySet<EntitlementInstanceState> =
  new Set(
    Object.keys(INVALIDATING_ENTITLEMENT_STATE_TO_VOUCHER_STATUS) as
      EntitlementInstanceState[]
  )

export function isInvalidatingEntitlementState(
  state: EntitlementInstanceState
): boolean {
  return INVALIDATING_ENTITLEMENT_STATES.has(state)
}

/**
 * Stany kodu, z których przejście na stan unieważniający jest legalne.
 *
 * ALLOW-LISTA, nie negacja (AD-17). `claimed` jest tu ŚWIADOMIE: voucher
 * zrealizowany też może zostać zwrócony (zwrot po realizacji jest ścieżką
 * mechanizmu (b) w `refund-entitlement.ts`), a kod ma wtedy przestać działać
 * na wypadek kolejnej próby. Stany unieważnione (`refunded`, `expired`,
 * `withdrawn`) NIE są tu wymienione — przejście z nich jest obsługiwane
 * osobno jako idempotencja albo odmowa, patrz `invalidateVoucherCode`.
 */
export const CODE_INVALIDATION_SOURCE_STATES: ReadonlySet<VoucherStatus> =
  new Set<VoucherStatus>(["idle", "consent_pending", "claimed"])

/** Wynik operacji unieważnienia — rozłączny, bez cichego „nic się nie stało". */
export type VoucherCodeInvalidationOutcome =
  /** Stan kodu przestawiony w TEJ transakcji. */
  | "invalidated"
  /** Kod był już w docelowym stanie unieważnionym — powtórzenie = no-op. */
  | "already_invalidated"
  /**
   * Uprawnienie nie jest wsparte kodem vouchera (`policy_snapshot` bez
   * `voucher_code`) i jego typ tego nie wymaga. To NIE jest cichy no-op:
   * wynik jest zwracany, nazwany i asertowany w testach.
   */
  | "no_voucher_code"

export type VoucherCodeInvalidationResult = {
  outcome: VoucherCodeInvalidationOutcome
  entitlement_id: string
  voucher_code: string | null
  /** Stan kodu SPRZED operacji (null gdy brak kodu). */
  prior_status: VoucherStatus | null
  /** Docelowy stan kodu wyprowadzony z kontraktu. */
  target_status: VoucherStatus
}

/**
 * Stan uprawnienia, dla którego kontrakt nie deklaruje stanu kodu — wołający
 * pomylił punkt wpięcia. Fail-closed PRZED jakimkolwiek zapisem.
 */
export class NotAnInvalidatingStateError extends Error {
  readonly state: EntitlementInstanceState
  constructor(state: EntitlementInstanceState) {
    super(
      `invalidateVoucherCode: stan uprawnienia ${state} nie jest stanem ` +
        "unieważniającym w kontrakcie voucher-state-vocabulary.v1 " +
        `(dozwolone: ${[...INVALIDATING_ENTITLEMENT_STATES].join(", ")})`
    )
    this.name = "NotAnInvalidatingStateError"
    this.state = state
  }
}

/**
 * Most kod → uprawnienie nie zadziałał: `policy_snapshot->>'voucher_code'`
 * wskazuje kod, którego w tabeli `voucher` nie ma, ALBO uprawnienie typu
 * voucherowego nie ma kodu w snapshotcie.
 *
 * FAIL-CLOSED z nazwanym powodem, nigdy cichy no-op: gdyby brak mostu kończył
 * się przejściem uprawnienia bez przejścia kodu, wróciłby dokładnie ten defekt,
 * który ta story usuwa — tyle że pod inną nazwą.
 */
export class VoucherCodeBridgeMissingError extends Error {
  readonly entitlement_id: string
  readonly voucher_code: string | null
  constructor(entitlementId: string, voucherCode: string | null, why: string) {
    super(
      `invalidateVoucherCode: most kod → uprawnienie nie zadziałał dla ` +
        `entitlement_id=${entitlementId} (voucher_code=${voucherCode ?? "brak"}): ${why}`
    )
    this.name = "VoucherCodeBridgeMissingError"
    this.entitlement_id = entitlementId
    this.voucher_code = voucherCode
  }
}

/** Kod jest w stanie, z którego unieważnienie nie jest legalne (allow-lista). */
export class VoucherCodeNotInvalidatableError extends Error {
  readonly voucher_code: string
  readonly status: VoucherStatus
  constructor(code: string, status: VoucherStatus, target: VoucherStatus) {
    super(
      `invalidateVoucherCode: kod ${code} jest w stanie '${status}', z którego ` +
        `przejście na '${target}' nie jest na allow-liście ` +
        `(${[...CODE_INVALIDATION_SOURCE_STATES].join(", ")})`
    )
    this.name = "VoucherCodeNotInvalidatableError"
    this.voucher_code = code
    this.status = status
  }
}

/** Typy uprawnień, dla których BRAK kodu vouchera jest błędem, nie stanem. */
const VOUCHER_BACKED_ENTITLEMENT_TYPES: ReadonlySet<string> = new Set([
  "VOUCHER_AMOUNT",
  "VOUCHER_SERVICE",
])

/**
 * REGUŁA unieważnienia — czysta, bez IO. Jedno źródło rozstrzygnięcia dla
 * producenta PG i dla stores in-memory używanych w testach: mirror semantyki
 * pisany drugi raz rozjeżdża się cicho, a wtedy zielony test jednostkowy
 * przestaje mówić cokolwiek o zachowaniu produkcyjnym.
 *
 * `current_status === null` znaczy „wiersza `voucher` nie ma" (most wskazuje
 * kod nieistniejący) — fail-closed, nie no-op.
 */
export function decideVoucherCodeInvalidation(input: {
  entitlement_id: string
  entitlement_type: string | null
  voucher_code: string | null
  current_status: VoucherStatus | null
  to_state: EntitlementInstanceState
}): VoucherCodeInvalidationResult {
  const target = INVALIDATING_ENTITLEMENT_STATE_TO_VOUCHER_STATUS[input.to_state]
  if (!target) {
    throw new NotAnInvalidatingStateError(input.to_state)
  }

  const code = (input.voucher_code ?? "").trim() || null
  if (!code) {
    const type = (input.entitlement_type ?? "").trim()
    if (VOUCHER_BACKED_ENTITLEMENT_TYPES.has(type)) {
      throw new VoucherCodeBridgeMissingError(
        input.entitlement_id,
        null,
        `uprawnienie typu ${type} nie ma 'voucher_code' w policy_snapshot — ` +
          "kodu do unieważnienia nie da się wskazać"
      )
    }
    // Uprawnienie niewspierane kodem (np. CREDIT_PACK/BUNDLE) — wynik NAZWANY.
    return {
      outcome: "no_voucher_code",
      entitlement_id: input.entitlement_id,
      voucher_code: null,
      prior_status: null,
      target_status: target,
    }
  }

  if (input.current_status === null) {
    throw new VoucherCodeBridgeMissingError(
      input.entitlement_id,
      code,
      "policy_snapshot wskazuje kod, którego nie ma w tabeli voucher"
    )
  }

  // Idempotencja — powtórzenie tej samej operacji jest no-opem, nie błędem.
  if (input.current_status === target) {
    return {
      outcome: "already_invalidated",
      entitlement_id: input.entitlement_id,
      voucher_code: code,
      prior_status: input.current_status,
      target_status: target,
    }
  }

  // Allow-lista stanów źródłowych — fail-closed PRZED efektem.
  if (!CODE_INVALIDATION_SOURCE_STATES.has(input.current_status)) {
    throw new VoucherCodeNotInvalidatableError(code, input.current_status, target)
  }

  return {
    outcome: "invalidated",
    entitlement_id: input.entitlement_id,
    voucher_code: code,
    prior_status: input.current_status,
    target_status: target,
  }
}

/**
 * Unieważnia kod vouchera powiązany z uprawnieniem — W TRANSAKCJI WOŁAJĄCEGO.
 *
 * Kolejność jest istotna i jest częścią kontraktu:
 *   1. rezolucja mostu (`policy_snapshot->>'voucher_code'`) — most jest
 *      produktem Story 5.7 (indeks wyrażeniowy `idx_entitlement_instance_voucher_code`);
 *   2. `SELECT … FOR UPDATE` na wierszu `voucher` — bez tego dwa równoległe
 *      unieważnienia mogłyby zobaczyć ten sam stan wejściowy;
 *   3. idempotencja: kod już w stanie docelowym ⇒ no-op z nazwanym wynikiem;
 *   4. allow-lista stanów źródłowych ⇒ fail-closed PRZED zapisem;
 *   5. `UPDATE` — jedyny w całym repozytorium producent `UPDATE voucher SET status`
 *      dla przejść unieważniających.
 */
export async function invalidateVoucherCode(
  client: VoucherCodeStateClient,
  input: {
    entitlement_id: string
    to_state: EntitlementInstanceState
    now: Date
  }
): Promise<VoucherCodeInvalidationResult> {
  // (1) Most kod → uprawnienie (5.7). Czytany w TEJ transakcji, więc widzi
  //     wiersz uprawnienia zablokowany przez wołającego.
  const bridge = await client.query<{
    voucher_code: string | null
    entitlement_type: string | null
  }>(
    `SELECT policy_snapshot->>'voucher_code' AS voucher_code,
            entitlement_type
       FROM entitlement_instance
      WHERE id = $1`,
    [input.entitlement_id]
  )
  const bridgeRow = bridge.rows[0]
  if (!bridgeRow) {
    throw new VoucherCodeBridgeMissingError(
      input.entitlement_id,
      null,
      "wiersz entitlement_instance nie istnieje (albo jest niewidoczny pod RLS " +
        "dla tego połączenia — brak kontekstu rynku)"
    )
  }
  const code = (bridgeRow.voucher_code ?? "").trim() || null

  // (2) Row-lock na kodzie — TYLKO gdy most wskazał kod. `FOR UPDATE` jest
  //     konieczny, bo bez niego dwa równoległe unieważnienia zobaczyłyby ten
  //     sam stan wejściowy.
  let priorStatus: VoucherStatus | null = null
  if (code) {
    const locked = await client.query<{ status: string }>(
      `SELECT status FROM voucher WHERE code = $1 FOR UPDATE`,
      [code]
    )
    priorStatus = (locked.rows[0]?.status as VoucherStatus | undefined) ?? null
  }

  // (3) Rozstrzygnięcie regułą (idempotencja + allow-lista + fail-closed).
  const decision = decideVoucherCodeInvalidation({
    entitlement_id: input.entitlement_id,
    entitlement_type: bridgeRow.entitlement_type,
    voucher_code: code,
    current_status: priorStatus,
    to_state: input.to_state,
  })
  if (decision.outcome !== "invalidated") {
    return decision
  }

  // (4) JEDYNY producent stanu kodu dla przejść unieważniających.
  const upd = await client.query(
    `UPDATE voucher SET status = $2, updated_at = $3 WHERE code = $1 AND status = $4`,
    [decision.voucher_code, decision.target_status, input.now, decision.prior_status]
  )
  if ((upd.rowCount ?? 0) !== 1) {
    // Row-lock trzymamy od kroku (2), więc zero wierszy oznacza rozjazd
    // stanu, nie wyścig — fail-closed zamiast cichego pominięcia.
    throw new VoucherCodeBridgeMissingError(
      input.entitlement_id,
      decision.voucher_code,
      `UPDATE voucher (${decision.prior_status}→${decision.target_status}) ` +
        `objął ${upd.rowCount ?? 0} wierszy zamiast 1`
    )
  }

  return decision
}

/**
 * Przejście kodu na `claimed` (realizacja) — TEN SAM producent, ta sama zasada
 * `client`-a wołającego.
 *
 * Wydzielone z `service.ts` w 5.9 wyłącznie po to, żeby zapis `voucher.status`
 * miał JEDEN nośnik. Zachowanie jest niezmienione: warunek `status IN (…)`
 * jest generowany z allow-listy `VOUCHER_REDEMPTION_INPUT_STATES` (5.8) i
 * przekazywany przez wołającego, żeby ten plik nie stał się drugą kopią
 * allow-listy realizacji.
 */
export async function claimVoucherCode(
  client: VoucherCodeStateClient,
  input: {
    code: string
    /** Klauzula `status IN (…)` wygenerowana z allow-listy 5.8. */
    inputStatusInClause: string
    /** Zawężenie do najemcy (`redeemForSeller`); `null` dla ścieżki `claim()`. */
    seller_id?: string | null
  }
): Promise<number> {
  const params: unknown[] = [input.code]
  let sellerPredicate = ""
  if (input.seller_id != null) {
    params.push(input.seller_id)
    sellerPredicate = ` AND seller_id = $${params.length}`
  }
  const res = await client.query(
    `UPDATE voucher SET status = 'claimed', updated_at = NOW()
      WHERE code = $1${sellerPredicate} AND ${input.inputStatusInClause}`,
    params
  )
  return res.rowCount ?? 0
}
