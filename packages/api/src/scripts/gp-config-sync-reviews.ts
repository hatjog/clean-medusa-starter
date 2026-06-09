import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { Knex } from "knex"

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import * as fsSync from "node:fs"
import path from "node:path"

import * as yaml from "js-yaml"

import { computeFieldDiffs, DryRunCollector } from "./gp-sync-dry-run"

type ReviewReference = {
  seller_id?: string
  product_id?: string
}

type ReviewFixture = {
  reference: ReviewReference
  rating: number
  customer_note?: string | null
  seller_note?: string | null
  locale: string
  published?: boolean
  "provenance-tag": string
}

type ReviewsCatalog = {
  vendor_id: string
  market_id: string
  version?: string
  reviews?: ReviewFixture[]
}

export type DesiredReview = {
  id: string
  vendorId: string
  index: number
  reference: "seller" | "product"
  targetId: string
  rating: number
  customer_note: string | null
  seller_note: string | null
  locale: string
  provenanceTag: string
  // L1 decision note:
  // `published` (z reviews-catalog.v1.schema.json) nie jest materializowane jako kolumna DB —
  // model `review` Mercur nie posiada kolumny `published`. Widoczność review downstream jest
  // kontrolowana przez story 2.4 (junction-based filter + `deleted_at`). Jeśli HG-6 wymaga
  // per-review `published` flag w DB, Story 2.4/2.5 powinny dodać kolumnę metadata.
  //
  // M3 fix (ADR-148): `locale` + `provenance` są materializowane przez projekcję
  // `review.metadata.gp.locale` / `review.metadata.gp.provenance` (jsonb seam Mercur),
  // NIE jako fizyczne kolumny (ADR-148 odrzuca migrację modelu Mercur). Storefront czyta
  // te pola (`buildReviewFromRaw` / `pickReviewMeta`), więc runtime przestaje być `null`
  // po sync. Wartość provenance = domknięty enum D-148/D-149 (== `provenance-tag` z kontraktu).
}

export type ExistingSeedReview = {
  id: string
  reference: "seller" | "product" | string | null
  rating: number | string | null
  customer_note: string | null
  seller_note: string | null
  // M3 fix (ADR-148): zmaterializowana projekcja metadata.gp.* odczytana z DB,
  // by re-run wykrył drift i zbackfillował istniejące rekordy (idempotentnie, ADR-144).
  locale: string | null
  provenance: string | null
  targetId: string | null
  deleted_at?: unknown
}

type ReviewPlanEntry = {
  id: string
  action: "create" | "update" | "skip" | "deactivate"
  reference: "seller" | "product"
  targetId?: string
  diffs?: ReturnType<typeof computeFieldDiffs>
  conflict?: string
}

export type ReviewSyncPlan = {
  desired: DesiredReview[]
  entries: ReviewPlanEntry[]
  conflicts: string[]
}

type SyncSummary = {
  ok: boolean
  instance_id: string
  market_id: string
  dry_run: boolean
  reviews: {
    created: number
    updated: number
    skipped: number
    deactivated: number
  }
  conflicts: string[]
  warnings: string[]
}

type ResolvedTarget =
  | { ok: true; targetId: string }
  | { ok: false; warning: string }

const SEEDED_REVIEW_ID_PREFIX = "gp_rev_"
const SEEDED_LINK_ID_PREFIX = "gp_rln_"

