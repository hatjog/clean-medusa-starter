import fs from "node:fs"
import path from "node:path"

/**
 * path-y-exclusivity.ts — Story 3.3 (v1.11.0 Epic 3, AC5) — STATYCZNY checker
 * wyłączności Path Y dla live-issue → ISSUED (ADR-052/118).
 *
 * Egzekwuje, że JEDYNĄ drogą wystawienia (issue) L4 `entitlement_instance` na
 * ścieżce live jest Path Y subscriber (`subscribers/voucher-live-issue.ts` →
 * `workflows/entitlements/live-issue-from-payment-intent.ts`). ZAKAZANE i
 * WYKRYWANE (FR11, AR-PATHY):
 *   (1) custom HTTP route (`api/**`) wstawiający wiersz entitlementu (Path X) —
 *       webhook MUSI być cienki (signature verify + emit), issue żyje w subscriberze;
 *   (2) `INSERT INTO entitlement_instance` w JAKIMKOLWIEK pliku (cały skan drzewa,
 *       nie tylko `route.ts`) POZA allow-listą dozwolonych writerów
 *       (`ALLOWED_ENTITLEMENT_INSERT_WRITERS`: Path Y + captured/reissue/retention) —
 *       realny wektor obejścia M1 (drugi subscriber / module-service / repository /
 *       workflow, w tym „inna ścieżka do ISSUED" z AC5);
 *   (3) `createEntitlement…(...)` (RODZINA: `createEntitlement`/`createEntitlementInstances`
 *       — idiomatyczna auto-generowana metoda module-service Medusy) jako ścieżka
 *       issue — w GP `GpCoreService.createEntitlement` to jawnie stub
 *       `NotImplementedError`; CALL-site traktujący go jako issue jest zakazany (ADR-052/118).
 *
 * Logika jest CZYSTA (operuje na liście {path, content}) — `assertPathYExclusive`
 * z driverem FS jest cienką otoczką do użycia w teście AC5. Bez I/O w rdzeniu =
 * deterministyczne, szybkie, bez zależności od żywego stacku.
 */

/** Moduł-writer jedynej dozwolonej ścieżki issue (Path Y). */
export const PATH_Y_ISSUE_WRITER =
  "packages/api/src/workflows/entitlements/live-issue-from-payment-intent.ts" as const

/** Subscriber Path Y — jedyny dozwolony orchestrator issue. */
export const PATH_Y_SUBSCRIBER =
  "packages/api/src/subscribers/voucher-live-issue.ts" as const

/**
 * Allow-lista plików, którym WOLNO wykonać `INSERT INTO entitlement_instance`
 * (M1). Path Y writer (live-issue → ISSUED) + legalne istniejące writery domeny
 * voucher (captured-path `payment.captured` → ACTIVE, reissue lost-code → ACTIVE,
 * retention-issue → ACTIVE). KAŻDY inny inserter (nowy subscriber/serwis/workflow/
 * route — w tym „inna ścieżka do ISSUED" z AC5) jest flagowany. Dopisanie nowego
 * writera = świadoma zmiana TEJ listy (gate review), nie cichy obejście.
 *
 * Dopasowanie po SUFIKSIE ścieżki (odporne na prefiks repo/worktree/CWD).
 */
export const ALLOWED_ENTITLEMENT_INSERT_WRITERS: readonly string[] = [
  "workflows/entitlements/live-issue-from-payment-intent.ts", // Path Y → ISSUED
  "workflows/entitlements/issue-entitlement.ts", // captured-path → ACTIVE (v1.9.0 H-6)
  "modules/voucher/workflows/reissue-lost-code.ts", // reissue lost-code → ACTIVE
  "modules/voucher/workflows/issue-retention.ts", // retention issue → ACTIVE
] as const

export type SourceFile = { path: string; content: string }

export type ExclusivityFinding = {
  rule:
    | "custom-route-issue"
    | "create-entitlement-issue-callsite"
    | "non-allowlisted-entitlement-insert"
  file: string
  detail: string
}

/** Czy plik to handler HTTP route (custom route surface). */
function isApiRoute(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/")
  return (
    normalized.includes("/src/api/") &&
    /\/route\.ts$/.test(normalized) &&
    !normalized.includes("/__tests__/")
  )
}

function isTestFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/")
  return (
    normalized.includes("/__tests__/") ||
    /\.(test|spec)\.ts$/.test(normalized)
  )
}

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1") // line comments (zachowaj http:// w stringach best-effort)
}

