/**
 * path-y-exclusivity.test.ts — Story 3.3 AC5 (wyłączność Path Y, ADR-052/118).
 *
 * Dowodzi, że checker WYKRYWA i BLOKUJE zakazane ścieżki issue (custom route +
 * `GpCoreService.createEntitlement` jako issue) ORAZ że realne drzewo źródeł GP
 * NIE narusza wyłączności (jedyna droga do ISSUED = Path Y subscriber/writer).
 */
import { describe, it, expect } from "@jest/globals"
import path from "node:path"

import {
  scanForForbiddenIssuePaths,
  assertPathYExclusive,
  readSourceTree,
  type SourceFile,
} from "../path-y-exclusivity"

describe("Story 3.3 AC5 — scanForForbiddenIssuePaths (wykrywa Path X)", () => {
  it("flaguje custom route, który INSERT-uje entitlement_instance (Path X)", () => {
    const files: SourceFile[] = [
      {
        path: "packages/api/src/api/store/evil-issue/route.ts",
        content: `export async function POST() {
          await db.query("INSERT INTO entitlement_instance (id, state) VALUES ($1,'ISSUED')")
        }`,
      },
    ]
    const findings = scanForForbiddenIssuePaths(files)
    expect(findings).toHaveLength(1)
    expect(findings[0].rule).toBe("custom-route-issue")
  })

  it("flaguje wywołanie createEntitlement(...) poza definicją stuba", () => {
    const files: SourceFile[] = [
      {
        path: "packages/api/src/subscribers/evil.ts",
        content: `await gpCore.createEntitlement({ order_id })`,
      },
    ]
    const findings = scanForForbiddenIssuePaths(files)
    expect(findings.some((f) => f.rule === "create-entitlement-issue-callsite")).toBe(true)
  })

  it("NIE flaguje definicji stuba w gp-core/service.ts", () => {
    const files: SourceFile[] = [
      {
        path: "packages/api/src/modules/gp-core/service.ts",
        content: `async createEntitlement(_dto) { throw new NotImplementedError() }`,
      },
    ]
    expect(scanForForbiddenIssuePaths(files)).toHaveLength(0)
  })

  it("NIE flaguje wzmianki createEntitlement w komentarzu", () => {
    const files: SourceFile[] = [
      {
        path: "packages/api/src/subscribers/note.ts",
        content: `/* historically called gpCore.createEntitlement(...) — now removed */\nexport const x = 1`,
      },
    ]
    expect(scanForForbiddenIssuePaths(files)).toHaveLength(0)
  })

  it("NIE flaguje writera Path Y (workflow, nie api route) ani subscribera Path Y", () => {
    const files: SourceFile[] = [
      {
        path: "packages/api/src/workflows/entitlements/live-issue-from-payment-intent.ts",
        content: `await client.query("INSERT INTO entitlement_instance (...) VALUES (...)")`,
      },
      {
        path: "packages/api/src/subscribers/voucher-live-issue.ts",
        content: `await liveIssueEntitlementsWithinTx(client, input, new Date())`,
      },
    ]
    expect(scanForForbiddenIssuePaths(files)).toHaveLength(0)
  })

  // ── M1: realistyczne obejścia (false-negatives w starym checkerze) ──────────
  it("(M1) flaguje INSERT entitlement_instance w SUBSCRIBERZE poza Path Y (nie tylko route)", () => {
    const files: SourceFile[] = [
      {
        path: "packages/api/src/subscribers/rogue-issuer.ts",
        content: `export default async function () {
          await client.query("INSERT INTO entitlement_instance (id, state) VALUES ($1,'ISSUED')")
        }`,
      },
    ]
    const findings = scanForForbiddenIssuePaths(files)
    expect(findings.some((f) => f.rule === "non-allowlisted-entitlement-insert")).toBe(true)
  })

  it("(M1) flaguje INSERT przez module-service / repository (workflow voucher poza allow-listą)", () => {
    const files: SourceFile[] = [
      {
        path: "packages/api/src/modules/voucher/workflows/sneaky-issue.ts",
        content: `await this.manager_.execute("INSERT INTO entitlement_instance (id) VALUES ($1)")`,
      },
    ]
    const findings = scanForForbiddenIssuePaths(files)
    expect(findings.some((f) => f.rule === "non-allowlisted-entitlement-insert")).toBe(true)
  })

  it("(M1) flaguje createEntitlementInstances(...) (auto-generowana metoda module-service Medusy)", () => {
    const files: SourceFile[] = [
      {
        path: "packages/api/src/subscribers/evil-service.ts",
        content: `await voucherModuleService.createEntitlementInstances([{ order_id }])`,
      },
    ]
    const findings = scanForForbiddenIssuePaths(files)
    expect(findings.some((f) => f.rule === "create-entitlement-issue-callsite")).toBe(true)
  })

  it("(M1) NIE flaguje legalnych writerów z allow-listy (captured/reissue/retention)", () => {
    const files: SourceFile[] = [
      {
        path: "packages/api/src/workflows/entitlements/issue-entitlement.ts",
        content: `await client.query("INSERT INTO entitlement_instance (...) VALUES (...)")`,
      },
      {
        path: "packages/api/src/modules/voucher/workflows/reissue-lost-code.ts",
        content: `await client.query(\`INSERT INTO entitlement_instance (\${columns}) VALUES (...)\`)`,
      },
      {
        path: "packages/api/src/modules/voucher/workflows/issue-retention.ts",
        content: `await client.query(\`INSERT INTO entitlement_instance (\${columns}) VALUES (...)\`)`,
      },
    ]
    expect(scanForForbiddenIssuePaths(files)).toHaveLength(0)
  })
})

describe("Story 3.3 AC5 — realne drzewo źródeł GP respektuje wyłączność Path Y", () => {
  it("assertPathYExclusive nie rzuca na packages/api/src", () => {
    const srcRoot = path.resolve(__dirname, "../../..") // packages/api/src
    // sanity: drzewo zostało odczytane
    expect(readSourceTree(srcRoot).length).toBeGreaterThan(0)
    expect(() => assertPathYExclusive(srcRoot)).not.toThrow()
  })
})
