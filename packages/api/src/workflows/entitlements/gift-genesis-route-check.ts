/**
 * gift-genesis-route-check.ts — v1.16.0 Story 3.8, AC2 (ADR-219 §4 człon 2).
 *
 * Kontrola RAPORTUJĄCA, NAZWANA (decyzja PO D-1, decisions-2026-11-14.md):
 * zakup prezentowy (`purchase_mode = gift`) zakończony genezą `ACTIVE` jest
 * czerwienią z nazwą trasy. D-11 dopisuje do zbioru znanych tras dwie trasy
 * następców (lost-code-reissue, retention-issue; DW-15-281, v1.17.0).
 * Pierwotnie JEDNA znana trasa (captured-path,
 * `payment.captured` → `issue-entitlement.ts`) daje zamiast tego wiersz
 * KNOWN-DIVERGENCE z odwołaniem do DW-15-210 (pomiar v1.16.0) i DW-15-271
 * (ujednolicenie genezy w v1.17.0). Wiersz jest WYJŚCIEM kontroli, nie
 * wyciszeniem: ginie tylko razem z naprawą genezy, a wtedy wpis allowlisty
 * staje się nieaktualny i sam czerwieni (STALE).
 *
 * Ten moduł NIE zmienia zachowania genezy (poza zakresem: DW-15-271).
 *
 * Allowlista jest JEDYNYM źródłem: bramka pre-push
 * `_grow/tools/validate_voucher_genesis_activation_contract.py`
 * (`gp-voucher-genesis-activation-contract`) parsuje ją z TEGO pliku, zamiast
 * trzymać drugą kopię.
 */

export type GenesisPurchaseMode = "gift" | "self"

export type GenesisObservation = {
  /** Nazwa trasy genezy (ADR-174), np. `captured-path`, `path-y-live-issue`. */
  route: string
  /** Plik producenta genezy, względem `GP/backend/packages/api/`. */
  producer: string
  /** `null` = tryb NIEZMIERZONY (producent rozgałęzia po trybie) ⇒ FAIL (R-6). */
  purchase_mode: GenesisPurchaseMode | null
  /** Stan, w którym producent tworzy wiersz `entitlement_instance`; `null` = nierozpoznany ⇒ FAIL (R-4). */
  genesis_state: string | null
  /**
   * Zmierzony powód, dla którego trasa nie dotyczy genezy prezentu (np. następca,
   * którego zbiór stanów źródła wyklucza `ISSUED`). Brak = trasa dotyczy (R-2/R-3).
   */
  not_applicable_reason?: string | null
  /**
   * Zbiór stanów źródła następcy NIEROZPOZNANY (graf brak, nieczytelny albo
   * częściowy — R-11/R-18, D-23) ⇒ FAIL; nigdy PASS „nie dotyczy” ani STALE.
   * Parytet z bramką Pythona (to samo pole w `--json`).
   */
  source_states_unrecognized?: string | null
}

export type KnownDivergenceEntry = {
  route: string
  producer: string
  refs: readonly string[]
}

// GIFT_GENESIS_KNOWN_DIVERGENCE:BEGIN (parsowane przez bramkę pre-push — nie zmieniaj kształtu)
export const GIFT_GENESIS_KNOWN_DIVERGENCE: readonly KnownDivergenceEntry[] = [
  {
    route: "captured-path",
    producer: "src/workflows/entitlements/issue-entitlement.ts",
    refs: ["DW-15-210", "DW-15-271"],
  },
  {
    route: "lost-code-reissue",
    producer: "src/modules/voucher/workflows/reissue-lost-code.ts",
    refs: ["DW-15-281"],
  },
  {
    route: "retention-issue",
    producer: "src/modules/voucher/workflows/issue-retention.ts",
    refs: ["DW-15-281"],
  },
]
// GIFT_GENESIS_KNOWN_DIVERGENCE:END

export const REQUIRED_DIVERGENCE_REFS = ["DW-15-210", "DW-15-271"] as const

