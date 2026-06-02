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
 *   (2) `GpCoreService.createEntitlement(...)` jako ścieżka issue — w GP jest to
 *       jawnie stub `NotImplementedError`; CALL-site w kodzie produkcyjnym, który
 *       traktowałby go jako issue, jest zakazany (ADR-052/118).
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

export type SourceFile = { path: string; content: string }

export type ExclusivityFinding = {
  rule: "custom-route-issue" | "create-entitlement-issue-callsite"
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
  return /INSERT\s+INTO\s+entitlement_instance/i.test(code)
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

    // (1) custom route, który ISSUE-uje entitlement (Path X) — zakaz.
    if (isApiRoute(file.path) && containsEntitlementInsert(code)) {
      findings.push({
        rule: "custom-route-issue",
        file: file.path,
        detail:
          "custom HTTP route wstawia entitlement_instance (Path X zakazany) — " +
          "issue musi przejść przez Path Y subscriber (ADR-052/118)",
      })
    }

    // (2) CALL-site `createEntitlement(` traktowany jako issue — zakaz.
    // Definicja stuba w gp-core/service.ts (rzuca NotImplementedError) jest OK;
    // sam plik checkera nazywa zakazany symbol w komunikatach findingów (string
    // literal, nie wywołanie) — oba są self-referential i wyłączone z reguły.
    // Flagujemy realne WYWOŁANIA poza testami/komentarzami.
    const normalized = file.path.replace(/\\/g, "/")
    const isSelfReferential =
      normalized.endsWith("modules/gp-core/service.ts") ||
      normalized.endsWith("lib/voucher/path-y-exclusivity.ts")
    if (!isSelfReferential && /\bcreateEntitlement\s*\(/.test(code)) {
      findings.push({
        rule: "create-entitlement-issue-callsite",
        file: file.path,
        detail:
          "wywołanie GpCoreService.createEntitlement(...) jako ścieżki issue jest " +
          "zakazane (ADR-052/118) — jedyną drogą do ISSUED jest Path Y subscriber",
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
