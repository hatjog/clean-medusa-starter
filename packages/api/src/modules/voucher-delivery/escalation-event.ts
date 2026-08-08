/**
 * escalation-event.ts — zdarzenie eskalacyjne po wyczerpaniu polityki prob
 * (Story 4.6, FR-9g, NFR-3).
 *
 * ── Czego to jest naprawa ───────────────────────────────────────────────────
 * Do tej story jedyne, co wychodzilo ze skanu przy wyczerpaniu budzetu, to
 * `logger.warn` („wymagana decyzja operatora") i LICZBA CALKOWITA w metryce
 * `gp.voucher_delivery.reconciliation_sweep.gap` (pola `exhausted`, `parked`),
 * agregowana PER RYNEK. Czlowiek czytajacy ten dashboard wiedzial, ze „na rynku
 * bonbeauty dwa wiersze umarly". NIE wiedzial, KTORE. FR-9g nie mowi „policz
 * porazki" — mowi „dowiedz sie, kiedy voucher naprawde nie doszedl". Licznik
 * bez tozsamosci wiersza nie jest eskalacja, tylko wykresem, ktory rosnie.
 *
 * Agregat ZOSTAJE nietkniety (reguła alertu czyta jego pola po nazwie); to
 * zdarzenie jest DOLOZENIEM. Licznik odpowiada na „ile", zdarzenie na „ktore".
 *
 * ── Dlaczego TEN nosnik, a nie jeden z dwoch pozostalych (AC5) ──────────────
 * W drzewie zyja trzy drogi do PostHoga. Wybrany jest `posthog-metrics-client`.
 * Powody odrzucenia sa ZMIERZONE, nie domniemane:
 *
 *   1. `posthog-canary.ts` + `track.ts` — ODRZUCONY, bo jego klient jest
 *      MARTWY na sciezce produkcyjnej: `grep -rn "setPostHogCanaryClient"
 *      --include=*.ts src | grep -v __tests__` daje wylacznie definicje i
 *      wzmianke w komentarzu `sentry-mirror.ts:110` — ZERO wywolan. `_client`
 *      pozostaje `null`, a `emitCanaryAlert`/`emitForensicEvent` zaczynaja od
 *      `if (!_client) return`. Zbudowanie na nim eskalacji odtworzyloby
 *      dokladnie stan sprzed Story 2.5 (klucz `"posthog"`, ktorego nikt nie
 *      rejestrowal). Do tego `emitCanaryAlert` TLUMI alert przy
 *      `sample_n < CANARY_SUPPRESSION_THRESHOLD_N` (100), a eskalacja
 *      POJEDYNCZEGO wiersza jest z definicji proba jednoelementowa — bylaby
 *      tlumiona ZAWSZE. `metric_name` jest ponadto zamknietym enumem 7 metryk
 *      kanarkowych, a dopisanie osmej wymaga aneksu ADR.
 *   2. `alert-evaluator.ts` + `alert-emit.ts` — ODRZUCONY, bo jest silnikiem
 *      REGUL PROGOWYCH nad YAML-em (`AlertConfig.condition`,
 *      `FiringAlert.evaluated_value: string | number | null`), czyli dokladnie
 *      ksztaltem AGREGATU, ktory ta story naprawia; kanalu na tozsamosc wiersza
 *      nie ma. Jego wlasny docstring mowi: „real metric source plumbing is
 *      DEFER … full evaluator wiring lives in v1.7.0+".
 *   3. `posthog-metrics-client.ts` — WYBRANY. Jedyny z trzech, ktorego klient
 *      jest realnie rejestrowany (`loaders/posthog.ts` -> `container.register({
 *      posthog: client })`), i ten sam, ktorego skan JUZ uzywa dla `METRIC_GAP`.
 *      Eskalacja i agregat trafiaja wiec do tego samego projektu PostHoga, wiec
 *      „ile" i „ktore" da sie zestawic bez przelaczania dashboardu.
 *
 * Czwarty nosnik NIE POWSTAJE. Jedyna luka wybranego — brak bramki PII (ma ja
 * `track.ts`, ktory rzuca, nie strippuje) — jest domknieta TUTAJ, przez
 * `assertNoPii`, wspoldzielaca liste nazw pol z `track.ts`. Wspoldzielona, a nie
 * przepisana: druga lista rozjechalaby sie z pierwsza przy pierwszym dopisaniu.
 *
 * ── review-fix cyklu 1 (L1): bramka siedzi na NOSNIKU, nie przy jednej funkcji ─
 * Pierwsza wersja wolala `assertNoPii` wylacznie w `buildEscalationEventProperties`,
 * ktore sklada obiekt z 16 LITERALOW zapisanych 15 linii wyzej. Zbior kluczy byl
 * domkniety w typie i staly w czasie wykonania, wiec petla po `PII_FORBIDDEN_FIELDS`
 * nie mogla trafic dla ZADNEGO osiagalnego wejscia — bramka byla strukturalnie
 * zielona, a nie zielona z pomiaru, i mijaly ja obok pozostale zdarzenia tego
 * samego nosnika (`METRIC_GAP`, `METRIC_HEARTBEAT`). Od tego cyklu `withPiiGuard`
 * opakowuje CALY sterownik nosnika, wiec bramka widzi kazde zdarzenie, ktore
 * skan wypuszcza — w tym te, ktorych ladunek powstaje ze `spread`u licznikow
 * per-rynek, czyli jedyne o kluczach nieznanych w czasie kompilacji.
 */