/**
 * Decyzja PO D-11 (decisions-2026-11-14.md, zastępuje D-8): trasy następców
 * lost-code-reissue i retention-issue dostają nazwany KNOWN-DIVERGENCE z
 * DW-15-281 (naprawa v1.17.0). Zbiór ZAMKNIĘTY: wpis allowlisty spoza niego
 * (inna trasa, wzorzec, inny plik producenta) = FAIL. Lustro
 * `KNOWN_DIVERGENCE_CLOSED_SET` bramki Pythona (parytet przez `--json`).
 */
export const KNOWN_DIVERGENCE_CLOSED_SET: Readonly<
  Record<string, { producer: string; refs: readonly string[]; close: string }>
> = {
  "captured-path": {
    producer: "src/workflows/entitlements/issue-entitlement.ts",
    refs: ["DW-15-210", "DW-15-271"],
    close: "DW-15-271",
  },
  "lost-code-reissue": {
    producer: "src/modules/voucher/workflows/reissue-lost-code.ts",
    refs: ["DW-15-281"],
    close: "DW-15-281",
  },
  "retention-issue": {
    producer: "src/modules/voucher/workflows/issue-retention.ts",
    refs: ["DW-15-281"],
    close: "DW-15-281",
  },
}

export type GiftGenesisVerdict = "PASS" | "KNOWN-DIVERGENCE" | "FAIL"

export type GiftGenesisRow = {
  verdict: GiftGenesisVerdict
  route: string
  producer: string
  line: string
}

export type GiftGenesisReport = {
  ok: boolean
  rows: GiftGenesisRow[]
}

const ACTIVE = "ACTIVE"

function allowlistProblems(
  allowlist: readonly KnownDivergenceEntry[],
  admitted: KnownDivergenceEntry[]
): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  const known = Object.keys(KNOWN_DIVERGENCE_CLOSED_SET).sort().join(", ")
  for (const e of allowlist) {
    const spec = Object.prototype.hasOwnProperty.call(KNOWN_DIVERGENCE_CLOSED_SET, e.route)
      ? KNOWN_DIVERGENCE_CLOSED_SET[e.route]
      : undefined
    if (!spec || spec.producer !== e.producer) {
      problems.push(
        `wpis route=${e.route} producer=${e.producer} spoza zamkniętego zbioru KNOWN-DIVERGENCE (${known}; D-1/D-11)`
      )
      continue
    }
    admitted.push(e)
    if (seen.has(e.route)) {
      problems.push(`zdublowany wpis route=${e.route}`)
    }
    seen.add(e.route)
    const missing = spec.refs.filter((r) => !e.refs.includes(r))
    if (missing.length) {
      problems.push(
        `wpis ${e.route} nie odsyła do ${missing.join(", ")}`
      )
    }
  }
  return problems
}

/**
 * Ocena obserwacji genezy. Reguły (parytet z `evaluate()` bramki Pythona na
 * wspólnych fiksturach `__tests__/workflows/entitlements/fixtures/gift-genesis-cases.json`, R-9):
 *  - stan genezy albo `purchase_mode` nierozpoznany (`null`) → FAIL (fail-closed, R-4/R-6);
 *  - zbiór źródeł następcy nierozpoznany (`source_states_unrecognized`) → FAIL (R-11, D-23);
 *    w obu przypadkach wpis allowlisty tej trasy NIE dostaje STALE (brak pomiaru);
 *  - zmierzony `not_applicable_reason` → PASS z nazwanym powodem;
 *  - gift + ACTIVE na trasie z allowlisty (route ORAZ producer) → KNOWN-DIVERGENCE;
 *  - gift + ACTIVE na każdej innej trasie → FAIL z nazwą trasy;
 *  - self + ACTIVE → PASS (kontrola mierzy domenę, nie trasę);
 *  - gift w stanie innym niż ACTIVE → PASS;
 *  - wpis allowlisty bez obserwacji gift+ACTIVE → FAIL (STALE: naprawa weszła,
 *    wpis trzeba usunąć — inaczej allowlista przeżyje swój powód);
 *  - wpis allowlisty spoza zamkniętego zbioru `KNOWN_DIVERGENCE_CLOSED_SET`
 *    (D-11: captured-path, lost-code-reissue, retention-issue), zdublowany albo
 *    bez wymaganych odesłań → FAIL.
 */
