/**
 * money-path-compensation-registry.ts — v1.15.0 Story 3.5 (FR-6c, NFR-3, AD-22).
 *
 * Nieudana kompensacja na ścieżce pieniądza przestaje być zdarzeniem PRYWATNYM
 * procesu. Ten moduł jest jej nośnikiem: TRWAŁY wiersz w Postgresie
 * (`money_path_compensation_failure`) plus ALARM — w tej kolejności i z tą
 * hierarchią. `emitStructuredAlert` sam w sobie NIE spełnia wymagania: jego
 * ring buffer żyje w pamięci procesu (`lib/alert-emit.ts`, 1000 wpisów,
 * restart = zero), więc alarm jest DRUGIM nośnikiem obok wpisu, nigdy jego
 * zamiennikiem.
 *
 * ── Pułapka, którą ten plik musi omijać ───────────────────────────────────
 * Nieudana kompensacja i niedostępna baza to zdarzenia WYSOCE SKORELOWANE:
 * najczęstszą przyczyną nieudanego `DELETE` jest padnięty uchwyt. Rejestr
 * pisany DOKŁADNIE tym samym, właśnie padniętym połączeniem byłby wypełniony
 * wyłącznie przy porażkach, które i tak byłyby widoczne — czyli byłby
 * mechanizmem martwym na realnej ścieżce. Dlatego `openRegistryWriter()`
 * najpierw próbuje ŚWIEŻEGO połączenia z puli, a uchwytu wołającego używa
 * dopiero jako ostatniej deski ratunku (i mówi, którego użył).
 *
 * ── Łańcuch degradacji (AC3) ──────────────────────────────────────────────
 *   1. wpis w bazie (świeże połączenie)
 *   2. wpis w bazie (uchwyt wołającego — fallback)
 *   3. ALARM POZA BAZĄ: `emitStructuredAlert` + linia na `process.stderr`
 *      (nośnik niezależny od wstrzykniętego loggera i od bazy)
 *   4. kod odpowiedzi HTTP zachowujący ponowienie po stronie Stripe'a
 *
 * Ostatnie ogniwo NIE jest ciszą. `200 { received: true }` w tej gałęzi jest
 * ZAKAZANY: potwierdzenie odbioru przy nieodwróconym skutku kasuje ostatnią
 * szansę na odzysk — dopóki Stripe ponawia, sytuacja jest odwracalna.
 */
import { createHash } from "node:crypto"

import { emitStructuredAlert } from "../alert-emit"
import { resolveRuntimeInstanceId } from "../market-context"
import type { PaymentLinkQueryClient } from "./stripe-payment-intent-link"
import { acquireFreshPgConnection } from "./stripe-payment-intent-transport"

/**
 * Rodzaje kompensacji ścieżki pieniądza — ALLOW-LISTA. Ta sama lista jest
 * `CHECK`-iem w migracji `Migration20260818090000…`; wartość spoza niej ma
 * paść na bazie, a nie wejść cicho jako wolny tekst.
 */
export const COMPENSATION_KINDS = [
  "webhook_delivery_release",
  "issued_entitlement_rollback",
  "payment_audit_rollback",
  "cart_payment_authorization_cancel",
] as const

export type CompensationKind = (typeof COMPENSATION_KINDS)[number]

/** Kod alarmu — stabilny, cytowalny w runbooku operatora. */
export const COMPENSATION_FAILURE_ALERT_CODE = "MONEY_PATH_COMPENSATION_FAILED"

/**
 * Prefiks linii out-of-band na `process.stderr`. Stabilny CELOWO: to jest
 * jedyny nośnik, który działa, gdy baza jest niedostępna, a logger nie został
 * wstrzyknięty. `grep` po tym prefiksie jest częścią runbooku.
 */
export const COMPENSATION_FAILURE_STDERR_PREFIX = "GP-MONEY-PATH-COMPENSATION-FAILED"

/**
 * Separator członów `failure_id` — bajt NUL zapisany ESCAPE'M, nie literalnym
 * bajtem. Literalny NUL w źródle czyni plik binarnym dla gita: `git diff`
 * pokazuje `Bin` zamiast treści, a normalizacja `text`/`eol=lf` przestaje się
 * stosować. Wartość jest ta sama, więc skróty policzone przed i po tej zmianie
 * są identyczne.
 */
export const COMPENSATION_ID_SEPARATOR = "\u0000"

