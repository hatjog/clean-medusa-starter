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

import {
  EntitlementInstanceState,
  EntitlementType,
} from "./models/entitlement"
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
 * Stany kodu, z których przejście na DANY stan unieważniający jest legalne —
 * LUSTRO `invalidating_transitions.source_states` z kontraktu słownika
 * (review-fix cyklu 2, C2-MEDIUM-4).
 *
 * ALLOW-LISTA, nie negacja (AD-17). Do tego fixu zbiór był JEDEN dla
 * wszystkich celów i zawierał `claimed` — a uzasadnienie w kodzie dotyczyło
 * WYŁĄCZNIE zwrotu („voucher zrealizowany też może zostać zwrócony"). Reguła
 * była więc szersza niż jej powód, i to w mierzalny sposób:
 *
 *   - `VoucherService.claim()` przestawia `voucher.status` na `claimed` i NIE
 *     dotyka `entitlement_instance`, więc para (kod `claimed`, uprawnienie
 *     `ACTIVE`) jest stanem NORMALNYM;
 *   - `EXPIRY_SOURCE_STATES` zawiera `ACTIVE`, a backfill 1779010000000 —
 *     dołożony w tym samym review-fixie — DOPISAŁ tym wierszom `expires_at`,
 *     czyli własnoręcznie powiększył populację wpadającą w tę gałąź;
 *   - sweeper przestawiał wtedy kod ZREALIZOWANY na `expired`, a
 *     `resolveRedeemRefusalReason` zwracał `expired`/410 zamiast
 *     `already_redeemed`/409. Dla reklamacji i raportowania to jest zapis
 *     KŁAMIĄCY o tym, co się wydarzyło.
 *
 * Usunięty w 5.9 bulk-UPDATE wykluczał `claimed` ŚWIADOMIE
 * (`WHERE status IN ('idle','consent_pending')`) — następca to wykluczenie
 * zgubił. Teraz zbiór zależy od CELU, tak jak precedencja, i pochodzi
 * z kontraktu, żeby bramka go pilnowała.
 *
 * Stany unieważnione (`refunded`, `expired`, `withdrawn`) NIE są tu
 * wymienione — przejście z nich rozstrzyga PRECEDENCJA
 * (`SUPERSEDING_VOUCHER_STATUS`), a nie ta mapa: patrz
 * `decideVoucherCodeInvalidation`.
 */
export const CODE_INVALIDATION_SOURCE_STATES_BY_TARGET: Readonly<
  Record<VoucherStatus, readonly VoucherStatus[]>
> = {
  // Zwrot: „pieniądze wróciły" unieważnia kod NIEZALEŻNIE od tego, czy zabieg
  // został już zrealizowany — dlatego i tylko dlatego `claimed` jest źródłem.
  refunded: ["idle", "consent_pending", "claimed"],
  // Wygaśnięcie: kod ZREALIZOWANY nie wygasa. Relabel `claimed` → `expired`
  // niszczyłby fakt realizacji.
  expired: ["idle", "consent_pending"],
  // Wycofanie zgody / kompensacja wystawienia: jak wyżej.
  withdrawn: ["idle", "consent_pending"],
  // Poniższe NIE są celami unieważnienia (nie występują w mapie kontraktu);
  // wpisy istnieją, bo rekord jest WYCZERPUJĄCY po `VoucherStatus` — dopisanie
  // stanu kodu nie skompiluje się bez świadomej odpowiedzi, z czego wolno
  // w niego wejść.
  idle: [],
  consent_pending: [],
  claimed: [],
}

/**
 * Stany źródłowe dla KONKRETNEGO celu. Wydzielone, żeby wołający nie sięgał do
 * rekordu wprost i żeby komunikat błędu wymieniał zbiór ZALEŻNY OD CELU,
 * a nie zbiór unii.
 */
export function codeInvalidationSourceStates(
  target: VoucherStatus
): ReadonlySet<VoucherStatus> {
  return new Set(CODE_INVALIDATION_SOURCE_STATES_BY_TARGET[target] ?? [])
}

/**
 * Stany kodu, które SĄ już unieważnione — derywowane z mapy, nie wypisane
 * drugi raz.
 */
export const INVALIDATED_VOUCHER_STATUSES: ReadonlySet<VoucherStatus> = new Set(
  Object.values(INVALIDATING_ENTITLEMENT_STATE_TO_VOUCHER_STATUS) as VoucherStatus[]
)

/**
 * Stan kodu, który MOŻE nadpisać inny stan unieważniony — LUSTRO
 * `invalidating_transitions.superseding_status` z kontraktu (review-fix 5.9).
 *
 * ── Dlaczego ta reguła w ogóle istnieje ─────────────────────────────────────
 * Pierwsze podejście traktowało allow-listę jako jedyną bramkę: kod w stanie
 * `expired`/`withdrawn` przy tranzycji uprawnienia do REFUNDED wpadał na
 * `VoucherCodeNotInvalidatableError`, a że producent leży w transakcji
 * wołającego, wyjątek przewracał CAŁY zwrot. Ta ścieżka NIE jest hipotetyczna:
 *   (a) graf uprawnień dopuszcza `EXPIRED → REFUND_REQUESTED → REFUNDED`
 *       (`ALLOWED_ENTITLEMENT_TRANSITIONS[EXPIRED]`), więc zwrot wygasłego
 *       uprawnienia jest legalny;
 *   (b) na danych zastanych stan kodu bywa `expired` przy uprawnieniu ACTIVE,
 *       bo usunięty w tej story bulk-sweeper gasił kody po `voucher.expires_at`
 *       NIEZALEŻNIE od stanu uprawnienia.
 * Zwrot pieniędzy, który wywraca się na tym, że kod i tak już nie działał,
 * jest gorszy niż defekt, który 5.9 usuwa.
 *
 * ── Dlaczego akurat `refunded` ──────────────────────────────────────────────
 * „Pieniądze wróciły" jest faktem MOCNIEJSZYM niż „minęła data" i „zgoda
 * wycofana": tylko on zmienia odpowiedź na pytanie, czy salon ma za co wykonać
 * zabieg. Trasa realizacji rozstrzyga tak samo — `resolveRedeemRefusalReason`
 * stawia `refunded` PRZED gałęzią czasu. Gdyby kod zwróconego vouchera
 * zostawał `expired`, kosmetolożka dostałaby powód „wygasł", czyli dokładnie
 * ten mylący komunikat, który AC każe rozróżnić.
 *
 * W drugą stronę reguła NIE działa: `expired`/`withdrawn` nigdy nie nadpisują
 * `refunded` — wynik jest wtedy nazwany (`already_invalidated_other`), nie
 * zapisany i nie rzucony.
 */
export const SUPERSEDING_VOUCHER_STATUS: VoucherStatus = "refunded"

/** Wynik operacji unieważnienia — rozłączny, bez cichego „nic się nie stało". */
export type VoucherCodeInvalidationOutcome =
  /** Stan kodu przestawiony w TEJ transakcji. */
  | "invalidated"
  /** Kod był już w docelowym stanie unieważnionym — powtórzenie = no-op. */
  | "already_invalidated"
  /**
   * Kod był już unieważniony, ale INNYM stanem, którego ten cel nie nadpisuje
   * (patrz `SUPERSEDING_VOUCHER_STATUS`). Kod pozostaje nierealizowalny, więc
   * SM-7 nie jest zagrożony — ale wynik jest NAZWANY i asertowany, bo cichy
   * no-op w tym miejscu byłby nie do odróżnienia od defektu.
   */
  | "already_invalidated_other"
  /**
   * Uprawnienie nie jest wsparte kodem vouchera (`policy_snapshot` bez
   * `voucher_code`) i jego typ tego nie wymaga. To NIE jest cichy no-op:
   * wynik jest zwracany, nazwany i asertowany w testach.
   */
  | "no_voucher_code"
  /**
   * Kod jest `claimed` (zabieg wykonany), a cel NIE jest zwrotem
   * (review-fix cyklu 2, C2-MEDIUM-4).
   *
   * Relabel `claimed → expired` / `claimed → withdrawn` NISZCZYŁBY fakt
   * realizacji: `resolveRedeemRefusalReason` zwracałby wtedy `expired`/410
   * zamiast `already_redeemed`/409, a `voucher.status` przestałby nieść to,
   * co się faktycznie wydarzyło — dla reklamacji i raportowania to jest zapis
   * kłamiący. Usunięty w 5.9 bulk-UPDATE wykluczał `claimed` z tego samego
   * powodu (`WHERE status IN ('idle','consent_pending')`).
   *
   * SM-7 nie jest zagrożone: `claimed` jest POZA allow-listą wejściową
   * realizacji (`voucher_status_redemption_input_allowlist` = idle,
   * consent_pending), więc kod i tak nie przejdzie realizacji. Uprawnienie
   * schodzi normalnie; kod zostaje przy prawdzie.
   *
   * Wynik jest NAZWANY, nie rzucony: rzut przewracałby transakcję sweepera
   * i uprawnienie w ogóle by nie wygasło — czyli lek gorszy niż choroba,
   * i dokładnie ta klasa, którą precedencja zamknęła w cyklu 1.
   */
  | "already_redeemed_code"

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
  readonly target_status: VoucherStatus
  constructor(code: string, status: VoucherStatus, target: VoucherStatus) {
    super(
      `invalidateVoucherCode: kod ${code} jest w stanie '${status}', z którego ` +
        `przejście na '${target}' nie jest na allow-liście dla TEGO celu ` +
        `(${[...codeInvalidationSourceStates(target)].join(", ")})`
    )
    this.name = "VoucherCodeNotInvalidatableError"
    this.voucher_code = code
    this.status = status
    this.target_status = target
  }
}

