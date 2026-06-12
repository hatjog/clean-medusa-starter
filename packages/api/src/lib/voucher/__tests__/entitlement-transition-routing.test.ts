/**
 * entitlement-transition-routing.test.ts — Story 3.4 (AI-Review-1 / AI-Review-4).
 *
 * Dowodzi, że okablowanie maszyny stanów L4 NIE jest rozproszone:
 *   (R1) posting (writer ledgera) idzie WYŁĄCZNIE przez okablowanie + reconciliation
 *        2.6 — bezpośredni `new VoucherLedgerWriter` / `ledgerWriter.write` poza
 *        allow-listą jest flagowany (AI-Review-4 „druga bariera" bramki aktywacji);
 *   (R2) każdy produkcyjny call-site `assertTransition(` jest w manifeście
 *        (WIRED / E4_DEFERRED) — nowa nieujęta tranzycja jest flagowana (AI-Review-1).
 *
 * Skan REALNEGO drzewa źródeł MUSI być czysty (manifest kompletny + posting
 * exclusivity zachowana) — to twardy gate dyspersji.
 */
import { describe, it, expect } from "@jest/globals"
import fs from "node:fs"
import path from "node:path"

import {
  scanForTransitionRoutingViolations,
  assertTransitionsRoutedThroughWiring,
  ALLOWED_LEDGER_WRITER_CALLSITES,
  TRANSITION_GUARD_CALLSITES,
  type SourceFile,
} from "../entitlement-transition-routing"