export type CompensationFailureRecord = {
  /** Rynek TEGO zamówienia — nigdy `orders[0].market_id` dla wiersza o N zamówieniach. */
  market_id: string
  compensation_kind: CompensationKind
  /** Która ścieżka dostawy (`webhook_event_processed.provider`). */
  delivery_path: string
  stripe_event_id: string
  payment_intent_id: string
  /** Skalarny, jedno zamówienie na wiersz. `null` = porażka przed rezolucją. */
  order_id: string | null
  /** Klucz korelacji zakupu (Story 3.3) — wiąże N wierszy jednego zakupu. */
  purchase_correlation_key: string
  failure_code: string
  failure_detail: string
}

export type RegistryWriter = {
  client: PaymentLinkQueryClient
  /** `fresh` = własne połączenie z puli, `caller` = uchwyt wołającego. */
  origin: "fresh" | "caller"
  release: () => void
}

export type RecordedCompensationFailure = {
  failure_id: string
  attempt_count: number
  order_id: string | null
}

/**
 * Story 4.2 (AD-32): właściciel i termin nowego wiersza. Owner to rola
 * operatorska `ops-recovery` (ADR-221 §owner: `operator_role`), termin = SLA
 * 24 h od zapisu (D-35 p.9). `instance_id` wyłącznie ze źródła serwerowego.
 */
export const COMPENSATION_FAILURE_OWNER = { owner_type: "operator_role", owner_id: "ops-recovery" } as const
export const COMPENSATION_FAILURE_SLA_HOURS = 24
/** Źródło `instance_id` wiersza runtime (opisane w ADR-238 §6; nie jest `provenance.source`). */
export const COMPENSATION_FAILURE_INSTANCE_SOURCE = "env:GP_INSTANCE_ID" as const
/**
 * Proweniencja wiersza runtime wg `recovery-population.v1.schema.json`
 * (`$defs.provenance`, ADR-221 §2): `kind` ze słownika kontraktu,
 * `source` = nazwa producenta runtime.
 */
export const COMPENSATION_FAILURE_PROVENANCE = {
  kind: "runtime_observed",
  source: "money-path-compensation-registry",
} as const

export class CompensationFailureInstanceUnconfiguredError extends Error {
  constructor() {
    super("money_path_compensation_failure: GP_INSTANCE_ID nie jest skonfigurowany — zapis odmówiony (fail-closed)")
    this.name = "CompensationFailureInstanceUnconfiguredError"
  }
}

export const RECORD_COMPENSATION_FAILURE_SQL = `
  INSERT INTO money_path_compensation_failure
    (failure_id, market_id, compensation_kind, delivery_path, stripe_event_id,
     payment_intent_id, order_id, purchase_correlation_key, failure_code,
     failure_detail, occurred_at, attempt_count, last_attempt_at, resolution_state,
     instance_id, owner_type, owner_id, deadline, closure_path, provenance_kind,
     provenance_source)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), 1, now(), 'open',
          $11, $12, $13, now() + make_interval(hours => $14::int), 'not_closed',
          $15, $16)
  ON CONFLICT (failure_id) DO UPDATE
     SET attempt_count   = money_path_compensation_failure.attempt_count + 1,
         last_attempt_at = now(),
         failure_detail  = EXCLUDED.failure_detail
  RETURNING failure_id, attempt_count, order_id
`

/**
 * Wiersze OTWARTE dla danej dostawy — nośnik odpowiedzi na pytanie „czy ta
 * dostawa ma nierozstrzygniętą nieudaną kompensację?".
 *
 * Bez tego zapytania ponowienie Stripe'a tego samego `evt_…` trafiało w gałąź
 * `duplicate` i kończyło się `200 { received: true }` — czyli w tej samej
 * ciszy, którą AC3 zakazuje o dwie linie wyżej. `attempt_count` był wtedy
 * strukturalnie nieosiągalny powyżej 1 na realnej ścieżce.
 *
 * Story 4.2 (ADR-238 §7): wiersz zastany `open` przeniesiony do kwarantanny
 * backfillu NADAL jest otwartą porażką tej dostawy — drugi człon `UNION ALL`
 * czyta go z `source_row`, więc ponowienie Stripe'a dostaje `500
 * compensation_failed/delivery_release_unresolved` jak przed migracją.
 *
 * Runda fix 2 D-31: wiersz kwarantanny przestaje być liczony jako otwarty,
 *  - gdy w populacji istnieje wiersz z tym samym `failure_id` (`NOT EXISTS`) —
 *    o stanie rozstrzyga wtedy populacja (brak duplikatu w `registry_failure_ids`,
 *    `resolved_manually` w populacji odblokowuje dostawę),
 *  - gdy ops-recovery zamknął go stanem terminalnym `closed_by_ops_recovery`
 *    (`backfill_state`; fakt `source_row` zostaje, wiersz nie jest kasowany).
 */
