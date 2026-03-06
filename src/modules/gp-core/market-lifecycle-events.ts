import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

import type { GpCoreMarketRecord, GpCoreVertical, UpdateMarketInput } from "./models"

export const MARKET_CREATED_EVENT = "gp.markets.market_created.v1"
export const MARKET_UPDATED_EVENT = "gp.markets.market_updated.v1"

export type MarketLifecycleStatus = "active" | "provisioning" | "suspended"
export type MarketUpdatedBy = "system" | "admin"
export type MarketEventActor = "system" | "market_operator"
export type MarketMutableField =
  | "name"
  | "vertical_id"
  | "status"
  | "sales_channel_id"
  | "payload_vendor_id"

export type MarketChange = {
  old: unknown
  new: unknown
}

export type MarketRecordChanges = Partial<Record<MarketMutableField, MarketChange>>

export type MarketCreatedPayload = {
  market_id: string
  slug: string
  name: string
  vertical_id: string
  vertical_slug?: string
  sales_channel_id: string | null
  status: MarketLifecycleStatus
  instance_id: string
}

export type MarketUpdatedPayload = {
  market_id: string
  slug: string
  changes: Record<string, MarketChange>
  status: MarketLifecycleStatus
  updated_by: MarketUpdatedBy
}

export type GpEventEnvelope<TPayload> = {
  schema_version: "1"
  event_type: string
  occurred_at: string
  actor: "market_operator" | "vendor_user" | "end_customer" | "system"
  scope: {
    instance_id: string
    market_id: string
    vendor_id?: string | null
    location_id?: string | null
  }
  idempotency_key: string
  correlation_id?: string
  causation_id?: string
  trace_id?: string
  payload: TPayload
}

type JsonSchema = {
  type?: string | string[]
  required?: string[]
  properties?: Record<string, JsonSchema>
  additionalProperties?: boolean | JsonSchema
  enum?: unknown[]
  const?: unknown
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
  minimum?: number
  minProperties?: number
  items?: JsonSchema
  minItems?: number
}

type ValidationIssue = {
  path: string
  message: string
}

const REPO_ROOT = path.resolve(__dirname, "../../../../../")
const EVENT_CONTRACTS_ROOT = path.resolve(REPO_ROOT, "specs/contracts/events")
const ENVELOPE_SCHEMA_PATH = path.resolve(
  EVENT_CONTRACTS_ROOT,
  "schemas/envelope.v1.schema.json"
)
const SCHEMA_CACHE = new Map<string, JsonSchema>()
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class SchemaValidationError extends Error {
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "))
    this.name = "SchemaValidationError"
    this.issues = issues
  }
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function normalizeNullable(value: string | null | undefined): string | null {
  return value ?? null
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`
  }

  if (isObjectLike(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`
  }

  return JSON.stringify(value)
}

function buildHash(input: string): string {
  return createHash("sha1").update(input).digest("hex")
}

function readSchema(schemaPath: string): JsonSchema {
  const cached = SCHEMA_CACHE.get(schemaPath)
  if (cached) {
    return cached
  }

  const parsed = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as JsonSchema
  SCHEMA_CACHE.set(schemaPath, parsed)
  return parsed
}

function matchesSchemaType(value: unknown, expectedType: string): boolean {
  switch (expectedType) {
    case "string":
      return typeof value === "string"
    case "object":
      return isObjectLike(value)
    case "array":
      return Array.isArray(value)
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
    case "number":
      return typeof value === "number" && Number.isFinite(value)
    case "boolean":
      return typeof value === "boolean"
    case "null":
      return value === null
    default:
      return true
  }
}