export function parseReviewSyncArgs(args: string[] | undefined): {
  instanceId: string
  marketId: string
  configRoot: string
  dryRun: boolean
} {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const marketId = (args?.[1] ?? process.env.GP_MARKET_ID ?? "bonbeauty").trim()
  const configRoot = (process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")).trim()

  // M1 fix: GP_DRY_RUN=true jest twardym override'em — jeśli orchestrator jest w trybie dry-run,
  // stage reviews musi być również dry-run bez względu na --apply/GP_SYNC_APPLY.
  const orchestratorDryRun = ["true", "1", "yes", "on"].includes(
    (process.env.GP_DRY_RUN ?? "").trim().toLowerCase()
  )
  const envApply = ["true", "1", "yes", "on"].includes(
    (process.env.GP_SYNC_APPLY ?? "").trim().toLowerCase()
  )
  const wantsApply = args?.includes("--apply") || envApply
  // Dry-run jeśli orchestrator wymaga dry-run (twardy override) LUB jeśli --apply nie zostało jawnie podane.
  const dryRun = orchestratorDryRun || !wantsApply

  if (!instanceId) throw new Error("instanceId is required (args[0] or GP_INSTANCE_ID)")
  if (!marketId) throw new Error("marketId is required (args[1] or GP_MARKET_ID)")
  if (!configRoot) throw new Error("configRoot is required (GP_CONFIG_ROOT)")

  return { instanceId, marketId, configRoot, dryRun }
}

function resolveProjectRoot(start: string): string {
  let current = path.resolve(start)

  while (true) {
    if (
      fsSync.existsSync(path.join(current, "_grow")) &&
      fsSync.existsSync(path.join(current, "specs"))
    ) {
      return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      return path.resolve(start)
    }
    current = parent
  }
}

async function readYamlFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf8")
  const doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA })
  if (!doc || typeof doc !== "object") {
    throw new Error(`Invalid YAML document: ${filePath}`)
  }
  return doc as T
}

export function buildStableReviewId(
  provenanceTag: string,
  vendorId: string,
  index: number
): string {
  const digest = createHash("sha256")
    .update(`${provenanceTag}\0${vendorId}\0${index}`)
    .digest("hex")
    .slice(0, 32)
  return `${SEEDED_REVIEW_ID_PREFIX}${digest}`
}

function buildStableLinkId(reviewId: string, targetId: string): string {
  const digest = createHash("sha256")
    .update(`${reviewId}\0${targetId}`)
    .digest("hex")
    .slice(0, 32)
  return `${SEEDED_LINK_ID_PREFIX}${digest}`
}

function normalizeTarget(review: ReviewFixture): { reference: "seller" | "product"; fixtureId: string } {
  const sellerId = review.reference?.seller_id?.trim()
  const productId = review.reference?.product_id?.trim()
  if (sellerId && productId) {
    throw new Error("review.reference must contain exactly one of seller_id or product_id")
  }
  if (sellerId) return { reference: "seller", fixtureId: sellerId }
  if (productId) return { reference: "product", fixtureId: productId }
  throw new Error("review.reference must contain seller_id or product_id")
}

async function listReviewCatalogPaths(
  configRoot: string,
  instanceId: string,
  marketId: string
): Promise<string[]> {
  const vendorsDir = path.resolve(configRoot, instanceId, "markets", marketId, "vendors")
  try {
    const entries = await fs.readdir(vendorsDir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(vendorsDir, entry.name, "reviews.yaml"))
      .filter((filePath) => fsSync.existsSync(filePath))
      .sort()
  } catch (error: any) {
    if (error?.code === "ENOENT") return []
    throw error
  }
}

function validateReviewsCatalogFile(projectRoot: string, filePath: string): void {
  const validatorPath = path.join(projectRoot, "_grow", "tools", "validate_reviews_catalog.py")
  execFileSync("python3", [validatorPath, "--root", projectRoot, filePath], {
    cwd: projectRoot,
    stdio: "pipe",
  })
}

async function resolveSellerTarget(db: Knex, sellerFixtureId: string, marketId: string): Promise<ResolvedTarget> {
  const row = await db("seller")
    .select("id")
    .where("handle", sellerFixtureId)
    .whereRaw("metadata->'gp'->>'market_id' = ?", [marketId])
    .whereNull("deleted_at")
    .first<{ id: string }>()

  if (!row?.id) {
    return {
      ok: false,
      warning: `seller review target '${sellerFixtureId}' not found in market '${marketId}'`,
    }
  }

  return { ok: true, targetId: row.id }
}