/**
 * Czy typ uprawnienia JEST wsparty kodem vouchera — decyzja podjęta dla
 * KAŻDEGO wariantu taksonomii z osobna (review-fix 5.9).
 *
 * Zapis jako `Record<EntitlementType, boolean>`, a nie jako zbiór literałów
 * stringowych, jest tu pomiarem, nie estetyką: dopisanie wariantu do
 * `EntitlementType` (ADR-099 wymaga ADR + PR) nie skompiluje się, dopóki ktoś
 * świadomie nie odpowie, czy nowy typ niesie kod. Poprzedni kształt
 * (`new Set(["VOUCHER_AMOUNT","VOUCHER_SERVICE"])`) przepuściłby nowy typ
 * voucherowy jako `no_voucher_code` — czyli CICHO wróciłby dokładnie ten
 * defekt, który ta story usuwa: uprawnienie schodzi, kod zostaje.
 */
const ENTITLEMENT_TYPE_IS_VOUCHER_BACKED: Readonly<
  Record<EntitlementType, boolean>
> = {
  [EntitlementType.VOUCHER_AMOUNT]: true,
  [EntitlementType.VOUCHER_SERVICE]: true,
  [EntitlementType.CREDIT_PACK]: false,
  [EntitlementType.SUBSCRIPTION_B2C]: false,
  [EntitlementType.SUBSCRIPTION_B2B]: false,
  [EntitlementType.BUNDLE]: false,
}