function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  valuePath: string,
  issues: ValidationIssue[]
): void {
  if (!schema || typeof schema !== "object") {
    return
  }

  if (Object.prototype.hasOwnProperty.call(schema, "const") && value !== schema.const) {
    issues.push({ path: valuePath, message: `must equal ${JSON.stringify(schema.const)}` })
    return
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push({ path: valuePath, message: `must be one of ${schema.enum.join(", ")}` })
    return
  }

  if (schema.type) {
    const expectedTypes = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!expectedTypes.some((expectedType) => matchesSchemaType(value, expectedType))) {
      issues.push({
        path: valuePath,
        message: `must be of type ${expectedTypes.join(" | ")}`,
      })
      return
    }
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      issues.push({ path: valuePath, message: `must have minLength ${schema.minLength}` })
    }

    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      issues.push({ path: valuePath, message: `must have maxLength ${schema.maxLength}` })
    }

    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) {
      issues.push({ path: valuePath, message: `must match pattern ${schema.pattern}` })
    }

    if (schema.format === "uuid" && !UUID_RE.test(value)) {
      issues.push({ path: valuePath, message: "must be a valid uuid" })
    }

    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
      issues.push({ path: valuePath, message: "must be a valid date-time" })
    }
  }

  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
    issues.push({ path: valuePath, message: `must be >= ${schema.minimum}` })
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      issues.push({ path: valuePath, message: `must contain at least ${schema.minItems} item(s)` })
    }

    if (schema.items) {
      value.forEach((item, index) => {
        validateAgainstSchema(item, schema.items as JsonSchema, `${valuePath}[${index}]`, issues)
      })
    }
  }

  if (isObjectLike(value)) {
    if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
      issues.push({ path: valuePath, message: `must have at least ${schema.minProperties} propert${schema.minProperties === 1 ? "y" : "ies"}` })
    }

    for (const requiredKey of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, requiredKey)) {
        issues.push({ path: valuePath, message: `missing required field '${requiredKey}'` })
      }
    }

    const properties = schema.properties ?? {}
    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, propertyName)) {
        continue
      }

      validateAgainstSchema(value[propertyName], propertySchema, `${valuePath}.${propertyName}`, issues)
    }

    for (const [propertyName, propertyValue] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, propertyName)) {
        continue
      }

      if (schema.additionalProperties === false) {
        issues.push({ path: `${valuePath}.${propertyName}`, message: "is not allowed" })
        continue
      }

      if (isObjectLike(schema.additionalProperties)) {
        validateAgainstSchema(
          propertyValue,
          schema.additionalProperties,
          `${valuePath}.${propertyName}`,
          issues
        )
      }
    }
  }
}

function payloadSchemaPathFor(eventType: string): string {
  return path.resolve(
    EVENT_CONTRACTS_ROOT,
    `schemas/payloads/${eventType}.schema.json`
  )
}

function validateSchemaOrThrow(value: unknown, schema: JsonSchema, valuePath: string): void {
  const issues: ValidationIssue[] = []
  validateAgainstSchema(value, schema, valuePath, issues)

  if (issues.length > 0) {
    throw new SchemaValidationError(issues)
  }
}

function eventActorFromUpdatedBy(updatedBy: MarketUpdatedBy): MarketEventActor {
  return updatedBy === "admin" ? "market_operator" : "system"
}

function buildEnvelope<TPayload>(args: {
  eventType: string
  actor: GpEventEnvelope<TPayload>["actor"]
  market: Pick<GpCoreMarketRecord, "id" | "instance_id"> 
  idempotencyKey: string
  payload: TPayload
  correlation_id?: string
  causation_id?: string
  trace_id?: string
}): GpEventEnvelope<TPayload> {
  const envelope: GpEventEnvelope<TPayload> = {
    schema_version: "1",
    event_type: args.eventType,
    occurred_at: new Date().toISOString(),
    actor: args.actor,
    scope: {
      instance_id: args.market.instance_id,
      market_id: args.market.id,
    },
    idempotency_key: args.idempotencyKey,
    payload: args.payload,
  }

  if (args.correlation_id) {
    envelope.correlation_id = args.correlation_id
  }

  if (args.causation_id) {
    envelope.causation_id = args.causation_id
  }

  if (args.trace_id) {
    envelope.trace_id = args.trace_id
  }

  return envelope
}

export function normalizeMarketLifecycleStatus(status: string): MarketLifecycleStatus {
  switch (status) {
    case "active":
    case "published":
      return "active"
    case "draft":
    case "provisioning":
      return "provisioning"
    case "inactive":
    case "suspended":
      return "suspended"
    default:
      throw new Error(`Unsupported market lifecycle status '${status}'`)
  }
}

export function buildMarketUpdatePatch(
  before: GpCoreMarketRecord,
  update: UpdateMarketInput
): Partial<Record<MarketMutableField, unknown>> {
  const patch: Partial<Record<MarketMutableField, unknown>> = {}

  if (update.name !== undefined && update.name !== before.name) {
    patch.name = update.name
  }

  if (update.vertical_id !== undefined && update.vertical_id !== before.vertical_id) {
    patch.vertical_id = update.vertical_id
  }

  if (update.status !== undefined && update.status !== before.status) {
    patch.status = update.status
  }

  const nextSalesChannelId = normalizeNullable(update.sales_channel_id)
  if (
    update.sales_channel_id !== undefined &&
    nextSalesChannelId !== before.sales_channel_id
  ) {
    patch.sales_channel_id = nextSalesChannelId
  }

  const nextPayloadVendorId = normalizeNullable(update.payload_vendor_id)
  if (
    update.payload_vendor_id !== undefined &&
    nextPayloadVendorId !== before.payload_vendor_id
  ) {
    patch.payload_vendor_id = nextPayloadVendorId
  }

  return patch
}