/**
 * Story 8.7 (DW-15-375): stany NIETERMINALNE kompensacji — każdy z nich blokuje
 * emisję i ACK ponowienia (`open` to nie jedyny stan „w toku": retry 11.3
 * przestawia wiersz na `recovery_in_progress`, a ten też nie jest rozstrzygnięciem).
 */
export const COMPENSATION_NONTERMINAL_STATES = ["open", "recovery_in_progress"] as const

/**
 * Story 8.7 (DW-15-375): stan terminalny rozstrzygnięty ZWROTEM środków
 * (`resolution_evidence.kind = 'refund_confirmed'`). Pieniądz wrócił do
 * klientki ⇒ ponowione zdarzenie Stripe'a NIE może już wystawić uprawnienia.
 */
export const COMPENSATION_REFUND_EVIDENCE_KIND = "refund_confirmed" as const

const NONTERMINAL_STATES_SQL = COMPENSATION_NONTERMINAL_STATES.map((s) => `'${s}'`).join(", ")

export const FIND_OPEN_COMPENSATION_FAILURES_SQL = `
  SELECT failure_id, attempt_count, order_id
    FROM money_path_compensation_failure
   WHERE delivery_path = $1
     AND stripe_event_id = $2
     AND resolution_state IN (${NONTERMINAL_STATES_SQL})
  UNION ALL
  SELECT q.source_failure_id AS failure_id,
         (q.source_row->>'attempt_count')::int AS attempt_count,
         q.source_row->>'order_id' AS order_id
    FROM money_path_compensation_failure_backfill_quarantine q
   WHERE q.source_row->>'delivery_path' = $1
     AND q.source_row->>'stripe_event_id' = $2
     AND q.source_row->>'resolution_state' = 'open'
     AND q.backfill_state = 'quarantined_pending_review'
     AND NOT EXISTS (
       SELECT 1
         FROM money_path_compensation_failure c
        WHERE c.failure_id = q.source_failure_id
     )
`

/**
 * Story 8.7 (DW-15-375): wiersze dostawy rozstrzygnięte terminalnie ZWROTEM.
 * Ich obecność oznacza: emisja uprawnienia dla tej dostawy jest zakazana na
 * zawsze (zwrot + voucher = podwójne świadczenie).
 */
export const FIND_REFUNDED_COMPENSATION_FAILURES_SQL = `
  SELECT failure_id, attempt_count, order_id
    FROM money_path_compensation_failure
   WHERE delivery_path = $1
     AND stripe_event_id = $2
     AND resolution_state NOT IN (${NONTERMINAL_STATES_SQL})
     AND resolution_evidence->>'kind' = '${COMPENSATION_REFUND_EVIDENCE_KIND}'
`

export async function findRefundedCompensationFailures(
  client: PaymentLinkQueryClient,
  input: { delivery_path: string; stripe_event_id: string }
): Promise<RecordedCompensationFailure[]> {
  const result = await client.query<RecordedCompensationFailure>(
    FIND_REFUNDED_COMPENSATION_FAILURES_SQL,
    [input.delivery_path, input.stripe_event_id]
  )
  return (result.rows ?? []).map((row) => ({
    failure_id: row.failure_id,
    attempt_count: Number(row.attempt_count),
    order_id: row.order_id ?? null,
  }))
}

export async function findOpenCompensationFailures(
  client: PaymentLinkQueryClient,
  input: { delivery_path: string; stripe_event_id: string }
): Promise<RecordedCompensationFailure[]> {
  const result = await client.query<RecordedCompensationFailure>(
    FIND_OPEN_COMPENSATION_FAILURES_SQL,
    [input.delivery_path, input.stripe_event_id]
  )
  return (result.rows ?? []).map((row) => ({
    failure_id: row.failure_id,
    attempt_count: Number(row.attempt_count),
    order_id: row.order_id ?? null,
  }))
}

