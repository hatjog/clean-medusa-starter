/**
 * STORY-MIG-B AC #1 + AC #8 — schema validation against the frozen
 * `order_placed.v2.schema.json` baseline (P-01 ownership lock).
 *
 * Scope: assert that every envelope produced by `composeOrderPlacedV2`
 * (including the gift + non-gift example payloads in
 * `specs/contracts/events/examples/`) satisfies the frozen schema's
 * required-fields, type, enum, and pattern constraints.
 *
 * Strategy: ship a lightweight in-process validator that mirrors the subset
 * of JSON Schema we use (required, type, enum, pattern, const, minimum). This
 * matches the validate_contracts.py shape — same semantics, same coverage —
 * so the unit suite gates merge before the Python validator runs in CI.
 *
 * Invocation:
 *   cd GP/backend && yarn test:unit -- src/__tests__/events/orderplaced-v2-schema-validation.test.ts
 */

import { describe, it, expect } from "@jest/globals"
import * as fs from "node:fs"
import * as path from "node:path"

import {
  composeOrderPlacedV2,
  type OrderPlacedComposeInput,
} from "../../lib/events/orderplaced-v2-publisher"

const REPO_ROOT = path.resolve(__dirname, "../../../../..")
const SCHEMA_PATH = path.resolve(
  REPO_ROOT,
  "specs/contracts/events/schemas/order_placed.v2.schema.json"
)
const GIFT_EXAMPLE_PATH = path.resolve(
  REPO_ROOT,
  "specs/contracts/events/examples/order_placed.v2.gift-example.json"
)
const NON_GIFT_EXAMPLE_PATH = path.resolve(
  REPO_ROOT,
  "specs/contracts/events/examples/order_placed.v2.non-gift-example.json"
)

function loadJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"))
}

const giftExample = loadJson(GIFT_EXAMPLE_PATH)
const nonGiftExample = loadJson(NON_GIFT_EXAMPLE_PATH)

type JsonSchema = Record<string, any>

function loadSchema(): JsonSchema {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf-8")) as JsonSchema
}

function isType(value: unknown, expected: string | string[]): boolean {
  const types = Array.isArray(expected) ? expected : [expected]
  for (const t of types) {
    if (t === "string" && typeof value === "string") return true
    if (t === "integer" && typeof value === "number" && Number.isInteger(value))
      return true
    if (t === "number" && typeof value === "number") return true
    if (t === "object" && value !== null && typeof value === "object" && !Array.isArray(value))
      return true
    if (t === "array" && Array.isArray(value)) return true
    if (t === "boolean" && typeof value === "boolean") return true
    if (t === "null" && value === null) return true
  }
  return false
}

/** Lightweight schema validator (subset matching validate_contracts.py). */
function validate(value: any, schema: JsonSchema, breadcrumb: string, errors: string[]): void {
  if (!schema || typeof schema !== "object") return

  if (schema.type !== undefined && !isType(value, schema.type)) {
    errors.push(`${breadcrumb}: expected type ${JSON.stringify(schema.type)} got ${typeof value}`)
    return
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${breadcrumb}: expected const ${JSON.stringify(schema.const)} got ${JSON.stringify(value)}`)
  }

  if (schema.enum !== undefined && value !== null) {
    if (!schema.enum.includes(value)) {
      errors.push(`${breadcrumb}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`)
    }
  }

  if (schema.pattern !== undefined && typeof value === "string") {
    const re = new RegExp(schema.pattern)
    if (!re.test(value)) {
      errors.push(`${breadcrumb}: '${value}' does not match pattern ${schema.pattern}`)
    }
  }

  if (schema.minLength !== undefined && typeof value === "string") {
    if (value.length < schema.minLength) {
      errors.push(`${breadcrumb}: length ${value.length} < ${schema.minLength}`)
    }
  }

  if (schema.minimum !== undefined && typeof value === "number") {
    if (value < schema.minimum) {
      errors.push(`${breadcrumb}: ${value} < minimum ${schema.minimum}`)
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (Array.isArray(schema.required)) {
      for (const k of schema.required) {
        if (!(k in value)) {
          errors.push(`${breadcrumb}: missing required field ${k}`)
        }
      }
    }
    if (typeof schema.properties === "object") {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in value) {
          validate(value[k], sub as JsonSchema, `${breadcrumb}.${k}`, errors)
        }
      }
    }
    if (schema.additionalProperties === false && typeof schema.properties === "object") {
      for (const k of Object.keys(value)) {
        if (!(k in schema.properties)) {
          errors.push(`${breadcrumb}: additional property '${k}' not allowed`)
        }
      }
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${breadcrumb}: length ${value.length} < minItems ${schema.minItems}`)
    }
    if (schema.items) {
      value.forEach((item, idx) => validate(item, schema.items, `${breadcrumb}[${idx}]`, errors))
    }
  }
}

