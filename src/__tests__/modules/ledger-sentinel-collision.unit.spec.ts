/**
 * STORY-MIG-C — Sentinel value collision (Risks §"Sentinel value collision").
 *
 * The sentinel `'legacy-pre-v1.4.0'` is intentionally namespaced so it
 * cannot collide with a real D-47 domain trigger value. This suite locks
 * that property:
 *
 *   1. The sentinel is NOT a member of KNOWN_POSTING_TRIGGERS.
 *   2. The sentinel includes the version namespace `v1.4.0`.
 *   3. The sentinel is NOT accidentally accepted by the contract validator.
 *   4. assertPostingTrigger() throws specifically when handed the sentinel.
 *   5. The migration class exposes the sentinel as a constant — no string
 *      drift between the migration and the contract module.
 *   6. Every `KNOWN_POSTING_TRIGGERS` value passes the validator (no
 *      accidental collision with the sentinel-rejection branch).
 */

import { Migration20260427000000AddPostingTriggerToLedgerEntry } from "../../migrations/Migration20260427000000AddPostingTriggerToLedgerEntry";
import {
  KNOWN_POSTING_TRIGGERS,
  LEGACY_POSTING_TRIGGER_SENTINEL,
  assertPostingTrigger,
  isKnownPostingTrigger,
  validatePostingTrigger,
} from "../../lib/ledger/posting-trigger";

describe("STORY-MIG-C — Sentinel value collision (Risks)", () => {
  it("sentinel is NOT a member of KNOWN_POSTING_TRIGGERS", () => {
    expect(KNOWN_POSTING_TRIGGERS).not.toContain(
      LEGACY_POSTING_TRIGGER_SENTINEL as never
    );
  });

  it("sentinel embeds the version namespace 'v1.4.0' (collision avoidance)", () => {
    expect(LEGACY_POSTING_TRIGGER_SENTINEL).toMatch(/v1\.4\.0/);
    expect(LEGACY_POSTING_TRIGGER_SENTINEL).toBe("legacy-pre-v1.4.0");
  });

  it("validator rejects the sentinel with the sentinel_collision reason", () => {
    const r = validatePostingTrigger(LEGACY_POSTING_TRIGGER_SENTINEL);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("sentinel_collision");
    }
  });

  it("assertPostingTrigger throws specifically on sentinel collision", () => {
    expect(() => assertPostingTrigger(LEGACY_POSTING_TRIGGER_SENTINEL)).toThrow(
      /reserved for the v1\.4\.0 backfill migration/
    );
  });

  it("migration class constant matches contract-module sentinel — zero string drift", () => {
    expect(Migration20260427000000AddPostingTriggerToLedgerEntry.LEGACY_SENTINEL).toBe(
      LEGACY_POSTING_TRIGGER_SENTINEL
    );
  });

  it("every KNOWN_POSTING_TRIGGERS value is accepted by the validator", () => {
    for (const v of KNOWN_POSTING_TRIGGERS) {
      const r = validatePostingTrigger(v);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(v);
    }
  });

  it("isKnownPostingTrigger returns false for the sentinel — false-positive guard", () => {
    expect(isKnownPostingTrigger(LEGACY_POSTING_TRIGGER_SENTINEL)).toBe(false);
  });

  it("forward-compat values (unknown but non-sentinel) are accepted by the validator", () => {
    // D-47 v1.4.0 column is free-text; this guards against the sentinel branch
    // accidentally rejecting values that happen to share a substring.
    const candidates = [
      "legacy-other",
      "pre-v1.4.0-not-sentinel",
      "v1.4.0-future",
      "order_placed_v2",
    ];
    for (const c of candidates) {
      const r = validatePostingTrigger(c);
      expect(r.ok).toBe(true);
    }
  });

  it("sentinel string does NOT match a known D-47 enum proposal value", () => {
    // Lock the property: every enum-proposal value is structurally distinct
    // from the sentinel. If someone proposes `'legacy-pre-v1.4.0'` as a
    // domain value in the future, this test surfaces the conflict before
    // the C3 NOT NULL constraint lands.
    for (const v of KNOWN_POSTING_TRIGGERS) {
      expect(v).not.toBe(LEGACY_POSTING_TRIGGER_SENTINEL);
      expect(v).not.toMatch(/legacy-pre-/);
    }
  });
});