/**
 * Deterministyczny identyfikator wiersza.
 *
 * Powtórna dostawa TEGO SAMEGO `evt_…` z tą samą klasą porażki daje ten sam
 * `failure_id` ⇒ `ON CONFLICT` inkrementuje próbę zamiast mnożyć wiersze.
 * Separator to bajt NUL, zapisany ESCAPE'M (`COMPENSATION_ID_SEPARATOR`),
 * nigdy literalnym bajtem w źródle — patrz komentarz przy tej stałej.
 * NUL nie występuje w żadnym z identyfikatorów Stripe'a ani Medusy, więc
 * sklejenie dwóch sąsiednich członów w jeden (`ab` + `c` nie do odróżnienia
 * od `a` + `bc`) jest niemożliwe — a to jest ta własność, która czyni
 * `failure_id` różnowartościowym.
 */
export function buildCompensationFailureId(
  record: Pick<
    CompensationFailureRecord,
    "delivery_path" | "stripe_event_id" | "compensation_kind" | "failure_code" | "order_id"
  >
): string {
  const digest = createHash("sha256")
    .update(
      [
        record.delivery_path,
        record.stripe_event_id,
        record.compensation_kind,
        record.failure_code,
        record.order_id ?? "",
      ].join(COMPENSATION_ID_SEPARATOR)
    )
    .digest("hex")
  return `mpcf_${digest.slice(0, 40)}`
}

/**
 * Klucz korelacji ZAKUPU (Story 3.3).
 *
 * ── Stan zastany na gałęzi fali (zmierzony, nie założony) ─────────────────
 * Story 3.3 została zintegrowana w `e791f2018` jako SAM PLIK STORY (integracja
 * „scope-narrowed") — kolumny klucza korelacji na wierszach pętli wystawienia
 * NA TEJ GAŁĘZI NIE MA, a jej wpis w `migration-registry.yaml` jest wciąż
 * `reserved`. Ta story NIE zmyśla więc odczytu z nieistniejącej kolumny i NIE
 * czeka na 3.3 (`review` satysfakcjonuje blokadę).
 *
 * Zamiast tego wyprowadza klucz z TEGO SAMEGO ŹRÓDŁA, którym dysponuje 3.3
 * w tym punkcie ścieżki: identyfikatora PaymentIntenta. Jeden zakup = jeden
 * PaymentIntent = N zamówień, więc klucz wiąże N wierszy rejestru w jeden
 * zakup — i jest ZŁĄCZALNY z kolumną 3.3, gdy ta wejdzie, bo obie strony
 * wychodzą z `payment_intent_id`. Gdyby 3.3 wybrała inne wyprowadzenie,
 * złączenie jest nadal możliwe przez `payment_intent_id`, który wiersz niesie
 * osobno — dlatego klucz NIE jest tu jedynym mostem.
 */
export function buildPurchaseCorrelationKey(paymentIntentId: string): string {
  return `purchase:${paymentIntentId}`
}

/**
 * Otwiera połączenie do ZAPISU rejestru.
 *
 * Świeże połączenie jest preferowane, bo uchwyt wołającego jest właśnie tym,
 * na którym kompensacja padła. Gdy rozłącznego połączenia wziąć się NIE DA
 * (albo `acquireConnection()` też pada), wracamy na uchwyt wołającego — to
 * nadal lepsze niż nic, a wołający dostaje w `origin`, którym nośnikiem
 * faktycznie pisał.
 *
 * `origin: "fresh"` znaczy tu dokładnie „połączenie ROZŁĄCZNE z `fallbackClient`",
 * a nie „udało się cokolwiek zresolvować" — patrz `acquireFreshPgConnection`.
 * Wcześniejsza wersja szła przez `resolveWebhookPgHandle`, który na ścieżce
 * produkcyjnej (bez `__pg_pool__`) zwracał opakowanie TEJ SAMEJ instancji Knexa
 * i mimo to raportował `fresh` — degradacja `caller` była nieosiągalna, więc
 * pole `registry_writer_origin` w alarmie nie niosło informacji.
 */
export async function openRegistryWriter(
  scope: { resolve: (key: string) => unknown },
  fallbackClient: PaymentLinkQueryClient
): Promise<RegistryWriter> {
  try {
    const handle = await acquireFreshPgConnection(scope)
    if (handle && handle.client !== fallbackClient) {
      return { client: handle.client, origin: "fresh", release: handle.release }
    }
    // Zresolvowany uchwyt JEST uchwytem wołającego — to nie jest świeże
    // połączenie. Zwalniamy go i nazywamy rzecz po imieniu.
    handle?.release()
  } catch {
    // Świeże połączenie niedostępne — degradacja na uchwyt wołającego jest
    // JAWNA (`origin: "caller"`), nie milcząca.
  }
  return { client: fallbackClient, origin: "caller", release: () => {} }
}