describe("STORY-MIG-B AC #1 + AC #8 — schema validation (frozen baseline)", () => {
  const schema = loadSchema()

  it("schema $id and title remain locked at the P-01 baseline", () => {
    expect(schema.title).toBe("GP OrderPlaced Event v2")
    expect(schema.$id).toContain("order_placed.v2.schema.json")
  })

  it("gift example payload validates against the frozen schema", () => {
    const errors: string[] = []
    validate(giftExample, schema, "$", errors)
    expect(errors).toEqual([])
  })

  it("non-gift example payload validates against the frozen schema", () => {
    const errors: string[] = []
    validate(nonGiftExample, schema, "$", errors)
    expect(errors).toEqual([])
  })

  it("composeOrderPlacedV2 output validates for a non-gift order", () => {
    const input: OrderPlacedComposeInput = {
      event_id: "01J_TEST_NG_001",
      occurred_at: "2026-04-27T12:00:00Z",
      idempotency_key: "order:test-ng-001",
      actor: "end_customer",
      scope: { instance_id: "gp-prod", market_id: "bonbeauty-pl" },
      order: {
        order_id: "test-ng-001",
        currency: "PLN",
        total_amount_minor: 19900,
        line_items: [
          {
            line_item_id: "li_001",
            offer_id: "offer_x",
            offer_version: "1.4.0",
            pricing_snapshot: {
              currency: "PLN",
              unit_amount_minor: 19900,
              quantity: 1,
              total_amount_minor: 19900,
            },
          },
        ],
      },
      mor: {
        sale_mor: "operator",
        service_mor: "operator",
        mor_policy_version: "1.0.0",
        voucher_kind: "none",
        breakage_policy_snapshot: {
          policy_id: null,
          policy_version: null,
          recognition_mode: null,
          expiry_grace_days: null,
        },
      },
      market_runtime_config: {
        market_id: "bonbeauty-pl",
        locales: { default: "pl-PL" },
        feature_flags: { orderplaced_v2_emission_enabled: true },
      },
    }
    const envelope = composeOrderPlacedV2(input)
    const errors: string[] = []
    validate(envelope, schema, "$", errors)
    expect(errors).toEqual([])
    expect(envelope.payload.recipient_locale).toBeNull()
    expect(envelope.payload.is_gift).toBe(false)
  })

  it("composeOrderPlacedV2 output validates for a gift order with explicit recipient_locale", () => {
    const input: OrderPlacedComposeInput = {
      event_id: "01J_TEST_GFT_001",
      occurred_at: "2026-04-27T12:00:00Z",
      idempotency_key: "order:test-gift-001",
      actor: "end_customer",
      scope: { instance_id: "gp-prod", market_id: "bonbeauty-pl" },
      order: {
        order_id: "test-gift-001",
        currency: "PLN",
        total_amount_minor: 35000,
        line_items: [
          {
            line_item_id: "li_001",
            offer_id: "offer_voucher_spa",
            offer_version: "1.4.0",
            voucher_kind: "MPV",
            pricing_snapshot: {
              currency: "PLN",
              unit_amount_minor: 35000,
              quantity: 1,
              total_amount_minor: 35000,
            },
          },
        ],
      },
      mor: {
        sale_mor: "operator",
        service_mor: "vendor",
        mor_policy_version: "1.0.0",
        voucher_kind: "MPV",
        breakage_policy_snapshot: {
          policy_id: "breakage.bonbeauty-pl.operator_full",
          policy_version: "0.1.0",
          recognition_mode: "operator_full",
          expiry_grace_days: 30,
        },
      },
      market_runtime_config: {
        market_id: "bonbeauty-pl",
        locales: { default: "pl-PL" },
        feature_flags: { orderplaced_v2_emission_enabled: true },
      },
      gift: { is_gift: true, recipient_locale: "en-GB" },
    }
    const envelope = composeOrderPlacedV2(input)
    const errors: string[] = []
    validate(envelope, schema, "$", errors)
    expect(errors).toEqual([])
    expect(envelope.payload.recipient_locale).toBe("en-GB")
    expect(envelope.payload.is_gift).toBe(true)
    expect(envelope.payload.message_locale).toBeNull()
  })

  it("recipient_locale BCP47 pattern accepts standard tags + rejects malformed ones", () => {
    const pattern = new RegExp(
      schema.properties.payload.properties.recipient_locale.pattern as string
    )
    expect(pattern.test("pl-PL")).toBe(true)
    expect(pattern.test("en-GB")).toBe(true)
    expect(pattern.test("zh-Hant-TW")).toBe(true)
    expect(pattern.test("en")).toBe(true)
    expect(pattern.test("not_a_locale")).toBe(false)
    expect(pattern.test("123")).toBe(false)
  })

  it("event_type const is locked to gp.commerce.order_placed.v2", () => {
    expect(schema.properties.event_type.const).toBe("gp.commerce.order_placed.v2")
  })

  it("schema_version const is locked to '2'", () => {
    expect(schema.properties.schema_version.const).toBe("2")
  })

  it("payload.required = order_id, currency, total_amount_minor, line_items, mor, recipient_locale", () => {
    expect(schema.properties.payload.required).toEqual([
      "order_id",
      "currency",
      "total_amount_minor",
      "line_items",
      "mor",
      "recipient_locale",
    ])
  })
})
