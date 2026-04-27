/**
 * STORY-MIG-C — Application-code audit: ledger writers MUST set
 * posting_trigger to a non-sentinel domain value (T2.3, AC #7).
 *
 * v1.4.0 has no DB constraint guarding NULL writes — we rely on the
 * `assertPostingTrigger()` contract in src/lib/ledger/posting-trigger.ts.
 * This suite verifies that:
 *   1. The contract module rejects NULL / undefined / empty / whitespace.
 *   2. The contract module rejects the migration sentinel.
 *   3. Each known v1.4.0 trigger value is accepted.
 *   4. A static audit of the backend source confirms every site that
 *      writes to `ledger_entry` either supplies a literal known trigger
 *      or routes through assertPostingTrigger().
 *
 * If a new writer lands without using the contract, this suite fails —
 * the dev MUST add the writer to the audited list below or wire it
 * through `assertPostingTrigger()`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import {
  KNOWN_POSTING_TRIGGERS,
  LEGACY_POSTING_TRIGGER_SENTINEL,
  assertPostingTrigger,
  isKnownPostingTrigger,
  validatePostingTrigger,
} from "../../lib/ledger/posting-trigger";

describe("STORY-MIG-C — Posting-trigger contract (T2.3, AC #7)", () => {
  describe("validatePostingTrigger()", () => {
    it("rejects null", () => {
      const r = validatePostingTrigger(null);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("null_or_empty");
    });

    it("rejects undefined", () => {
      const r = validatePostingTrigger(undefined);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("null_or_empty");
    });

    it("rejects empty string", () => {
      const r = validatePostingTrigger("");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("null_or_empty");
    });

    it("rejects whitespace-only string", () => {
      const r = validatePostingTrigger("   ");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("null_or_empty");
    });

    it("rejects the legacy sentinel from app-code writers", () => {
      const r = validatePostingTrigger(LEGACY_POSTING_TRIGGER_SENTINEL);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe("sentinel_collision");
    });

    it("accepts every KNOWN_POSTING_TRIGGERS value", () => {
      for (const v of KNOWN_POSTING_TRIGGERS) {
        const r = validatePostingTrigger(v);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe(v);
      }
    });

    it("accepts a forward-compat unknown string (D-47 v1.4.0 free-text)", () => {
      const r = validatePostingTrigger("future_v15_trigger");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe("future_v15_trigger");
    });

    it("trims surrounding whitespace from accepted values", () => {
      const r = validatePostingTrigger("  order_placed  ");
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe("order_placed");
    });
  });

  describe("assertPostingTrigger()", () => {
    it("throws on NULL with a writer-aware message", () => {
      expect(() => assertPostingTrigger(null, { writer: "test_writer" })).toThrow(
        /writer=test_writer/
      );
    });

    it("throws on sentinel value with collision-specific message", () => {
      expect(() =>
        assertPostingTrigger(LEGACY_POSTING_TRIGGER_SENTINEL, { writer: "rogue" })
      ).toThrow(/sentinel value/);
    });

    it("returns the trimmed value on success", () => {
      expect(assertPostingTrigger("manual_adjustment")).toBe("manual_adjustment");
    });
  });

  describe("isKnownPostingTrigger()", () => {
    it("recognizes all known v1.4.0 values", () => {
      for (const v of KNOWN_POSTING_TRIGGERS) {
        expect(isKnownPostingTrigger(v)).toBe(true);
      }
    });

    it("returns false for the migration sentinel (sentinel is not a known trigger)", () => {
      expect(isKnownPostingTrigger(LEGACY_POSTING_TRIGGER_SENTINEL)).toBe(false);
    });

    it("returns false for unknown forward-compat values", () => {
      expect(isKnownPostingTrigger("future_value")).toBe(false);
    });
  });
});

/**
 * Static audit — scans the backend source for any writer that touches
 * `ledger_entry` and verifies it goes through the contract.
 *
 * v1.4.0 NOTE: the `ledger_entry` table is created/extended by this story.
 * As of writing this test, there are NO production writers in
 * GP/backend/src/modules/ — the migration lays the foundation. This suite
 * is the gate that fires when the FIRST writer lands. If no writer is
 * present, the suite passes vacuously (and asserts that no NULL/sentinel
 * writes leak through whatever placeholder code exists).
 */