/**
 * Zapisuje JEDEN wiersz rejestru. Rzuca, gdy zapis się nie uda — wołający
 * MUSI mieć następne ogniwo łańcucha, a nie cichy `undefined`.
 */
export async function recordCompensationFailure(
  client: PaymentLinkQueryClient,
  record: CompensationFailureRecord
): Promise<RecordedCompensationFailure> {
  const failureId = buildCompensationFailureId(record)
  const instanceId = resolveRuntimeInstanceId()
  if (!instanceId) {
    throw new CompensationFailureInstanceUnconfiguredError()
  }
  const result = await client.query<RecordedCompensationFailure>(
    RECORD_COMPENSATION_FAILURE_SQL,
    [
      failureId,
      record.market_id,
      record.compensation_kind,
      record.delivery_path,
      record.stripe_event_id,
      record.payment_intent_id,
      record.order_id,
      record.purchase_correlation_key,
      record.failure_code,
      record.failure_detail,
      instanceId,
      COMPENSATION_FAILURE_OWNER.owner_type,
      COMPENSATION_FAILURE_OWNER.owner_id,
      COMPENSATION_FAILURE_SLA_HOURS,
      COMPENSATION_FAILURE_PROVENANCE.kind,
      COMPENSATION_FAILURE_PROVENANCE.source,
    ]
  )
  const row = result.rows?.[0]
  if (!row) {
    // `RETURNING` bez wiersza po `INSERT … ON CONFLICT DO UPDATE` znaczy, że
    // zapis NIE nastąpił. Cichy sukces byłby dokładnie tą ciszą, którą ta
    // story zamyka.
    throw new Error("money_path_compensation_failure: INSERT nie zwrócił wiersza")
  }
  return {
    failure_id: row.failure_id,
    // `INTEGER` z node-pg wraca jako number, ale przez Knex bywa stringiem —
    // normalizujemy w jednym miejscu (ADR-166: nie ufać typom z sterownika).
    attempt_count: Number(row.attempt_count),
    order_id: row.order_id ?? null,
  }
}

/**
 * Alarm POZA BAZĄ — ogniwo 3 łańcucha degradacji.
 *
 * DWA nośniki, świadomie:
 *  * `emitStructuredAlert` — widoczny w `/admin/operator/alerting`, ale
 *    w pamięci procesu (restart = zero);
 *  * linia JSON na `process.stderr` — przeżywa brak wstrzykniętego loggera
 *    i brak bazy; jest tym, co zostaje, gdy nie zostaje nic innego.
 */
export function emitCompensationFailureAlert(input: {
  record: CompensationFailureRecord
  persisted: RecordedCompensationFailure | null
  registry_error: string | null
  writer_origin: RegistryWriter["origin"] | null
}): void {
  const context: Record<string, unknown> = {
    compensation_kind: input.record.compensation_kind,
    delivery_path: input.record.delivery_path,
    stripe_event_id: input.record.stripe_event_id,
    payment_intent_id: input.record.payment_intent_id,
    order_id: input.record.order_id,
    market_id: input.record.market_id,
    purchase_correlation_key: input.record.purchase_correlation_key,
    failure_code: input.record.failure_code,
    failure_detail: input.record.failure_detail,
    registry_failure_id: input.persisted?.failure_id ?? null,
    registry_attempt_count: input.persisted?.attempt_count ?? null,
    registry_writer_origin: input.writer_origin,
    registry_error: input.registry_error,
    registry_persisted: input.persisted !== null,
  }

  // Rzut z `emitStructuredAlert` (np. `JSON.stringify` na kontekście niosącym
  // strukturę cykliczną z opakowanego błędu sterownika) NIE MOŻE wywrócić
  // gałęzi, bo route kończy ją jawnym kodem odpowiedzi DOPIERO PO tym wywołaniu
  // — a wyżej po `POST` nie ma żadnego `catch`. Połknięcie jest tu poprawne
  // wyłącznie dlatego, że NIŻEJ stoi jeszcze nośnik out-of-band na `stderr`:
  // ogniwo 3 nie znika, tylko traci jeden ze swoich dwóch nośników.
  try {
    emitStructuredAlert({
      // Brak wpisu w bazie podnosi wagę: to już nie jest „wiadomo i zapisane",
      // tylko „wiadomo i JEDYNY ślad jest ulotny".
      severity: input.persisted ? "ERROR" : "CRITICAL",
      code: COMPENSATION_FAILURE_ALERT_CODE,
      message:
        `Kompensacja ${input.record.compensation_kind} nie doszła do skutku ` +
        `(${input.record.stripe_event_id}); ` +
        (input.persisted
          ? `wpis w rejestrze: ${input.persisted.failure_id}`
          : `ZAPIS DO REJESTRU RÓWNIEŻ PADŁ: ${input.registry_error ?? "nieznany błąd"}`),
      context,
    })
  } catch (alertErr) {
    // Nie cisza: fakt niedostępności alarmu strukturalnego JEDZIE dalej linią
    // out-of-band poniżej, jako osobne pole kontekstu.
    context.alert_emit_error = (alertErr as Error).message
  }

  // Nośnik out-of-band. `try/catch` jest tu konieczny, bo zamknięty stderr
  // NIE MOŻE przewrócić obsługi żądania — ale jest to jedyne miejsce w tym
  // pliku, gdzie połknięcie błędu jest poprawne: to ostatnie ogniwo, a wyżej
  // stoją już wpis i alarm strukturalny.
  try {
    process.stderr.write(
      `${COMPENSATION_FAILURE_STDERR_PREFIX} ${JSON.stringify(context)}\n`
    )
  } catch {
    /* nośnik ostatniej szansy niedostępny — wyżej stoją wpis i alarm */
  }
}