async function resolveProductTarget(db: Knex, productFixtureId: string, marketId: string): Promise<ResolvedTarget> {
  // L2 decision note:
  // Ten stage scope'uje product-reviews przez product.metadata->'gp'->>'market_id' + sc.metadata->>'gp_market_id'.
  // Istniejący helper listReviewIdsForSalesChannel (review-market-scope.ts) scope'uje przez
  // konkretny psc.sales_channel_id. To dwie różne semantyki — Story 2.4 musi ujednolicić tę definicję
  // przy implementacji render-side scope'u. Jedno źródło prawdy market↔sales-channel powinno
  // zostać ustalone w Story 2.4/2.5 (rekomendacja: opierać się na konkretnym sales_channel_id
  // marketu zamiast metadata string match).
  const row = await db("product as product")
    .select("product.id")
    .innerJoin("product_sales_channel as psc", "product.id", "psc.product_id")
    .innerJoin("sales_channel as sc", "psc.sales_channel_id", "sc.id")
    .whereRaw("product.metadata->'gp'->>'market_id' = ?", [marketId])
    .whereRaw("product.metadata->'gp'->>'fixture_id' = ?", [productFixtureId])
    .whereRaw("sc.metadata->>'gp_market_id' = ?", [marketId])
    .whereNull("product.deleted_at")
    .whereNull("psc.deleted_at")
    .whereNull("sc.deleted_at")
    .first<{ id: string }>()

  if (!row?.id) {
    return {
      ok: false,
      warning: `product review target '${productFixtureId}' not found in sales-channel scope for market '${marketId}'`,
    }
  }

  return { ok: true, targetId: row.id }
}

async function loadDesiredReviews(
  db: Knex,
  args: ReturnType<typeof parseReviewSyncArgs>,
  warnings: string[]
): Promise<DesiredReview[]> {
  const projectRoot = resolveProjectRoot(process.cwd())
  const catalogPaths = await listReviewCatalogPaths(args.configRoot, args.instanceId, args.marketId)
  const desired: DesiredReview[] = []

  for (const catalogPath of catalogPaths) {
    validateReviewsCatalogFile(projectRoot, catalogPath)
    const catalog = await readYamlFile<ReviewsCatalog>(catalogPath)
    if (catalog.market_id !== args.marketId) {
      throw new Error(
        `market_id mismatch in ${catalogPath}: expected '${args.marketId}', got '${catalog.market_id}'`
      )
    }

    for (const [index, review] of (catalog.reviews ?? []).entries()) {
      const normalizedTarget = normalizeTarget(review)
      const resolved =
        normalizedTarget.reference === "seller"
          ? await resolveSellerTarget(db, normalizedTarget.fixtureId, args.marketId)
          : await resolveProductTarget(db, normalizedTarget.fixtureId, args.marketId)

      if (!resolved.ok) {
        warnings.push(resolved.warning)
        continue
      }

      desired.push({
        id: buildStableReviewId(review["provenance-tag"], catalog.vendor_id, index),
        vendorId: catalog.vendor_id,
        index,
        reference: normalizedTarget.reference,
        targetId: resolved.targetId,
        rating: review.rating,
        customer_note: review.customer_note ?? null,
        seller_note: review.seller_note ?? null,
        locale: review.locale,
        provenanceTag: review["provenance-tag"],
      })
    }
  }

  return desired
}