import { PII_FORBIDDEN_FIELDS } from "../../lib/instrumentation/track"

/**
 * Minimalny sterownik nosnika — dokladnie ksztalt `SweepMetricsPort`, ktorym
 * skan juz emituje `METRIC_GAP` i `METRIC_HEARTBEAT`.
 *
 * Typ jest tu, a nie importowany z joba, wylacznie po to, zeby modul domenowy
 * nie zalezal od joba. NIE jest to czwarty nosnik: instancje buduje
 * `createPosthogSweepMetrics(client)` z tego samego klienta PostHoga, ktorego
 * rejestruje `loaders/posthog.ts` — i to na nim asertuja kontrole z AC3.
 */
export type EscalationSink = {
  capture: (event: string, properties: Record<string, unknown>) => void
}

/**
 * Nazwa zdarzenia — przestrzen `gp.voucher_delivery.*`, zgodna z zastanymi
 * (`gp.voucher_delivery.reconciliation_sweep.gap` / `.heartbeat`). JEDEN
 * literal dla producenta, testu i dashboardu.
 */
export const VOUCHER_DELIVERY_ESCALATION_EVENT =
  "gp.voucher_delivery.attempt_policy_exhausted" as const

/**
 * Dlaczego wiersz jest terminalny — rozroznienie, ktorego potrzebuje czlowiek
 * i ktore konsumuje Story 4.8 (okno pomiarowe SM-2 zatrulaby eskalacja nie
 * odrozniajaca „nie doszlo" od „nie wiemy"):
 *
 *   - `recipient_budget` — budzet ODBIORCY wyczerpany porazkami przypisywalnymi
 *     odbiorcy (odbicia, blokada, zly adres). To jest „voucher NIE DOSZEDL".
 *   - `total_attempt_ceiling` — twardy sufit prob lacznie
 *     (`max_total_attempt_count`) przy budzecie odbiorcy JESZCZE nietknietym.
 *     To jest „NIE WIEMY, czy doszedl" — dlawi nas cudza infrastruktura,
 *     a nie adres klientki. Reakcja operatora jest inna: tu naprawia sie
 *     dostawce, tam kontaktuje sie z klientka.
 */
export type EscalationReason = "recipient_budget" | "total_attempt_ceiling"