/**
 * Pełne ogniwo 1–3: zapisz wiersze (po jednym na zamówienie) i wyemituj alarm.
 *
 * Zwraca `persisted: false`, gdy zapis padł — wołający ma z tego wyprowadzić
 * ogniwo 4 (kod HTTP), a nie zignorować wynik.
 */
export async function reportCompensationFailure(
  scope: { resolve: (key: string) => unknown },
  fallbackClient: PaymentLinkQueryClient,
  records: ReadonlyArray<CompensationFailureRecord>
): Promise<{
  persisted: boolean
  /** `true`, gdy CZĘŚĆ wierszy jest w bazie, a część nie. */
  partial: boolean
  rows: RecordedCompensationFailure[]
  registry_error: string | null
  writer_origin: RegistryWriter["origin"] | null
}> {
  if (records.length === 0) {
    // Jedyna ścieżka w tym module, w której „sukces" mógłby znaczyć „nie
    // zrobiono nic": pusty zbiór dałby `persisted: true`, zero wierszy i ZERO
    // alarmów. Dla `webhook_delivery_release` jest to dziś nieosiągalne
    // (`records` powstaje z `resolution.orders.map`, a gałąź jest za
    // `resolution.ok`), ale rodzaje z DW-15-089 będą wołane z innych miejsc.
    // Strażnik jest tu po to, żeby cisza nie wróciła bocznymi drzwiami.
    throw new Error(
      "reportCompensationFailure: pusty zbior rekordow — nieudana kompensacja " +
        "MUSI miec co najmniej jeden nosnik, milczacy sukces jest zakazany (AC1)"
    )
  }

  const writer = await openRegistryWriter(scope, fallbackClient)
  // Indeks zgodny z `records`: `null` = TEN wiersz nie został zapisany.
  const rowByIndex: Array<RecordedCompensationFailure | null> = records.map(() => null)
  let registryError: string | null = null

  try {
    for (const [index, record] of records.entries()) {
      rowByIndex[index] = await recordCompensationFailure(writer.client, record)
    }
  } catch (err) {
    registryError = (err as Error).message
  } finally {
    writer.release()
  }

  const rows = rowByIndex.filter(
    (row): row is RecordedCompensationFailure => row !== null
  )
  const persisted = registryError === null && rows.length === records.length
  const partial = !persisted && rows.length > 0

  for (const [index, record] of records.entries()) {
    const row = rowByIndex[index]
    emitCompensationFailureAlert({
      record,
      // Wiersz zapisany niesie SWÓJ adres, nawet gdy pętla padła na kolejnym.
      // Wcześniej `persisted ? … : null` gasiło `registry_failure_id` dla
      // WSZYSTKICH rekordów partii, więc wiersze faktycznie leżące w bazie
      // były nieodnajdywalne inaczej niż skanem po `stripe_event_id`.
      persisted: row,
      // Błąd partii dotyczy wierszy, których NIE zapisano; przy zapisanym
      // wierszu jego doklejenie sugerowałoby porażkę tego wiersza.
      registry_error: row ? null : registryError,
      writer_origin: writer.origin,
    })
  }

  return {
    persisted,
    partial,
    rows,
    registry_error: registryError,
    writer_origin: writer.origin,
  }
}