/**
 * Wykrywa wstawienie wiersza entitlementu (issue) — `INSERT INTO entitlement_instance`.
 * UPDATE-y stanu (redeem/refund/claim transitions) NIE są issue i NIE są flagowane.
 */
function containsEntitlementInsert(code: string): boolean {
  return /INSERT\s+INTO\s+entitlement_instance\b/i.test(code)
}

/** Czy plik to jeden z dozwolonych writerów INSERT (allow-lista M1, po sufiksie). */
function isAllowlistedInsertWriter(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/")
  return ALLOWED_ENTITLEMENT_INSERT_WRITERS.some((suffix) =>
    normalized.endsWith(suffix)
  )
}

/** Self-referencyjne pliki (definicja stuba / sam checker) — wyłączone z reguł. */
function isSelfReferential(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/")
  return (
    normalized.endsWith("modules/gp-core/service.ts") ||
    normalized.endsWith("lib/voucher/path-y-exclusivity.ts")
  )
}

/**
 * Skanuje zestaw plików źródłowych i zwraca naruszenia wyłączności Path Y.
 * Czysta funkcja — wejście to migawka kodu, wyjście to lista findings (pusta = OK).
 */
export function scanForForbiddenIssuePaths(
  files: readonly SourceFile[]
): ExclusivityFinding[] {
  const findings: ExclusivityFinding[] = []

  for (const file of files) {
    if (isTestFile(file.path)) continue
    const code = stripComments(file.content)
    const selfRef = isSelfReferential(file.path)

    if (containsEntitlementInsert(code) && !selfRef) {
      if (isApiRoute(file.path)) {
        // (1) custom route, który ISSUE-uje entitlement (Path X) — zakaz.
        findings.push({
          rule: "custom-route-issue",
          file: file.path,
          detail:
            "custom HTTP route wstawia entitlement_instance (Path X zakazany) — " +
            "issue musi przejść przez Path Y subscriber (ADR-052/118)",
        })
      } else if (!isAllowlistedInsertWriter(file.path)) {
        // (2) INSERT entitlement_instance poza allow-listą — REALNY wektor M1
        // (drugi subscriber / module-service / repository / workflow wstawiający
        // wiersz, w tym „inna ścieżka do ISSUED" z AC5). Skan obejmuje CAŁE drzewo,
        // nie tylko `route.ts` — issue spoza dozwolonych writerów jest flagowane.
        findings.push({
          rule: "non-allowlisted-entitlement-insert",
          file: file.path,
          detail:
            "INSERT INTO entitlement_instance poza allow-listą dozwolonych writerów " +
            "(Path Y + captured/reissue/retention) — inna ścieżka issue zakazana " +
            "(AC5, ADR-052/118); dopisz writer do ALLOWED_ENTITLEMENT_INSERT_WRITERS " +
            "tylko świadomie (gate review)",
        })
      }
    }

    // (3) CALL-site `createEntitlement…(` traktowany jako issue — zakaz.
    // Regex obejmuje RODZINĘ metod (`createEntitlement(`, `createEntitlementInstances(`
    // — idiomatyczna auto-generowana metoda module-service Medusy, M1). Definicja
    // stuba w gp-core/service.ts oraz sam checker (string literale) są
    // self-referential i wyłączone. Flagujemy realne WYWOŁANIA poza testami/komentarzami.
    if (!selfRef && /\bcreateEntitlement\w*\s*\(/.test(code)) {
      findings.push({
        rule: "create-entitlement-issue-callsite",
        file: file.path,
        detail:
          "wywołanie createEntitlement…(...) (GpCoreService / module-service) jako " +
          "ścieżki issue jest zakazane (ADR-052/118) — jedyną drogą do ISSUED jest " +
          "Path Y subscriber",
      })
    }
  }

  return findings
}

/** Rekurencyjnie czyta pliki `.ts` poniżej `root` (pomija node_modules/.medusa). */
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
 * Twardy gate (driver FS): skanuje drzewo `srcRoot` i RZUCA, gdy istnieje
 * jakakolwiek zakazana ścieżka issue. Do użycia w teście AC5 / walidatorze.
 */
export function assertPathYExclusive(srcRoot: string): void {
  const findings = scanForForbiddenIssuePaths(readSourceTree(srcRoot))
  if (findings.length > 0) {
    const lines = findings.map((f) => ` - [${f.rule}] ${f.file}: ${f.detail}`)
    throw new Error(
      `Path Y exclusivity naruszona (ADR-052/118) — zakazane ścieżki issue:\n${lines.join("\n")}`
    )
  }
}