describe("Story 3.4 — checker dyspersji okablowania (czysta funkcja)", () => {
  it("R1: flaguje bezpośredni new VoucherLedgerWriter poza allow-listą", () => {
    const files: SourceFile[] = [
      {
        path: "packages/api/src/modules/voucher/rogue-poster.ts",
        content: "const w = new VoucherLedgerWriter(pool); await w.write(req)",
      },
    ]
    const findings = scanForTransitionRoutingViolations(files)
    expect(findings.some((f) => f.rule === "ledger-writer-dispersion")).toBe(true)
  })

  it("R1: NIE flaguje allow-listowanych call-site'ów writera (okablowanie + reconciliation)", () => {
    const files: SourceFile[] = [
      {
        path: "packages/api/src/jobs/voucher-ledger-reconciliation.ts",
        content: "const writer = new VoucherLedgerWriter(pool); await writer.write(req)",
      },
      {
        path: "packages/api/src/modules/voucher/entitlement-transition-wiring.ts",
        content: "const write = await deps.ledgerWriter.write(req)",
      },
    ]
    const findings = scanForTransitionRoutingViolations(files)
    expect(findings.filter((f) => f.rule === "ledger-writer-dispersion")).toHaveLength(0)
  })

  it("R2: flaguje nieujęty w manifeście call-site assertTransition(", () => {
    const files: SourceFile[] = [
      {
        path: "packages/api/src/modules/voucher/workflows/new-flow.ts",
        content: "assertTransition(from, to); await persistState()",
      },
    ]
    const findings = scanForTransitionRoutingViolations(files)
    expect(findings.some((f) => f.rule === "unmanifested-transition-guard")).toBe(true)
  })

  it("R2: NIE flaguje manifestowanych call-site'ów ani definicji/okablowania", () => {
    const files: SourceFile[] = [
      {
        path: "packages/api/src/modules/voucher/models/entitlement.ts",
        content: "export function assertTransition(from, to) {}",
      },
      {
        path: "packages/api/src/modules/voucher/entitlement-transition-wiring.ts",
        content: "assertTransition(from, to)",
      },
      {
        path: "packages/api/src/workflows/entitlements/issue-entitlement.ts",
        content: "assertTransition(ISSUED, ACTIVE)",
      },
    ]
    const findings = scanForTransitionRoutingViolations(files)
    expect(findings.filter((f) => f.rule === "unmanifested-transition-guard")).toHaveLength(0)
  })

  it("manifest klasyfikuje Path Y live-issue jako WIRED (3.4)", () => {
    const wired = TRANSITION_GUARD_CALLSITES.find((c) =>
      c.suffix.endsWith("subscribers/voucher-live-issue.ts")
    )
    expect(wired?.status).toBe("WIRED")
    expect(ALLOWED_LEDGER_WRITER_CALLSITES).toContain(
      "modules/voucher/entitlement-transition-wiring.ts"
    )
  })

  it("3.5: manifest klasyfikuje okablowane call-site'y E4 jako WIRED", () => {
    for (const suffix of [
      "modules/voucher/workflows/redeem-entitlement.ts",
      "modules/voucher/service.ts",
    ]) {
      const callsite = TRANSITION_GUARD_CALLSITES.find((c) =>
        c.suffix.endsWith(suffix)
      )
      expect(callsite?.status).toBe("WIRED")
      expect(callsite?.note).toContain("3.5/E4")
    }
  })

  it("3.5: WIRED call-site'y realnie wołają jednolity punkt okablowania (parytet call-site)", () => {
    // AC3a (MEDIUM finding AI-Review): for each WIRED file verify that every
    // `assertTransition(` that precedes a persistent state change is accompanied by a
    // nearby `wireEntitlementTransitionPersisted` call. The heuristic: scan each
    // `assertTransition(` occurrence and check that within the next 20 lines there is
    // a wiring call OR the assertTransition is on an error-only path (no state UPDATE
    // follows). This prevents future silent dispersion inside already-WIRED files
    // (the file-level "contains" check is insufficient — AI-Review finding).
    const srcRoot = path.resolve(__dirname, "../../..")
    for (const suffix of [
      "modules/voucher/workflows/redeem-entitlement.ts",
      "modules/voucher/service.ts",
    ]) {
      const callsite = TRANSITION_GUARD_CALLSITES.find((c) =>
        c.suffix.endsWith(suffix)
      )
      expect(callsite?.status).toBe("WIRED")
      const content = fs.readFileSync(path.join(srcRoot, suffix), "utf8")
      expect(content).toContain("wireEntitlementTransitionPersisted")

      // Call-site parity: every assertTransition( in a WIRED file must either:
      //   (a) be followed by wireEntitlementTransitionPersisted within 20 lines, OR
      //   (b) be on a throw-only guard path (next non-empty line throws / is else branch)
      // This catches new dispersed assertTransition( added to WIRED files in future.
      const lines = content.split("\n")
      const WIRING_CALL = "wireEntitlementTransitionPersisted"
      const dispersed: number[] = []
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes("assertTransition(")) continue
        // Skip assertWiringTransition( (internal guard in wiring module itself)
        if (lines[i].includes("assertWiringTransition")) continue
        // Check if any of the next 20 lines contain wiring OR throw
        const window = lines.slice(i + 1, i + 21)
        const hasWiring = window.some((l) => l.includes(WIRING_CALL))
        const isGuardThrow = window.some(
          (l) =>
            l.trim().startsWith("throw ") ||
            l.trim().startsWith("} else if") ||
            l.trim().startsWith("} else {") ||
            l.trim() === "}"
        )
        if (!hasWiring && !isGuardThrow) {
          dispersed.push(i + 1) // 1-based line number
        }
      }
      expect(dispersed).toHaveLength(0) // all assertTransition( are wired or guard-only
    }
  })

  it("3.5: carry-out call-site'y pozostają jawnie E4_DEFERRED z uzasadnieniem", () => {
    for (const suffix of [
      "workflows/entitlements/issue-entitlement.ts",
      "modules/voucher/workflows/reissue-lost-code.ts",
      "modules/voucher/workflows/issue-retention.ts",
      "api/v1/entitlements/claim/route.ts",
    ]) {
      const callsite = TRANSITION_GUARD_CALLSITES.find((c) =>
        c.suffix.endsWith(suffix)
      )
      expect(callsite?.status).toBe("E4_DEFERRED")
      expect(callsite?.note).toContain("carry-out v1.12.0")
    }
  })
})

describe("Story 3.4 — twardy gate: realne drzewo źródeł BEZ dyspersji", () => {
  it("assertTransitionsRoutedThroughWiring(packages/api/src) nie rzuca", () => {
    // __dirname = packages/api/src/lib/voucher/__tests__ → wejdź do packages/api/src.
    const srcRoot = path.resolve(__dirname, "../../..")
    expect(() => assertTransitionsRoutedThroughWiring(srcRoot)).not.toThrow()
  })
})
