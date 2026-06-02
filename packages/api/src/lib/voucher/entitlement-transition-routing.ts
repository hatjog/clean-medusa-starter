import fs from "node:fs"
import path from "node:path"

/**
 * entitlement-transition-routing.ts — Story 3.4 (v1.11.0 Epic 3) — STATYCZNY
 * checker DYSPERSJI okablowania maszyny stanów L4 (AI-Review-1 / AI-Review-4).
 *
 * AC1 wymaga JEDNEGO deterministycznego punktu okablowania per dozwolona tranzycja
 * (NIE rozproszone per call-site). 3.4 realizuje w runtime tranzycję ISSUED (Path Y
 * live-issue → ISSUED przez `wireEntitlementTransitionPersisted`). Pozostałe
 * tranzycje lifecycle (REDEEMED/EXPIRED/VOIDED/refund/…) to E4 — TEN checker jest
 * JAWNYM KONTRAKTEM, że E4 przerouuje swoje call-site'y przez TEN SAM punkt, a nie
 * rozproszy okablowania. Egzekwuje DWIE reguły (czysto na migawce kodu, bez I/O w
 * rdzeniu — `assertTransitionsRoutedThroughWiring` to cienka otoczka FS do testu):
 *
 *   (R1) POSTING EXCLUSIVITY (AI-Review-4 — „druga bariera" bramki aktywacji):
 *        jedynym produkcyjnym call-site instancjonującym/używającym writer ledgera
 *        (`new VoucherLedgerWriter` / `ledgerWriter.write(`) — POZA allow-listą —
 *        jest moduł okablowania (posting hook) oraz reconciliation-job 2.6 (ADR-139
 *        D2). Nowy bezpośredni call writera ⇒ flagowany (obejście bramki w callerze).
 *
 *   (R2) TRANSITION-GUARD MANIFEST (AI-Review-1 — zapobieganie rozproszeniu):
 *        każdy produkcyjny plik wołający `assertTransition(` (twardy guard maszyny
 *        stanów PRZED persystowaną zmianą stanu) MUSI być w manifeście
 *        `TRANSITION_GUARD_CALLSITES` — albo jako WIRED (przeszedł przez okablowanie
 *        3.4), albo jako E4_DEFERRED (świadomie odłożony, do przerouowania w E4).
 *        NOWY, nieujęty call-site ⇒ flagowany: zmusza świadomą decyzję (okabluj
 *        przez `wireEntitlementTransition…` albo dopisz do manifestu z uzasadnieniem),
 *        zamiast cichego rozproszenia okablowania.
 */

/** Moduł JEDNOLITEGO punktu okablowania (posting hook + orkiestrator). */
export const TRANSITION_WIRING_MODULE =
  "modules/voucher/entitlement-transition-wiring.ts" as const

/**
 * Allow-lista produkcyjnych plików, którym WOLNO instancjonować/wołać writer
 * ledgera bezpośrednio (R1). Dopisanie = świadoma zmiana (gate review), NIE ciche
 * obejście bramki aktywacji (ADR-139 D5). Dopasowanie po SUFIKSIE ścieżki.
 */
export const ALLOWED_LEDGER_WRITER_CALLSITES: readonly string[] = [
  "modules/voucher/entitlement-transition-wiring.ts", // posting hook (jedyny okablowany)
  "modules/voucher/ledger-writer.ts", // definicja writera (2.6)
  "jobs/voucher-ledger-reconciliation.ts", // reconciliation-inwariant 2.6 (ADR-139 D2)
] as const

/** Status okablowania call-site'u guardu tranzycji (R2). */
export type TransitionRoutingStatus = "WIRED" | "E4_DEFERRED"

/**
 * Manifest produkcyjnych call-site'ów `assertTransition(` (R2). KONTRAKT: każdy
 * plik z guardem maszyny stanów jest tu jawnie sklasyfikowany. WIRED = realnie
 * przechodzi przez okablowanie 3.4; E4_DEFERRED = świadomie odłożony do E4 (ma
 * zostać przerouowany przez `wireEntitlementTransition…` bez rozpraszania punktu).
 * Dopasowanie po SUFIKSIE ścieżki.
 */
export const TRANSITION_GUARD_CALLSITES: ReadonlyArray<{
  suffix: string
  status: TransitionRoutingStatus
  note: string
}> = [
  {
    // 3.4: geneza ISSUED na ścieżce live przechodzi przez okablowanie
    // (subscriber Path Y woła `wireEntitlementTransitionPersisted`). Sam rdzeń
    // live-issue zachowuje fail-closed `assertIssuableEntitlementType`, ale
    // tranzycja stanu (geneza→ISSUED) jest okablowana w subscriberze.
    suffix: "subscribers/voucher-live-issue.ts",
    status: "WIRED",
    note: "Path Y live-issue → geneza ISSUED okablowana (3.4, AI-Review-1)",
  },
  {
    suffix: "workflows/entitlements/issue-entitlement.ts",
    status: "E4_DEFERRED",
    note: "captured-path ISSUED→ACTIVE/refund — E4 przerouuje przez okablowanie",
  },
  {
    suffix: "modules/voucher/workflows/redeem-entitlement.ts",
    status: "E4_DEFERRED",
    note: "REDEMPTION/REDEEMED — E4 derecognition przez okablowanie",
  },
  {
    suffix: "modules/voucher/workflows/reissue-lost-code.ts",
    status: "E4_DEFERRED",
    note: "→VOIDED reissue — E4 przerouuje przez okablowanie",
  },
  {
    suffix: "modules/voucher/workflows/issue-retention.ts",
    status: "E4_DEFERRED",
    note: "→VOIDED retention — E4 przerouuje przez okablowanie",
  },
  {
    suffix: "modules/voucher/service.ts",
    status: "E4_DEFERRED",
    note: "ACTIVE/VOIDED/PENDING_VENDOR_DECISION/refund — E4 przez okablowanie",
  },
  {
    suffix: "api/v1/entitlements/claim/route.ts",
    status: "E4_DEFERRED",
    note: "claim →ACTIVE — E4 przerouuje przez okablowanie",
  },
] as const