export function buildMarketRecordChanges(
  before: GpCoreMarketRecord,
  after: GpCoreMarketRecord
): MarketRecordChanges {
  const changes: MarketRecordChanges = {}

  if (before.name !== after.name) {
    changes.name = { old: before.name, new: after.name }
  }

  if (before.vertical_id !== after.vertical_id) {
    changes.vertical_id = { old: before.vertical_id, new: after.vertical_id }
  }

  if (
    normalizeMarketLifecycleStatus(before.status) !==
    normalizeMarketLifecycleStatus(after.status)
  ) {
    changes.status = {
      old: normalizeMarketLifecycleStatus(before.status),
      new: normalizeMarketLifecycleStatus(after.status),
    }
  }

  if (before.sales_channel_id !== after.sales_channel_id) {
    changes.sales_channel_id = {
      old: before.sales_channel_id,
      new: after.sales_channel_id,
    }
  }

  if (before.payload_vendor_id !== after.payload_vendor_id) {
    changes.payload_vendor_id = {
      old: before.payload_vendor_id,
      new: after.payload_vendor_id,
    }
  }

  return changes
}

export function buildMarketCreatedEnvelope(args: {
  market: GpCoreMarketRecord
  vertical: Pick<GpCoreVertical, "slug">
}): GpEventEnvelope<MarketCreatedPayload> {
  const payload: MarketCreatedPayload = {
    market_id: args.market.id,
    slug: args.market.slug,
    name: args.market.name,
    vertical_id: args.market.vertical_id,
    vertical_slug: args.vertical.slug,
    sales_channel_id: args.market.sales_channel_id,
    status: normalizeMarketLifecycleStatus(args.market.status),
    instance_id: args.market.instance_id,
  }

  const envelope = buildEnvelope({
    eventType: MARKET_CREATED_EVENT,
    actor: "system",
    market: args.market,
    idempotencyKey: `market:created:${args.market.instance_id}:${args.market.id}`,
    payload,
  })

  assertEventEnvelopeMatchesContract(envelope, MARKET_CREATED_EVENT)
  return envelope
}

export function buildMarketUpdatedEnvelope(args: {
  before: GpCoreMarketRecord
  after: GpCoreMarketRecord
  changes: MarketRecordChanges
  updatedBy: MarketUpdatedBy
}): GpEventEnvelope<MarketUpdatedPayload> {
  const normalizedChanges = Object.fromEntries(
    Object.entries(args.changes).map(([key, value]) => [key, value])
  )

  const payload: MarketUpdatedPayload = {
    market_id: args.after.id,
    slug: args.after.slug,
    changes: normalizedChanges,
    status: normalizeMarketLifecycleStatus(args.after.status),
    updated_by: args.updatedBy,
  }

  const envelope = buildEnvelope({
    eventType: MARKET_UPDATED_EVENT,
    actor: eventActorFromUpdatedBy(args.updatedBy),
    market: args.after,
    idempotencyKey: `market:updated:${args.after.instance_id}:${args.after.id}:${buildHash(
      stableStringify(normalizedChanges)
    ).slice(0, 12)}`,
    payload,
  })

  assertEventEnvelopeMatchesContract(envelope, MARKET_UPDATED_EVENT)
  return envelope
}

export function assertEventEnvelopeMatchesContract<TPayload>(
  envelope: unknown,
  expectedEventType: string
): asserts envelope is GpEventEnvelope<TPayload> {
  const envelopeSchema = readSchema(ENVELOPE_SCHEMA_PATH)
  validateSchemaOrThrow(envelope, envelopeSchema, "$")

  if (!isObjectLike(envelope)) {
    throw new SchemaValidationError([{ path: "$", message: "must be an object" }])
  }

  if (envelope.event_type !== expectedEventType) {
    throw new SchemaValidationError([
      {
        path: "$.event_type",
        message: `must equal ${expectedEventType}`,
      },
    ])
  }

  const payloadSchema = readSchema(payloadSchemaPathFor(expectedEventType))
  validateSchemaOrThrow(envelope.payload, payloadSchema, "$.payload")
}