/**
 * gift-genesis-route-check.ts — v1.16.0 Story 3.8, AC2 (ADR-219 §4 człon 2).
 *
 * Kontrola RAPORTUJĄCA, NAZWANA (decyzja PO D-1, decisions-2026-11-14.md):
 * zakup prezentowy (`purchase_mode = gift`) zakończony genezą `ACTIVE` jest
 * czerwienią z nazwą trasy. Dokładnie JEDNA znana trasa (captured-path,
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
]
// GIFT_GENESIS_KNOWN_DIVERGENCE:END

export const REQUIRED_DIVERGENCE_REFS = ["DW-15-210", "DW-15-271"] as const

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
  allowlist: readonly KnownDivergenceEntry[]
): string[] {
  const problems: string[] = []
  if (allowlist.length !== 1) {
    problems.push(
      `allowlista KNOWN-DIVERGENCE musi zawierać DOKŁADNIE jedną trasę, ma ${allowlist.length}`
    )
  }
  for (const e of allowlist) {
    const missing = REQUIRED_DIVERGENCE_REFS.filter((r) => !e.refs.includes(r))
    if (missing.length) {
      problems.push(
        `wpis allowlisty ${e.route} nie odsyła do ${missing.join(", ")}`
      )
    }
  }
  return problems
}

/**
 * Ocena obserwacji genezy. Reguły (parytet z `evaluate()` bramki Pythona na
 * wspólnych fiksturach `__tests__/workflows/entitlements/fixtures/gift-genesis-cases.json`, R-9):
 *  - stan genezy albo `purchase_mode` nierozpoznany (`null`) → FAIL (fail-closed, R-4/R-6);
 *  - zmierzony `not_applicable_reason` → PASS z nazwanym powodem;
 *  - gift + ACTIVE na trasie z allowlisty (route ORAZ producer) → KNOWN-DIVERGENCE;
 *  - gift + ACTIVE na każdej innej trasie → FAIL z nazwą trasy;
 *  - self + ACTIVE → PASS (kontrola mierzy domenę, nie trasę);
 *  - gift w stanie innym niż ACTIVE → PASS;
 *  - wpis allowlisty bez obserwacji gift+ACTIVE → FAIL (STALE: naprawa weszła,
 *    wpis trzeba usunąć — inaczej allowlista przeżyje swój powód);
 *  - allowlista o liczności ≠ 1 albo bez DW-15-210/DW-15-271 → FAIL.
 */
export function checkGiftGenesis(
  observations: readonly GenesisObservation[],
  allowlist: readonly KnownDivergenceEntry[] = GIFT_GENESIS_KNOWN_DIVERGENCE
): GiftGenesisReport {
  const rows: GiftGenesisRow[] = []

  for (const p of allowlistProblems(allowlist)) {
    rows.push({ verdict: "FAIL", route: "(allowlista)", producer: "-", line: `FAIL allowlista: ${p}` })
  }

  const usedAllowlist = new Set<KnownDivergenceEntry>()

  for (const o of observations) {
    if (o.genesis_state == null || o.purchase_mode == null) {
      const what = o.genesis_state == null ? "stan genezy" : "purchase_mode"
      rows.push({
        verdict: "FAIL",
        route: o.route,
        producer: o.producer,
        line: `FAIL route=${o.route} producer=${o.producer}: ${what} NIEROZPOZNANY — kontrola nie zakłada stanu (fail-closed)`,
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
    const entry = allowlist.find(
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

  for (const e of allowlist) {
    if (!usedAllowlist.has(e)) {
      rows.push({
        verdict: "FAIL",
        route: e.route,
        producer: e.producer,
        line:
          `FAIL STALE route=${e.route} producer=${e.producer}: wpis KNOWN-DIVERGENCE bez obserwacji ` +
          `gift+ACTIVE — usuń wpis (refs=${e.refs.join(",")})`,
      })
    }
  }

  return { ok: rows.every((r) => r.verdict !== "FAIL"), rows }
}