async function loadExistingSeedReviews(db: Knex, marketId: string): Promise<ExistingSeedReview[]> {
  const rows = await db("review as review")
    .select(
      "review.id",
      "review.reference",
      "review.rating",
      "review.customer_note",
      "review.seller_note",
      "review.metadata",
      "review.deleted_at",
      "ssrr.seller_id",
      "pprr.product_id"
    )
    .leftJoin("seller_seller_review_review as ssrr", function () {
      this.on("review.id", "=", "ssrr.review_id").andOnNull("ssrr.deleted_at")
    })
    .leftJoin("seller as seller", "ssrr.seller_id", "seller.id")
    .leftJoin("product_product_review_review as pprr", function () {
      this.on("review.id", "=", "pprr.review_id").andOnNull("pprr.deleted_at")
    })
    .leftJoin("product as product", "pprr.product_id", "product.id")
    .leftJoin("product_sales_channel as psc", function () {
      this.on("product.id", "=", "psc.product_id").andOnNull("psc.deleted_at")
    })
    .leftJoin("sales_channel as sc", function () {
      this.on("psc.sales_channel_id", "=", "sc.id").andOnNull("sc.deleted_at")
    })
    .where("review.id", "like", `${SEEDED_REVIEW_ID_PREFIX}%`)
    .andWhere(function () {
      this.whereRaw("seller.metadata->'gp'->>'market_id' = ?", [marketId])
        .orWhereRaw("product.metadata->'gp'->>'market_id' = ?", [marketId])
        .orWhereRaw("sc.metadata->>'gp_market_id' = ?", [marketId])
    })

  const mapped: ExistingSeedReview[] = rows.map((row: any) => {
    // M3 fix (ADR-148): metadata jsonb może przyjść jako obiekt (pg jsonb) lub string.
    const metadata = parseReviewMetadata(row.metadata)
    const gp = (metadata?.gp ?? {}) as Record<string, unknown>
    return {
      id: row.id,
      reference: row.reference,
      rating: row.rating,
      customer_note: row.customer_note,
      seller_note: row.seller_note,
      locale: typeof gp.locale === "string" ? gp.locale : null,
      provenance: typeof gp.provenance === "string" ? gp.provenance : null,
      deleted_at: row.deleted_at,
      targetId: row.seller_id ?? row.product_id ?? null,
    }
  })

  // M2 fix: dedupe po review.id — LEFT JOIN product_sales_channel może zwrócić N duplikatów
  // dla product-review należącej do wielu sales-channeli (ten sam pattern co buildScopedReviewQuery
  // w packages/api/src/lib/review-market-scope.ts który używa .distinct("review.id")).
  // Używamy pierwszego wystąpienia (first-wins) zamiast last-wins z Map constructor.
  const deduped = new Map<string, ExistingSeedReview>()
  for (const row of mapped) {
    if (!deduped.has(row.id)) {
      deduped.set(row.id, row)
    }
  }
  return Array.from(deduped.values())
}

// M3 fix (ADR-148): bezpieczny parser metadata.gp.* (pg jsonb może wrócić jako obiekt lub string).
function parseReviewMetadata(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === "object") return value as Record<string, unknown>
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
  return null
}

type ReviewComparableInput = {
  reference: DesiredReview["reference"] | string | null
  rating: number | string | null
  customer_note: string | null
  seller_note: string | null
  // Desired niesie `locale` + `provenanceTag`; existing niesie `locale` + `provenance`.
  locale?: string | null
  provenance?: string | null
  provenanceTag?: string | null
}

function reviewComparable(review: ReviewComparableInput) {
  return {
    reference: review.reference,
    rating: Number(review.rating),
    customer_note: review.customer_note ?? null,
    seller_note: review.seller_note ?? null,
    // M3 fix (ADR-148): locale + provenance są częścią porównania, by re-run zbackfillował
    // istniejące rekordy seeda pozbawione metadata.gp.* (idempotentny upsert per ADR-144).
    locale: review.locale ?? null,
    provenance: review.provenance ?? review.provenanceTag ?? null,
  }
}