export type SourceFile = { path: string; content: string }

export type RoutingFinding = {
  rule: "ledger-writer-dispersion" | "unmanifested-transition-guard"
  file: string
  detail: string
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/")
}

function isTestFile(filePath: string): boolean {
  const n = normalize(filePath)
  return n.includes("/__tests__/") || /\.(test|spec)\.ts$/.test(n)
}

/** Self-referencyjne: sam checker (string literale ścieżek/wzorców). */
function isSelfReferential(filePath: string): boolean {
  return normalize(filePath).endsWith("lib/voucher/entitlement-transition-routing.ts")
}

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

function endsWithAny(filePath: string, suffixes: readonly string[]): boolean {
  const n = normalize(filePath)
  return suffixes.some((s) => n.endsWith(s))
}

/** R1: bezpośrednie instancjonowanie/użycie writera ledgera. */
function usesLedgerWriterDirectly(code: string): boolean {
  return (
    /\bnew\s+VoucherLedgerWriter\s*\(/.test(code) ||
    /\bledgerWriter\.write\s*\(/.test(code)
  )
}

/** R2: produkcyjny call-site twardego guardu tranzycji maszyny stanów. */
function callsAssertTransition(code: string): boolean {
  // `assertTransition(` — NIE `assertWiringTransition(` (to wewnętrzny guard
  // samego okablowania) ani definicja w models/entitlement.ts.
  return /(^|[^A-Za-z0-9_])assertTransition\s*\(/.test(code)
}

/**
 * Czysta funkcja skanu — wejście to migawka kodu, wyjście to lista findings
 * (pusta = OK). Bez I/O.
 */
export function scanForTransitionRoutingViolations(
  files: readonly SourceFile[]
): RoutingFinding[] {
  const findings: RoutingFinding[] = []

  for (const file of files) {
    if (isTestFile(file.path) || isSelfReferential(file.path)) continue
    const code = stripComments(file.content)

    // R1 — posting exclusivity (AI-Review-4).
    if (
      usesLedgerWriterDirectly(code) &&
      !endsWithAny(file.path, ALLOWED_LEDGER_WRITER_CALLSITES)
    ) {
      findings.push({
        rule: "ledger-writer-dispersion",
        file: file.path,
        detail:
          "bezpośrednie new VoucherLedgerWriter / ledgerWriter.write poza allow-listą " +
          "(okablowanie + reconciliation 2.6) — posting MUSI iść przez bramkowany " +
          "posting hook (ADR-139 D5); dopisz do ALLOWED_LEDGER_WRITER_CALLSITES tylko " +
          "świadomie (gate review)",
      })
    }

    // R2 — transition-guard manifest (AI-Review-1).
    // Wyłączenia: (a) `models/entitlement.ts` = DEFINICJA `assertTransition`;
    // (b) moduł okablowania = SAM JEDNOLITY punkt (woła `assertTransition` w
    // `assertWiringTransition`, NIE jest rozproszonym call-site'em).
    if (
      callsAssertTransition(code) &&
      !endsWithAny(file.path, [
        "modules/voucher/models/entitlement.ts",
        TRANSITION_WIRING_MODULE,
      ]) &&
      !TRANSITION_GUARD_CALLSITES.some((c) => normalize(file.path).endsWith(c.suffix))
    ) {
      findings.push({
        rule: "unmanifested-transition-guard",
        file: file.path,
        detail:
          "call-site assertTransition( poza manifestem TRANSITION_GUARD_CALLSITES — " +
          "nowa persystowana tranzycja MUSI iść przez JEDNOLITY punkt okablowania " +
          "(wireEntitlementTransition…) albo zostać jawnie sklasyfikowana (WIRED / " +
          "E4_DEFERRED) w manifeście; cicha dyspersja okablowania zakazana (AC1)",
      })
    }
  }

  return findings
}

/** Rekurencyjnie czyta pliki `.ts` poniżej `root` (pomija node_modules/.medusa/dist). */
export function readSourceTree(root: string): SourceFile[] {
  const out: SourceFile[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".medusa" ||
          entry.name === "dist"
        ) {
          continue
        }
        walk(full)
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push({ path: full, content: fs.readFileSync(full, "utf8") })
      }
    }
  }
  walk(root)
  return out
}

/**
 * Twardy gate (driver FS): skanuje drzewo `srcRoot` i RZUCA przy jakiejkolwiek
 * dyspersji okablowania (R1/R2). Do użycia w teście 3.4 / walidatorze.
 */
export function assertTransitionsRoutedThroughWiring(srcRoot: string): void {
  const findings = scanForTransitionRoutingViolations(readSourceTree(srcRoot))
  if (findings.length > 0) {
    const lines = findings.map((f) => ` - [${f.rule}] ${f.file}: ${f.detail}`)
    throw new Error(
      `Dyspersja okablowania maszyny stanów (AC1 / AI-Review-1/4):\n${lines.join("\n")}`
    )
  }
}