/** Typy uprawnień, dla których BRAK kodu vouchera jest błędem, nie stanem. */
export const VOUCHER_BACKED_ENTITLEMENT_TYPES: ReadonlySet<string> = new Set(
  Object.entries(ENTITLEMENT_TYPE_IS_VOUCHER_BACKED)
    .filter(([, backed]) => backed)
    .map(([type]) => type)
)

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

  // Kod jest już unieważniony, ale INNYM stanem (review-fix 5.9). Rozstrzyga
  // precedencja z kontraktu, nie allow-lista: tylko `refunded` nadpisuje.
  // Rzucenie tutaj przewracało transakcję wołającego, czyli wywracało ZWROT
  // wygasłego uprawnienia — ścieżkę legalną w grafie i realną na danych
  // zastanych.
  if (INVALIDATED_VOUCHER_STATUSES.has(input.current_status)) {
    if (target !== SUPERSEDING_VOUCHER_STATUS) {
      return {
        outcome: "already_invalidated_other",
        entitlement_id: input.entitlement_id,
        voucher_code: code,
        prior_status: input.current_status,
        target_status: target,
      }
    }
    return {
      outcome: "invalidated",
      entitlement_id: input.entitlement_id,
      voucher_code: code,
      prior_status: input.current_status,
      target_status: target,
    }
  }

  // Allow-lista stanów źródłowych ZALEŻNA OD CELU (review-fix cyklu 2,
  // C2-MEDIUM-4). `claimed → refunded` przechodzi (zwrot unieważnia voucher
  // także po zabiegu); `claimed → expired`/`withdrawn` NIE — kod zrealizowany
  // nie wygasa i nie jest wycofywany.
  if (!codeInvalidationSourceStates(target).has(input.current_status)) {
    if (input.current_status === "claimed") {
      // Wynik NAZWANY, nie rzut: rzut przewracałby transakcję sweepera, więc
      // uprawnienie w ogóle by nie wygasło. Kod zostaje `claimed` — poza
      // allow-listą wejściową realizacji, czyli nierealizowalny.
      return {
        outcome: "already_redeemed_code",
        entitlement_id: input.entitlement_id,
        voucher_code: code,
        prior_status: input.current_status,
        target_status: target,
      }
    }
    // Stan spoza allow-listy i spoza nazwanych wyjątków — fail-closed PRZED
    // efektem. Dziś nieosiągalny (stany unieważnione rozstrzyga precedencja
    // wyżej), ale dopisanie stanu do `VoucherStatus` bez decyzji, z czego
    // wolno w cel wejść, ma być błędem, a nie cichym przejściem.
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
 * miał JEDEN nośnik. Czas przychodzi od WOŁAJĄCEGO (`now`), tak samo jak
 * w `invalidateVoucherCode` — review-fix 5.9 (LOW-5). Wcześniej ta funkcja
 * pisała `updated_at = NOW()` (zegar bazy), a jej sąsiadka `input.now` (zegar
 * wołającego): dwa kanały czasu w JEDNYM nośniku, czyli dokładnie ta oś, którą
 * review-fix 5.8 przed chwilą zrównał.
 *
 * ── Allow-lista: ZBIÓR, nie SQL (review-fix cyklu 3, SEC-3) ────────────────
 * Do cyklu 3 ta funkcja przyjmowała `inputStatusInClause: string` —
 * gotową klauzulę `status IN (…)`, konkatenowaną do `UPDATE`. Powód był
 * słuszny (producent nie ma być drugą kopią allow-listy 5.8), ale cena była
 * taka, że KONTROLA SM-7 — jakie stany kodu wolno w ogóle zrealizować —
 * przestała być kodem i stała się PARAMETREM TYPU `string`, wklejanym do SQL-a
 * bez żadnej walidacji. Wołający, który poda `"1=1"` albo `"status IS NOT NULL"`,
 * przestawia na `claimed` kod w stanie `refunded` — czyli produkuje `SM-7 > 0`
 * przy WSZYSTKICH pozostałych kontrolach tej story sprawnych i przy zielonej
 * bramce. Szew był latentny (obaj wołający podawali generator), ale to jest
 * dokładnie ten kanał cichego rozjazdu, przed którym ostrzega cała
 * argumentacja 5.9 — tyle że przesunięty o jeden poziom.
 *
 * Teraz przyjmowany jest ZBIÓR stanów, a klauzula powstaje TUTAJ, z tego
 * zbioru. Cel 5.8 jest zachowany w całości: zbiór nadal pochodzi od wołającego
 * (`VOUCHER_REDEMPTION_INPUT_STATES`), więc ten plik nie jest jego drugą kopią,
 * literały nadal są czytelne w logu zapytań, a istniejący człon parity bramki
 * ma dalej co porównywać z kontraktem. Znika wyłącznie możliwość podania
 * czegokolwiek, co nie jest stanem z domkniętej unii `VoucherStatus`.
 */
export async function claimVoucherCode(
  client: VoucherCodeStateClient,
  input: {
    code: string
    /**
     * Allow-lista stanów WEJŚCIOWYCH realizacji (5.8). Przekazywana jako zbiór,
     * nie jako SQL — patrz nagłówek funkcji.
     */
    inputStates: ReadonlySet<VoucherStatus>
    /** Zawężenie do najemcy (`redeemForSeller`); `null` dla ścieżki `claim()`. */
    seller_id?: string | null
    /** Zegar WOŁAJĄCEGO — ten sam kanał, co w `invalidateVoucherCode`. */
    now: Date
  }
): Promise<number> {
  // Pusty zbiór to nie „przepuść wszystko" — to `IN ()`, czyli błąd składni
  // albo, po naiwnym pominięciu klauzuli, `UPDATE` bez guardu na stan.
  // Fail-closed: brak allow-listy jest brakiem zgody, nie zgodą milczącą.
  if (input.inputStates.size === 0) {
    throw new Error(
      "claimVoucherCode: pusta allow-lista stanów wejściowych realizacji. " +
        "Bez guardu na stan `UPDATE` przestawiłby na `claimed` DOWOLNY kod, " +
        "w tym `refunded` — czyli SM-7 > 0. Fail-closed."
    )
  }
  const params: unknown[] = [input.code, input.now]
  let sellerPredicate = ""
  if (input.seller_id != null) {
    params.push(input.seller_id)
    sellerPredicate = ` AND seller_id = $${params.length}`
  }
  const res = await client.query(
    `UPDATE voucher SET status = 'claimed', updated_at = $2
      WHERE code = $1${sellerPredicate} AND ${renderVoucherStatusInClause(
        input.inputStates
      )}`,
    params
  )
  return res.rowCount ?? 0
}

/**
 * JEDYNY renderer klauzuli `<kolumna> IN (…)` ze zbioru stanów kodu.
 *
 * ADR-199 §2.2 (Story 5.8) stawia niezmiennik: „klauzula `WHERE` jest
 * GENEROWANA ze zbioru, nie pisana obok niego — dwie ręcznie utrzymywane kopie
 * tej samej listy rozjeżdżają się cicho". Review-fix cyklu 3 przeniósł
 * przekazywanie allow-listy ze `string`-a na `ReadonlySet` (SEC-3), więc
 * renderowanie musiało trafić do producenta — ale niezmiennik ADR-199 zostaje
 * dotrzymany dosłownie tylko wtedy, gdy renderer jest JEDEN. Ta funkcja nim
 * jest; `redemptionInputStatusInClause()` w `service.ts` do niej deleguje.
 *
 * Literały są bezpieczne, bo pochodzą z domkniętej unii `VoucherStatus`
 * (typ wymusza to statycznie), a nie z wejścia użytkownika. Kolejność
 * posortowana, żeby tekst zapytania był stabilny między przebiegami — inaczej
 * porównanie planów i diff logów zapytań szumiałyby bez powodu.
 */
export function renderVoucherStatusInClause(
  states: ReadonlySet<VoucherStatus>,
  column = "status"
): string {
  const values = [...states]
    .sort()
    .map((state) => `'${state}'`)
    .join(", ")
  return `${column} IN (${values})`
}
