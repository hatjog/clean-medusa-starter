/**
 * entitlement-dedupe.test.ts — Story 3.3 AC4 (per-entitlement idempotencja).
 *
 * Kontrakt: ADR-137 DEC-5 pkt 3.ii (deterministyczny `entitlement_dedupe_key`),
 * finding L-2 (PEŁNY hex digest, BEZ truncacji), finding H-2 (pola net-new),
 * FR10 (jeden zakup ⇒ wiele entitlementów per-recipient).
 */
import { describe, it, expect } from "@jest/globals"
import { createHash } from "node:crypto"

import {
  buildEntitlementDedupeKey,
  ENTITLEMENT_DEDUPE_KEY_SEPARATOR,
  ENTITLEMENT_DEDUPE_KEY_COLUMN,
  ENTITLEMENT_DEDUPE_KEY_UNIQUE_INDEX,
  ENTITLEMENT_DEDUPE_ON_CONFLICT_CLAUSE,
} from "../models/entitlement-dedupe"

describe("Story 3.3 AC4 — buildEntitlementDedupeKey (DEC-5 pkt 3.ii)", () => {
  it("= sha256(pi ‖ line ‖ idx) PEŁNY hex digest 64 znaki (L-2: bez truncacji)", () => {
    const key = buildEntitlementDedupeKey("pi_abc", "li_1", 0)
    const expected = createHash("sha256")
      .update(`pi_abc${ENTITLEMENT_DEDUPE_KEY_SEPARATOR}li_1${ENTITLEMENT_DEDUPE_KEY_SEPARATOR}0`)
      .digest("hex")
    expect(key).toBe(expected)
    expect(key).toHaveLength(64)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it("jest deterministyczny (retry tego samego faktu ⇒ ten sam klucz)", () => {
    expect(buildEntitlementDedupeKey("pi_x", "li_9", 2)).toBe(
      buildEntitlementDedupeKey("pi_x", "li_9", 2)
    )
  })

  it("rozróżnia recipientów w obrębie jednego eventu (FR10 — różny idx ⇒ różny klucz)", () => {
    const r0 = buildEntitlementDedupeKey("pi_x", "li_9", 0)
    const r1 = buildEntitlementDedupeKey("pi_x", "li_9", 1)
    const r2 = buildEntitlementDedupeKey("pi_x", "li_9", 2)
    expect(new Set([r0, r1, r2]).size).toBe(3)
  })

  it("rozróżnia pozycje (różny line_item_id ⇒ różny klucz)", () => {
    expect(buildEntitlementDedupeKey("pi_x", "li_a", 0)).not.toBe(
      buildEntitlementDedupeKey("pi_x", "li_b", 0)
    )
  })

  it("separator eliminuje ambiguity konkatenacji (`pi_a`+`li` ≠ `pi`+`a_li`)", () => {
    // Bez separatora oba dałyby materiał "pi_ali0"; separator `‖` rozdziela
    // komponenty, więc digesty są różne.
    expect(buildEntitlementDedupeKey("pi_a", "li", 0)).not.toBe(
      buildEntitlementDedupeKey("pi", "a_li", 0)
    )
  })

  it("odrzuca puste komponenty + nie-int / ujemny recipient_index (fail-loud)", () => {
    expect(() => buildEntitlementDedupeKey("", "li", 0)).toThrow(/payment_intent_id/)
    expect(() => buildEntitlementDedupeKey("pi", "", 0)).toThrow(/line_item_id/)
    expect(() => buildEntitlementDedupeKey("pi", "li", -1)).toThrow(/recipient_index/)
    expect(() => buildEntitlementDedupeKey("pi", "li", 1.5)).toThrow(/recipient_index/)
  })

  it("eksportuje spójne stałe nazw kolumny/indeksu + klauzulę ON CONFLICT", () => {
    expect(ENTITLEMENT_DEDUPE_KEY_COLUMN).toBe("entitlement_dedupe_key")
    expect(ENTITLEMENT_DEDUPE_KEY_UNIQUE_INDEX).toBe("entitlement_instance_dedupe_key_uq")
    // Predykat `WHERE … IS NOT NULL` JEST WYMAGANY (korekta V1): docelowy index
    // `entitlement_instance_dedupe_key_uq` jest PARTIAL — PostgreSQL nie zinferuje
    // partial unique indexu z gołego `ON CONFLICT (col)` (rzuca „no unique or
    // exclusion constraint matching"). Predykat musi odpowiadać predykatowi indexu.
    expect(ENTITLEMENT_DEDUPE_ON_CONFLICT_CLAUSE).toBe(
      "ON CONFLICT (entitlement_dedupe_key) WHERE entitlement_dedupe_key IS NOT NULL DO NOTHING"
    )
  })
})