export function checkGiftGenesis(
  observations: readonly GenesisObservation[],
  allowlist: readonly KnownDivergenceEntry[] = GIFT_GENESIS_KNOWN_DIVERGENCE
): GiftGenesisReport {
  const rows: GiftGenesisRow[] = []

  // Wpis spoza zamkniętego zbioru NIE daje KNOWN-DIVERGENCE (D-11).
  const admitted: KnownDivergenceEntry[] = []
  for (const p of allowlistProblems(allowlist, admitted)) {
    rows.push({ verdict: "FAIL", route: "(allowlista)", producer: "-", line: `FAIL allowlista: ${p}` })
  }

  const usedAllowlist = new Set<KnownDivergenceEntry>()

  const markMeasuredless = (o: GenesisObservation) => {
    for (const e of admitted) {
      if (e.route === o.route && e.producer === o.producer) usedAllowlist.add(e)
    }
  }

  for (const o of observations) {
    if (o.genesis_state == null || o.purchase_mode == null) {
      markMeasuredless(o)
      const what = o.genesis_state == null ? "stan genezy" : "purchase_mode"
      rows.push({
        verdict: "FAIL",
        route: o.route,
        producer: o.producer,
        line: `FAIL route=${o.route} producer=${o.producer}: ${what} NIEROZPOZNANY — kontrola nie zakłada stanu (fail-closed)`,
      })
      continue
    }
    if (o.source_states_unrecognized) {
      markMeasuredless(o)
      rows.push({
        verdict: "FAIL",
        route: o.route,
        producer: o.producer,
        line:
          `FAIL route=${o.route} producer=${o.producer}: zbiór źródeł NIEROZPOZNANY — ` +
          `${o.source_states_unrecognized}; kontrola nie zakłada „nie dotyczy” (fail-closed, R-11)`,
      })
      continue
    }
    if (o.not_applicable_reason) {
      rows.push({
        verdict: "PASS",
        route: o.route,
        producer: o.producer,
        line: `PASS route=${o.route} producer=${o.producer} purchase_mode=${o.purchase_mode} genesis=${o.genesis_state} nie dotyczy genezy prezentu: ${o.not_applicable_reason}`,
      })
      continue
    }
    const isGiftActive = o.purchase_mode === "gift" && o.genesis_state === ACTIVE
    if (!isGiftActive) {
      rows.push({
        verdict: "PASS",
        route: o.route,
        producer: o.producer,
        line: `PASS route=${o.route} producer=${o.producer} purchase_mode=${o.purchase_mode} genesis=${o.genesis_state}`,
      })
      continue
    }
    const entry = admitted.find(
      (e) => e.route === o.route && e.producer === o.producer
    )
    if (entry) {
      usedAllowlist.add(entry)
      rows.push({
        verdict: "KNOWN-DIVERGENCE",
        route: o.route,
        producer: o.producer,
        line:
          `KNOWN-DIVERGENCE route=${o.route} producer=${o.producer} purchase_mode=gift genesis=ACTIVE ` +
          `refs=${entry.refs.join(",")} (znany rozjazd ADR-219 §4; naprawa genezy v1.17.0)`,
      })
    } else {
      rows.push({
        verdict: "FAIL",
        route: o.route,
        producer: o.producer,
        line:
          `FAIL route=${o.route} producer=${o.producer} purchase_mode=gift genesis=ACTIVE ` +
          `(prezent realizowalny przed doręczeniem; trasa spoza allowlisty KNOWN-DIVERGENCE)`,
      })
    }
  }

  for (const e of admitted) {
    if (!usedAllowlist.has(e)) {
      const close = KNOWN_DIVERGENCE_CLOSED_SET[e.route]?.close ?? "DW"
      rows.push({
        verdict: "FAIL",
        route: e.route,
        producer: e.producer,
        line:
          `FAIL STALE route=${e.route} producer=${e.producer}: rozbieżność ustąpiła — zamknij ${close} ` +
          `i usuń wpis KNOWN-DIVERGENCE (brak obserwacji gift+ACTIVE)`,
      })
    }
  }

  return { ok: rows.every((r) => r.verdict !== "FAIL"), rows }
}