describe("STORY-MIG-C — Static audit of ledger writers (T2.1)", () => {
  const backendRoot = path.resolve(__dirname, "../../..");
  const modulesRoot = path.resolve(backendRoot, "src/modules");
  const subscribersRoot = path.resolve(backendRoot, "src/subscribers");
  const workflowsRoot = path.resolve(backendRoot, "src/workflows");

  function* walkTs(root: string): Generator<string> {
    if (!fs.existsSync(root)) return;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        yield* walkTs(full);
      } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
        if (full.includes("__tests__") || full.endsWith(".d.ts")) continue;
        yield full;
      }
    }
  }

  type WriteSite = {
    file: string;
    line: number;
    snippet: string;
  };

  function findLedgerWrites(roots: string[]): WriteSite[] {
    const sites: WriteSite[] = [];
    const writePatterns = [
      /INSERT\s+INTO\s+ledger_entry/i,
      /UPDATE\s+ledger_entry/i,
      /\bledger_entry\s*\(/, // entity-builder pattern
      /\.ledger_entry\b/, // table reference in knex/orm chain
      /from\s+["']ledger_entry["']/i,
    ];
    for (const root of roots) {
      for (const file of walkTs(root)) {
        const content = fs.readFileSync(file, "utf8");
        const lines = content.split("\n");
        lines.forEach((line, i) => {
          for (const pat of writePatterns) {
            if (pat.test(line)) {
              sites.push({ file, line: i + 1, snippet: line.trim() });
              break;
            }
          }
        });
      }
    }
    return sites;
  }

  it("every ledger_entry writer routes through assertPostingTrigger() OR carries a literal known trigger", () => {
    const sites = findLedgerWrites([modulesRoot, subscribersRoot, workflowsRoot]);

    // For each writer file, look for either:
    //   - import of assertPostingTrigger / validatePostingTrigger, OR
    //   - a literal occurrence of a KNOWN_POSTING_TRIGGERS value, OR
    //   - explicit comment marker '/* v140-mig-c: structural-only, no writes */'
    const violations: string[] = [];
    const filesByPath = new Map<string, WriteSite[]>();
    for (const s of sites) {
      const arr = filesByPath.get(s.file) ?? [];
      arr.push(s);
      filesByPath.set(s.file, arr);
    }

    for (const [file, fileSites] of filesByPath) {
      const content = fs.readFileSync(file, "utf8");
      const importsContract =
        /from\s+["'][^"']*lib\/ledger\/posting-trigger["']/.test(content) ||
        /assertPostingTrigger\s*\(/.test(content) ||
        /validatePostingTrigger\s*\(/.test(content);
      const hasLiteralTrigger = KNOWN_POSTING_TRIGGERS.some((v) =>
        new RegExp(`["']${v}["']`).test(content)
      );
      const hasStructuralMarker = /v140-mig-c:\s*structural-only/.test(content);

      if (!importsContract && !hasLiteralTrigger && !hasStructuralMarker) {
        for (const s of fileSites) {
          violations.push(`${file}:${s.line}  ${s.snippet}`);
        }
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `Ledger writer(s) found that do NOT use assertPostingTrigger() and do NOT ` +
          `carry a literal known trigger value:\n  ` +
          violations.join("\n  ") +
          `\n\nFix: import { assertPostingTrigger } from "src/lib/ledger/posting-trigger" ` +
          `and pass the value through it before INSERT.`
      );
    }
    // Pass — either no writers (v1.4.0 baseline state) or all routed through contract.
    expect(violations).toHaveLength(0);
  });

  it("no writer ever supplies the migration sentinel as a literal", () => {
    const sites = findLedgerWrites([modulesRoot, subscribersRoot, workflowsRoot]);
    const filesByPath = new Set(sites.map((s) => s.file));
    const violations: string[] = [];
    for (const file of filesByPath) {
      const content = fs.readFileSync(file, "utf8");
      // Allow the contract module itself to mention the sentinel.
      if (file.endsWith("posting-trigger.ts")) continue;
      if (content.includes(`"${LEGACY_POSTING_TRIGGER_SENTINEL}"`)) {
        violations.push(file + " contains literal sentinel string");
      }
      if (content.includes(`'${LEGACY_POSTING_TRIGGER_SENTINEL}'`)) {
        violations.push(file + " contains literal sentinel string");
      }
    }
    expect(violations).toHaveLength(0);
  });
});