export function buildReviewSyncPlan(
  desired: DesiredReview[],
  existing: ExistingSeedReview[]
): ReviewSyncPlan {
  const existingById = new Map(existing.map((row) => [row.id, row]))
  const desiredIds = new Set(desired.map((row) => row.id))
  const entries: ReviewPlanEntry[] = []
  const conflicts: string[] = []

  for (const review of desired) {
    const current = existingById.get(review.id)
    if (!current) {
      entries.push({
        id: review.id,
        action: "create",
        reference: review.reference,
        targetId: review.targetId,
      })
      continue
    }

    // I1 fix: rozróżnienie reaktywacji linku (current.targetId===null = soft-deleted link)
    // od zmiany aktywnego targetu. Reaktywacja to nie konflikt — konflikt to zmiana target
    // aktywnego linku (current.targetId !== null && !== review.targetId).
    const linkWasSoftDeleted = current.targetId === null
    const targetChanged = current.targetId !== null && current.targetId !== review.targetId
    const diffs = computeFieldDiffs(reviewComparable(current), reviewComparable(review))
    if (targetChanged) {
      diffs.push({
        // L2 fix: `targetChanged` gwarantuje `current.targetId !== null`, ale TS nie zawęża
        // pola obiektu — jawny fallback `?? ""` (nieosiągalny) domyka typ `string` FieldDiff.
        field: "target_id",
        current: current.targetId ?? "",
        incoming: review.targetId,
      })
    }

    if (diffs.length === 0 && !current.deleted_at && !linkWasSoftDeleted) {
      entries.push({
        id: review.id,
        action: "skip",
        reference: review.reference,
        targetId: review.targetId,
      })
      continue
    }

    // Konflikt raportujemy tylko dla realnych rozbieżności (diffs zawiera pola), NIE dla reaktywacji linku.
    // M3 (ADR-148): locale/provenance to projekcja display-only z tego samego kontraktu — ich drift
    // (zwłaszcza backfill null→wartość na pierwszym przebiegu po deployu) NIE jest seed-konfliktem,
    // ale nadal wymusza akcję `update` (przez `diffs.length > 0` powyżej) by zmaterializować metadata.gp.*.
    const conflictDiffs = diffs.filter((d) => d.field !== "locale" && d.field !== "provenance")
    const conflict =
      conflictDiffs.length > 0
        ? `${review.id}: ${conflictDiffs.map((d) => d.field).join(", ")}`
        : undefined
    if (conflict) conflicts.push(conflict)
    entries.push({
      id: review.id,
      action: "update",
      reference: review.reference,
      targetId: review.targetId,
      diffs,
      ...(conflict ? { conflict } : {}),
    })
  }

  for (const row of existing) {
    if (desiredIds.has(row.id) || row.deleted_at) continue
    entries.push({
      id: row.id,
      action: "deactivate",
      reference: row.reference === "product" ? "product" : "seller",
      ...(row.targetId ? { targetId: row.targetId } : {}),
    })
  }

  return { desired, entries, conflicts }
}

async function upsertReviewRow(db: Knex, review: DesiredReview): Promise<void> {
  const now = new Date()
  // M3 fix (ADR-148): materializacja locale + provenance przez projekcję metadata.gp.*
  // (jsonb seam Mercur), NIE fizyczna kolumna. `provenance` = domknięty enum D-148/D-149
  // (== `provenance-tag` z kontraktu reviews 2.2). Storefront czyta metadata.gp.locale|provenance.
  const gpProjection = { locale: review.locale, provenance: review.provenanceTag }
  const payload = {
    id: review.id,
    reference: review.reference,
    rating: review.rating,
    customer_note: review.customer_note,
    seller_note: review.seller_note,
    metadata: { gp: gpProjection },
    created_at: now,
    updated_at: now,
    deleted_at: null,
  }

  // Deep-merge metadata.gp.* zachowując pozostałe klucze metadata (i metadata.gp) istniejącego
  // rekordu — idempotentny upsert (ADR-144). `review.metadata` to wartość PRZED update (PG upsert).
  const mergedMetadata = db.raw(
    "coalesce(\"review\".metadata, '{}'::jsonb) || jsonb_build_object('gp', coalesce(\"review\".metadata->'gp', '{}'::jsonb) || ?::jsonb)",
    [JSON.stringify(gpProjection)]
  )

  await db("review")
    .insert(payload)
    .onConflict("id")
    .merge({
      reference: payload.reference,
      rating: payload.rating,
      customer_note: payload.customer_note,
      seller_note: payload.seller_note,
      metadata: mergedMetadata,
      updated_at: payload.updated_at,
      deleted_at: null,
    })
}