/** Wiersz zajety do eskalacji — tozsamosc wystarczajaca do dzialania (AC1). */
export interface EscalatedDispatchRow {
  dispatch_id: string
  entitlement_id: string
  template_key: string
  market_id: string | null
  /** Hash odbiorcy — NIGDY adres. Kolumna `recipient_hash` jest juz hashem. */
  recipient_hash: string | null
  attempt_count: number
  non_recipient_failure_count: number
  error_code: string | null
  first_error_code: string | null
  first_failed_at: string | null
}

/** Ladunek zdarzenia — plaski, bo wymiary PostHoga sa plaskie. */
export type EscalationEventProperties = {
  schedule_name: string
  dispatch_id: string
  entitlement_id: string
  template_key: string
  market_id: string | null
  recipient_hash: string | null
  attempt_count: number
  non_recipient_failure_count: number
  recipient_attempts_used: number
  max_attempt_count: number
  max_total_attempt_count: number
  escalation_reason: EscalationReason
  error_code: string | null
  first_error_code: string | null
  first_failed_at: string | null
  runbook_path: string
}

/**
 * Gdzie czlowiek ma to przeczytac i co ma z tym zrobic (AC4).
 *
 * Wzorzec zapozyczony ze zmierzonego miejsca: koperta alertu kanarkowego niesie
 * pole `runbook_path` (`posthog-canary.ts:81`), wiec adresat reakcji jest
 * osiagalny Z POZIOMU ZDARZENIA, bez wiedzy plemiennej. Bierzemy wzorzec, nie
 * nosnik — sam kanarek jest odrzucony z powodow wyzej.
 */
export const VOUCHER_DELIVERY_ESCALATION_RUNBOOK =
  "gp-ops/runbooks/voucher-delivery-attempt-policy-exhausted.md" as const

/**
 * Ladunek eskalacji NIE MOZE niesc PII. Rzuca — nie strippuje po cichu.
 *
 * Cicha redakcja jest gorsza od bledu: producent dalej wysyla adres, tylko nikt
 * o tym nie wie. `track.ts` rozstrzygnal to tak samo (AR-25,
 * PII-redaction-FORBIDDEN) i to jego liste nazw pol tu czytamy.
 *
 * `recipient_hash` przechodzi swiadomie: nazwa nie zawiera zadnego z zakazanych
 * podciagow, a wartosc jest hashem — to jedyny kanal tozsamosci odbiorcy, ktory
 * wolno wyslac.
 */
export function assertNoPii(
  properties: Record<string, unknown>,
  origin: string,
): void {
  for (const key of Object.keys(properties)) {
    const lower = key.toLowerCase()
    for (const forbidden of PII_FORBIDDEN_FIELDS) {
      if (lower.includes(forbidden)) {
        throw new Error(
          `${origin}: zdarzenie eskalacyjne nie moze niesc PII — pole '${key}' ` +
            `jest zakazane (AR-25 PII-redaction-FORBIDDEN, wspolna lista ` +
            `PII_FORBIDDEN_FIELDS z lib/instrumentation/track.ts)`,
        )
      }
    }
  }
}

/**
 * Opakowuje sterownik nosnika bramka PII (L1 review-fix cyklu 1).
 *
 * Bramka przy jednym producencie chroni jednego producenta. Bramka na nosniku
 * chroni nosnik — a to jest to, co AC1 obiecuje („brakujaca bramke PII dokladamy
 * do wybranego nosnika"). Rzuca, nie strippuje: cicha redakcja zostawilaby
 * producenta wysylajacego adres i nikogo, kto o tym wie.
 *
 * `null`/`undefined` przechodzi bez zmiany — brak nosnika jest rozstrzygany
 * WYZEJ (`emitEscalationEvent` zwraca `carrier_unavailable`), a udawanie tu
 * pustego sterownika zamienialoby brak nosnika w cichy sukces.
 */
export function withPiiGuard<S extends EscalationSink>(
  sink: S | null | undefined,
  origin: string,
): S | undefined {
  if (!sink) return undefined
  return {
    ...sink,
    capture(event: string, properties: Record<string, unknown>) {
      assertNoPii(properties, `${origin}:${event}`)
      sink.capture(event, properties)
    },
  }
}