async function upsertReviewLink(db: Knex, review: DesiredReview): Promise<void> {
  const table =
    review.reference === "seller"
      ? "seller_seller_review_review"
      : "product_product_review_review"
  const otherTable =
    review.reference === "seller"
      ? "product_product_review_review"
      : "seller_seller_review_review"
  const targetColumn = review.reference === "seller" ? "seller_id" : "product_id"
  const now = new Date()

  await db(otherTable)
    .where({ review_id: review.id })
    .whereNull("deleted_at")
    .update({ deleted_at: now, updated_at: now })

  await db(table)
    .where({ review_id: review.id })
    .whereNot({ [targetColumn]: review.targetId })
    .whereNull("deleted_at")
    .update({ deleted_at: now, updated_at: now })

  await db(table)
    .insert({
      id: buildStableLinkId(review.id, review.targetId),
      review_id: review.id,
      [targetColumn]: review.targetId,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    })
    .onConflict("id")
    .merge({
      review_id: review.id,
      [targetColumn]: review.targetId,
      updated_at: now,
      deleted_at: null,
    })
}

async function deactivateReview(db: Knex, reviewId: string): Promise<void> {
  const now = new Date()
  await db("seller_seller_review_review")
    .where({ review_id: reviewId })
    .whereNull("deleted_at")
    .update({ deleted_at: now, updated_at: now })
  await db("product_product_review_review")
    .where({ review_id: reviewId })
    .whereNull("deleted_at")
    .update({ deleted_at: now, updated_at: now })
  await db("review")
    .where({ id: reviewId })
    .whereNull("deleted_at")
    .update({ deleted_at: now, updated_at: now })
}

async function applyReviewPlan(db: Knex, plan: ReviewSyncPlan): Promise<void> {
  const desiredById = new Map(plan.desired.map((review) => [review.id, review]))

  for (const entry of plan.entries) {
    if (entry.action === "skip") continue
    if (entry.action === "deactivate") {
      await deactivateReview(db, entry.id)
      continue
    }

    const review = desiredById.get(entry.id)
    if (!review) {
      throw new Error(`Missing desired review for plan entry ${entry.id}`)
    }
    await upsertReviewRow(db, review)
    await upsertReviewLink(db, review)
  }
}

function planCounts(plan: ReviewSyncPlan): SyncSummary["reviews"] {
  return {
    created: plan.entries.filter((entry) => entry.action === "create").length,
    updated: plan.entries.filter((entry) => entry.action === "update").length,
    skipped: plan.entries.filter((entry) => entry.action === "skip").length,
    deactivated: plan.entries.filter((entry) => entry.action === "deactivate").length,
  }
}

export default async function gpConfigSyncReviews({ container, args }: ExecArgs): Promise<SyncSummary> {
  const parsed = parseReviewSyncArgs(args)
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knex
  const warnings: string[] = []
  const collector = parsed.dryRun ? new DryRunCollector() : undefined

  const desired = await loadDesiredReviews(db, parsed, warnings)
  const existing = await loadExistingSeedReviews(db, parsed.marketId)
  const plan = buildReviewSyncPlan(desired, existing)

  for (const entry of plan.entries) {
    collector?.add({
      entityType: "review",
      handle: entry.id,
      action: entry.action === "deactivate" ? "update" : entry.action,
      note:
        entry.action === "deactivate"
          ? "withdrawn -> soft-delete"
          : entry.conflict ?? `${entry.reference}:${entry.targetId ?? "unresolved"}`,
    })
  }

  if (parsed.dryRun) {
    console.log(collector?.renderTable() ?? "No planned operations.")
    // M1 fix: jawna notka operatorowi, gdy plan ma >0 operacji a tryb to dry-run
    const counts = planCounts(plan)
    const pendingOps = counts.created + counts.updated + counts.deactivated
    if (pendingOps > 0) {
      warnings.push(
        `reviews dry-run only (${pendingOps} pending operations) — pass --apply to materialize`
      )
    }
  } else {
    await applyReviewPlan(db, plan)
  }

  const summary: SyncSummary = {
    ok: true,
    instance_id: parsed.instanceId,
    market_id: parsed.marketId,
    dry_run: parsed.dryRun,
    reviews: planCounts(plan),
    conflicts: plan.conflicts,
    warnings,
  }

  console.log(JSON.stringify(summary, null, 2))
  return summary
}