/** Ktora granica wyczerpala sie pierwsza — budzet odbiorcy czy sufit prob. */
export function escalationReasonFor(
  row: Pick<
    EscalatedDispatchRow,
    "attempt_count" | "non_recipient_failure_count"
  >,
  policy: { max_attempt_count: number; max_total_attempt_count: number },
): EscalationReason {
  const recipientAttemptsUsed =
    row.attempt_count - row.non_recipient_failure_count
  return recipientAttemptsUsed >= policy.max_attempt_count
    ? "recipient_budget"
    : "total_attempt_ceiling"
}

export function buildEscalationEventProperties(
  row: EscalatedDispatchRow,
  policy: { max_attempt_count: number; max_total_attempt_count: number },
  scheduleName: string,
): EscalationEventProperties {
  const properties: EscalationEventProperties = {
    schedule_name: scheduleName,
    dispatch_id: row.dispatch_id,
    entitlement_id: row.entitlement_id,
    template_key: row.template_key,
    market_id: row.market_id,
    recipient_hash: row.recipient_hash,
    attempt_count: row.attempt_count,
    non_recipient_failure_count: row.non_recipient_failure_count,
    recipient_attempts_used:
      row.attempt_count - row.non_recipient_failure_count,
    max_attempt_count: policy.max_attempt_count,
    max_total_attempt_count: policy.max_total_attempt_count,
    escalation_reason: escalationReasonFor(row, policy),
    error_code: row.error_code,
    first_error_code: row.first_error_code,
    first_failed_at: row.first_failed_at,
    runbook_path: VOUCHER_DELIVERY_ESCALATION_RUNBOOK,
  }
  assertNoPii(
    properties as unknown as Record<string, unknown>,
    "buildEscalationEventProperties",
  )
  return properties
}

/**
 * Wynik proby emisji. `carrier_unavailable` NIE jest sukcesem i nie wolno go
 * zwinac do `void`.
 *
 * To jest pulapka nr 1 tej story i zadzialala juz raz w tym repo: przed Story
 * 2.5 wszystkie `posthog?.capture(...)` w jobach byly no-opami, bo klucza
 * `"posthog"` nikt nie rejestrowal — i nie wykryl tego ZADEN test, tylko pomiar
 * srodowiska. `?.` na `null` nie rzuca, wiec test „nie rzuca wyjatku" przechodzi
 * w OBU swiatach. Dlatego ta funkcja przyjmuje klienta jako `| null` JAWNIE
 * i zwraca rozroznialny wynik zamiast polykac brak nosnika przez `?.`.
 */
export type EscalationEmitResult =
  | { status: "emitted"; properties: EscalationEventProperties }
  | { status: "carrier_unavailable" }
  | { status: "carrier_error"; error: unknown }

export function emitEscalationEvent(
  metrics: EscalationSink | null | undefined,
  row: EscalatedDispatchRow,
  policy: { max_attempt_count: number; max_total_attempt_count: number },
  scheduleName: string,
): EscalationEmitResult {
  const properties = buildEscalationEventProperties(row, policy, scheduleName)
  if (!metrics) {
    return { status: "carrier_unavailable" }
  }
  try {
    // Tozsamosc wiersza jedzie we WLASCIWOSCIACH (`dispatch_id`,
    // `entitlement_id`), nie w `distinctId`: `distinctId` tego nosnika jest
    // stale rowny nazwie joba dla WSZYSTKICH metryk skanu, a rozjechanie go
    // tylko dla eskalacji rozbiloby szereg zdarzen tego samego producenta.
    metrics.capture(
      VOUCHER_DELIVERY_ESCALATION_EVENT,
      properties as unknown as Record<string, unknown>,
    )
  } catch (error) {
    return { status: "carrier_error", error }
  }
  return { status: "emitted", properties }
}
