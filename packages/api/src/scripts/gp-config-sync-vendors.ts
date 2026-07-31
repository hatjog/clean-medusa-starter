/**
 * gp-config-sync-vendors.ts — vendor sync from gp-config to backend (v1.5.0).
 *
 * Story v160-1-7.1: gp-config vendor status now maps directly onto the
 * Mercur 2 seller lifecycle enum (`pending_approval`, `open`, `suspended`,
 * `terminated`). Legacy GP `active` / `inactive` / `archived` values are kept
 * only as input aliases for older market fixtures.
 */
import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

import fs from "node:fs/promises"
import path from "node:path"

import * as yaml from "js-yaml"

import {
  computeFieldDiffs,
  DryRunCollector,
  parseDryRunFlag,
  resolveForceVendorOverwrite,
  parseOverwriteFlag,
  parsePruneFlag,
} from "./gp-sync-dry-run"

// ---- Types ----

type VendorLocation = {
  city?: string
  address?: string
  postal_code?: string
  country_code?: string
  region?: string
  lat?: number
  lng?: number
}

type VendorOpeningHours = Record<string, { open: string; close: string } | null>

type VendorSeo = {
  meta_title?: string
  meta_description?: string
  [key: string]: unknown
}

type VendorGalleryImage = {
  url?: string
  alt?: string | null
  is_primary?: boolean
}

type VendorSocialLinks = {
  instagram?: string
  facebook?: string
  tiktok?: string
  [key: string]: unknown
}

type VendorFixture = {
  vendor_id: string
  slug: string
  status?: string
  display_name?: string
  email?: string
  phone?: string
  tax_id?: string
  description?: string
  photo_url?: string
  gallery_urls?: string[]
  gallery?: VendorGalleryImage[]
  social_links?: VendorSocialLinks
  seo?: VendorSeo
  locations?: VendorLocation[]
  opening_hours?: VendorOpeningHours
}

type MarketConfig = {
  market_id: string
  currency?: string
  vendors?: VendorFixture[]
}

export type SellerSyncResult = {
  sellerId: string | null
  action: "created" | "updated" | "skipped"
  note?: string
  /**
   * ADR-165 — pola `seed_if_empty`, których `--overwrite` NIE nadpisał, bo
   * należą do vendora (Case 2/4). Puste/nieobecne przy runie bez `--overwrite`.
   */
  ownershipProtectedFields?: string[]
  /**
   * ADR-165 §4 (cykl 5) — to samo z rozróżnieniem PRZYCZYNY. `gp catalog sync
   * --force` robi z tego preflight: operator ma zobaczyć nie „3 pola", tylko
   * „studio-nova/description, bo wartość na encji rozjechała się z zapisanym
   * seedem" — czyli że to vendor je edytował.
   */
  ownershipProtectedDetails?: OwnershipProtectedDetail[]
  /**
   * ADR-165 §4 (cykl 5) — pola vendor-owned, które kanał `--force` FAKTYCZNIE
   * nadpisał. Osobno od `ownershipProtectedFields`: tamto mówi „odmówiłem",
   * to mówi „zniszczyłem cudzą pracę". Bez tego rejestru raport po runie nie
   * odróżniał force-runu, który coś skasował, od force-runu, który trafił
   * w sam seed i był no-opem.
   */
  vendorOverwrittenFields?: string[]
}

type SplDetail = {
  vendor_id: string
  fixture_id: string
  status: "created" | "skipped" | "missing_product" | "pruned"
  product_db_id?: string
  reason?: string
}

/**
 * ADR-165 — powód, dla którego bramka własności odmówiła zapisu.
 *
 * Rozróżnienie nie jest kosmetyczne: `gp catalog sync --force` musi PRZED
 * wykonaniem powiedzieć operatorowi, że wartość na encji różni się od
 * zapisanego seeda (czyli vendor ją edytował), a nie tylko „pole chronione".
 */
export type OwnershipProtectedReason =
  /** Case 2 — pole zasiane przez nas, ale kolumna encji != rejestr `metadata.gp.*`. */
  | "vendor-edited-seeded-field"
  /** Case 4 — kolumna niepusta, pola nigdy nie zasialiśmy. Treść vendora od początku. */
  | "never-seeded-vendor-content"

export type OwnershipProtectedDetail = {
  field: string
  reason: OwnershipProtectedReason
}

/**
 * ADR-165 — pominięcie zabronione przez bramkę własności, per vendor.
 * Osobna klasa sygnału, nie „jeden z warningów": tylko ona eskaluje run
 * do porażki (review cykl 4, W2).
 */
export type OwnershipProtectedSkip = {
  vendor_id: string
  fields: string[]
  /**
   * Cykl 5 — per-pole przyczyna. Opcjonalne, żeby nie zerwać konsumentów
   * czytających samo `fields` (orchestrator, testy, zastane raporty na dysku).
   */
  details?: OwnershipProtectedDetail[]
}

/**
 * ADR-165 §4 (cykl 5) — treść vendora, którą kanał `--force` REALNIE nadpisał.
 *
 * Symetria wobec {@link OwnershipProtectedSkip} jest celowa: raport ma dwie
 * osobne, typowane klasy — „odmówiłem" i „zniszczyłem". Zlepienie ich w jeden
 * licznik warningów było dokładnie tym defektem, który W2 rozplątał w drugą
 * stronę.
 */
export type VendorContentOverwrite = {
  vendor_id: string
  fields: string[]
}

export type SyncSummary = {
  ok: boolean
  instance_id: string
  market_id: string
  vendors: { created: number; updated: number; skipped: number }
  spl: { created: number; skipped: number; missing_products: number; pruned: number }
  stale_sellers: { inactivated: number; skipped: number }
  spl_details: SplDetail[]
  warnings: string[]
  /**
   * Pominięcia bramki własności. Puste przy zdrowym runie — a run z zastanymi,
   * nieszkodliwymi warningami (vendor suspended, brak `sellerId`) ma tu pustkę
   * i NIE jest porażką.
   */
  ownership_protected: OwnershipProtectedSkip[]
  /**
   * F-1 (review 5.7) — nieudane zapisy `seller_address`. Osobny, TYPOWANY kanał,
   * bo skutkiem jest mail bez adresu salonu albo brak maila w ogóle: bramka
   * kontraktu szablonu wstrzymuje wysyłkę bez `salon_address`.
   */
  address_write_failures: Array<{ vendor_id: string; reason: string }>
  /**
   * F-5 (review 5.7) — sellerzy bez `locations[0].address` w configu. Sync jest
   * JEDYNYM miejscem, które widzi to przed zakupem; wcześniej brak adresu
   * ujawniał się dopiero jako `failed` w ledgerze po opłaceniu vouchera.
   */
  sellers_without_address: string[]
  /**
   * ADR-165 §4 (cykl 5) — co kanał `--force` faktycznie zniszczył. Puste przy
   * każdym runie bez tego kanału; niepuste = raport MUSI to pokazać operatorowi
   * po wykonaniu, bo tej pracy nie da się odzyskać z drzewa configu.
   */
  vendor_overwritten: VendorContentOverwrite[]
}

type DbLinkOutcome = "inserted" | "restored" | "exists"

type MarketProductFixture = {
  product_id?: string
  slug?: string
  handle?: string
}

type MarketProductsFile = {
  products?: MarketProductFixture[]
}

type VendorProductsFile = {
  products?: Array<{ product_id?: string }>
}

type MarketScopedSellerRow = {
  id: string
  handle: string | null
  status: string | null
}

// ---- Utilities ----

function formatDryRunNote(prefix: string, note?: string): string {
  return note ? `${prefix} (${note})` : prefix
}

function formatSeedDiffNote(
  currentValues: Record<string, unknown>,
  incomingValues: Record<string, unknown>
): string | undefined {
  const diffs = computeFieldDiffs(currentValues, incomingValues)
  if (diffs.length === 0) {
    return "seed_if_empty=no-op"
  }

  return diffs
    .map((diff) => `${diff.field}: ${diff.current} -> ${diff.incoming}`)
    .join("; ")
}

/**
 * ADR-165 — dopina do noty listę pól pominiętych przez bramkę własności.
 * Pominięcie MUSI być widoczne w raporcie; cisza była defektem 4-6-H1.
 */
function appendOwnershipProtectedNote(
  note: string | undefined,
  ownershipProtectedFields: string[]
): string | undefined {
  if (ownershipProtectedFields.length === 0) return note

  const suffix = `vendor-owned (pominięte mimo --overwrite, ADR-165): ${ownershipProtectedFields.join(",")}`
  return note ? `${note}; ${suffix}` : suffix
}

/**
 * ADR-165 §4 (cykl 5) — dopina do noty to, co kanał `--force` ZNISZCZYŁ.
 * Symetrycznie do {@link appendOwnershipProtectedNote}, bo w raporcie muszą
 * być widoczne oba zdarzenia, a nie tylko odmowa.
 */
function appendVendorOverwriteNote(
  note: string | undefined,
  vendorOverwrittenFields: string[]
): string | undefined {
  if (vendorOverwrittenFields.length === 0) return note

  const suffix = `treść vendora NADPISANA przez --force (ADR-165 §4): ${vendorOverwrittenFields.join(",")}`
  return note ? `${note}; ${suffix}` : suffix
}

function formatOwnershipProtectedWarning(vendorId: string, fields: string[]): string {
  return (
    `Vendor '${vendorId}': --overwrite NIE nadpisał pól vendor-owned [${fields.join(", ")}] ` +
    `(ADR-165: treść vendora wygrywa; gp-config wyłącznie seeduje). ` +
    `Świadome nadpisanie: gp catalog sync <instance> <market> --force.`
  )
}

function formatVendorOverwriteWarning(vendorId: string, fields: string[]): string {
  return (
    `Vendor '${vendorId}': --force NADPISAŁ pola vendor-owned [${fields.join(", ")}] ` +
    `wartościami z gp-config (ADR-165 §4). Ta treść była napisana przez vendora ` +
    `i NIE DA SIĘ jej odtworzyć z drzewa configu.`
  )
}

function parseArgs(args: string[] | undefined): {
  instanceId: string
  marketId: string
  configRoot: string
  dryRun: boolean
  overwrite: boolean
  forceVendorOverwrite: boolean
  /** Verify-B5 V1 — kanał ustawiony jednostronnie i zignorowany; MUSI być głośny. */
  forceVendorOverwriteIgnoredReason?: string
  prune: boolean
} {
  const instanceId = (args?.[0] ?? process.env.GP_INSTANCE_ID ?? "gp-dev").trim()
  const marketId = (args?.[1] ?? process.env.GP_MARKET_ID ?? "bonbeauty").trim()
  const configRoot = (process.env.GP_CONFIG_ROOT ?? path.resolve(process.cwd(), "../config")).trim()
  const dryRun = parseDryRunFlag(args)
  const overwrite = parseOverwriteFlag(args)
  const forceVendorOverwriteDecision = resolveForceVendorOverwrite(args)
  const prune = parsePruneFlag(args)

  if (!instanceId) throw new Error("instanceId is required (args[0] or GP_INSTANCE_ID)")
  if (!marketId) throw new Error("marketId is required (args[1] or GP_MARKET_ID)")
  if (!configRoot) throw new Error("configRoot is required (GP_CONFIG_ROOT)")

  return {
    instanceId,
    marketId,
    configRoot,
    dryRun,
    overwrite,
    forceVendorOverwrite: forceVendorOverwriteDecision.enabled,
    ...(forceVendorOverwriteDecision.ignoredReason
      ? { forceVendorOverwriteIgnoredReason: forceVendorOverwriteDecision.ignoredReason }
      : {}),
    prune,
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

function resolveService(container: any, keysToTry: string[]): any {
  const errors: string[] = []
  for (const key of keysToTry) {
    try {
      return container.resolve(key)
    } catch (e: any) {
      errors.push(`${key}: ${e?.message ?? String(e)}`)
    }
  }
  throw new Error(
    `Cannot resolve service. Tried keys: ${keysToTry.join(", ")}. Errors: ${errors.join(" | ")}`
  )
}

function pushUniqueWarning(warnings: string[], seenWarnings: Set<string>, warning: string): void {
  if (seenWarnings.has(warning)) {
    return
  }

  seenWarnings.add(warning)
  warnings.push(warning)
}

function normalizeVendorGallery(vendor: VendorFixture): string[] | undefined {
  const urls = Array.isArray(vendor.gallery_urls)
    ? vendor.gallery_urls
    : Array.isArray(vendor.gallery)
      ? vendor.gallery.map((image) => image?.url)
      : undefined

  if (!urls) return undefined

  const out: string[] = []
  const seen = new Set<string>()
  for (const url of urls) {
    const trimmed = (url ?? "").trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }

  return out
}

function readSellerMarketId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const marketId = (value as { metadata?: { gp?: { market_id?: unknown } } }).metadata?.gp?.market_id
  return typeof marketId === "string" && marketId.trim() ? marketId.trim() : null
}

function selectSellerMatch(matches: any[], marketId: string): { match?: any; reason?: string } {
  if (!Array.isArray(matches) || matches.length === 0) {
    return {}
  }

  const exactMatches = matches.filter((match) => readSellerMarketId(match) === marketId)
  if (exactMatches.length === 1) {
    return { match: exactMatches[0] }
  }

  if (exactMatches.length > 1) {
    return {
      reason: `multiple sellers found for market '${marketId}' and handle collision prevents safe update`,
    }
  }

  const untaggedMatches = matches.filter((match) => readSellerMarketId(match) === null)
  if (untaggedMatches.length === 1) {
    return { match: untaggedMatches[0] }
  }

  if (untaggedMatches.length > 1) {
    return {
      reason: "multiple untagged sellers found for the same handle; manual cleanup required",
    }
  }

  const knownMarkets = [...new Set(matches.map((match) => readSellerMarketId(match)).filter(Boolean))]
  return {
    reason:
      knownMarkets.length > 0
        ? `cross-market guard — entity belongs to '${knownMarkets.join(", ")}'`
        : "no eligible seller match found",
  }
}

function resolveProductListFn(productModuleService: any): (filters: any) => Promise<any[]> {
  return typeof productModuleService.listProducts === "function"
    ? (filters: any) => productModuleService.listProducts(filters)
    : (filters: any) => productModuleService.list(filters)
}

function buildSellerProductLinkId(sellerId: string, productId: string): string {
  const ts = Date.now().toString(36)
  const entropy = Math.random().toString(36).slice(2, 8)
  return `spl_${sellerId.slice(-8)}_${productId.slice(-8)}_${ts}_${entropy}`
}

/**
 * Zapisuje adres salonu z gp-config (`locations[0]`) do `seller_address`.
 *
 * Story 5.7 / korekta PO 2026-07-30: adresy ISTNIALY w gp-config, tabela
 * `seller_address` istniala w schemacie, a kanal miedzy nimi nie — zero z
 * dziewieciu sellerow mialo wiersz. Ujawnil to dopiero guard kontraktu
 * szablonu (`VOUCHER_DELIVERY_PAYLOAD_INCOMPLETE`), bo `salon_address` jest
 * trescia uzytkowa maila: bez niego klientka nie wie, gdzie zrealizowac voucher.
 *
 * Bierzemy WYLACZNIE pierwsza lokalizacje — model `seller_address` trzyma jeden
 * adres na sellera, wiec wybor kolejnej byloby zgadywaniem. Vendor bez lokalizacji
 * jest pomijany cicho: to legalny stan konfiguracji, nie blad syncu.
 */
/**
 * Wybór lokalizacji, z której bierzemy adres salonu.
 *
 * Wydzielone i eksportowane ŚWIADOMIE: to jest warunek, na którym opiera się
 * sygnał F-5 („ten seller nie dostanie maila"), a na obecnych danych nie da się
 * go wywołać ani jednym żywym przebiegiem — każdy vendor we wszystkich pięciu
 * rynkach ma dziś adres w configu. Bez wydzielenia gałąź byłaby nietestowalna,
 * czyli dokładnie „mechanizm, o którym nie wiadomo, czy odpala".
 *
 * `null` znaczy: brak nadającego się adresu. Pusty string i sam whitespace są
 * traktowane jak brak — w mailu wyglądałyby identycznie jak puste pole.
 */
export function selectPrimaryVendorLocation(
  vendor: Pick<VendorFixture, "locations">
): VendorLocation | null {
  const first = vendor.locations?.[0]
  if (!first) return null
  return first.address?.trim() ? first : null
}

export async function upsertSellerAddressViaDb(
  db: any,
  sellerId: string,
  sellerName: string,
  location: VendorLocation
): Promise<"created" | "updated" | "skipped"> {
  const address1 = location.address?.trim()
  if (!address1) return "skipped"

  const payload = {
    seller_id: sellerId,
    company: sellerName,
    address_1: address1,
    city: location.city?.trim() ?? null,
    postal_code: location.postal_code?.trim() ?? null,
    country_code: location.country_code?.trim()?.toLowerCase() ?? null,
    province: location.region?.trim() ?? null,
    updated_at: new Date(),
  }

  // F-2 (review 5.7): TA SAMA regula wyboru co po stronie ODCZYTU projekcji maila
  // (`ORDER BY created_at ASC, id ASC LIMIT 1`). Bez `orderBy` Postgres zwraca
  // dowolny wiersz, wiec dla sellera z wiecej niz jednym adresem sync
  // aktualizowalby inny wiersz, niz renderuje mail — i nic by tego nie zglosilo.
  // Tabela NIE ma unikalnosci po `seller_id`, wiec „jeden adres na sellera" jest
  // zalozeniem, nie inwariantem: regula musi byc jawna po obu stronach.
  const existing = await db("seller_address")
    .where({ seller_id: sellerId })
    .whereNull("deleted_at")
    .orderBy([
      { column: "created_at", order: "asc" },
      { column: "id", order: "asc" },
    ])
    .first()

  if (existing) {
    await db("seller_address").where({ id: existing.id }).update(payload)
    return "updated"
  }

  const ts = Date.now().toString(36)
  const entropy = Math.random().toString(36).slice(2, 8)
  await db("seller_address").insert({
    id: `saddr_${sellerId.slice(-8)}_${ts}_${entropy}`,
    ...payload,
    created_at: new Date(),
  })
  return "created"
}

async function upsertSellerProductLinkViaDb(
  db: any,
  sellerId: string,
  productId: string
): Promise<DbLinkOutcome> {
  const existing = await db("product_product_seller_seller")
    .where({ seller_id: sellerId, product_id: productId })
    .first()

  if (!existing) {
    await db("product_product_seller_seller").insert({
      id: buildSellerProductLinkId(sellerId, productId),
      seller_id: sellerId,
      product_id: productId,
    })
    return "inserted"
  }

  if (existing.deleted_at) {
    await db("product_product_seller_seller")
      .where({ id: existing.id })
      .update({ deleted_at: null })
    return "restored"
  }

  return "exists"
}

/**
 * Single-seller invariant helper: returns an existing ACTIVE product↔seller
 * link that belongs to a DIFFERENT seller than `sellerId`, or null. A product
 * must belong to exactly one seller — a second link makes the cart item's
 * seller ambiguous and breaks checkout (empty shipping-options + `/complete`
 * "items missing seller" AFTER the card is charged → orphaned charge).
 * Exported for unit coverage.
 */
export async function findConflictingSellerLink(
  db: any,
  productId: string,
  sellerId: string
): Promise<{ seller_id: string } | null> {
  const row = await db("product_product_seller_seller")
    .where({ product_id: productId })
    .whereNot({ seller_id: sellerId })
    .whereNull("deleted_at")
    .first()
  return row ?? null
}

/**
 * --prune helper: return the seller's ACTIVE product↔seller links whose product
 * is NOT in `keepProductIds` (i.e. dropped from the vendor's config) — the rows
 * a prune pass would soft-delete. FAIL-SAFE: when `keepProductIds` is empty
 * (config unreadable / no products resolved) it returns [] so a transient empty
 * config can never wipe a seller's entire catalog. Scoped to ONE seller; the
 * caller performs the soft-delete (kept side-effect-free for unit coverage).
 */
export async function pruneStaleSellerProductLinks(
  db: any,
  sellerId: string,
  keepProductIds: ReadonlySet<string> | string[]
): Promise<Array<{ id: string; product_id: string }>> {
  const keep = Array.isArray(keepProductIds) ? keepProductIds : [...keepProductIds]
  if (keep.length === 0) return []
  return db("product_product_seller_seller")
    .where({ seller_id: sellerId })
    .whereNull("deleted_at")
    .whereNotIn("product_id", keep)
    .select("id", "product_id")
}

async function createSellerRecord(sellerModuleService: any, payload: Record<string, unknown>): Promise<any> {
  if (typeof sellerModuleService.create === "function") {
    return sellerModuleService.create(payload)
  }
  if (typeof sellerModuleService.createSeller === "function") {
    return sellerModuleService.createSeller(payload)
  }
  if (typeof sellerModuleService.createSellers === "function") {
    const created = await sellerModuleService.createSellers([payload])
    return Array.isArray(created) ? created[0] : created
  }

  throw new Error("Seller service does not expose a supported create method")
}

export async function updateSellerRecord(
  sellerModuleService: any,
  id: string,
  payload: Record<string, unknown>
): Promise<any> {
  if (typeof sellerModuleService.update === "function") {
    return sellerModuleService.update(id, payload)
  }
  if (typeof sellerModuleService.updateSeller === "function") {
    return sellerModuleService.updateSeller(id, payload)
  }
  if (typeof sellerModuleService.updateSellers === "function") {
    const updated = await sellerModuleService.updateSellers([{ id, ...payload }])
    return Array.isArray(updated) ? updated[0] : updated
  }

  throw new Error("Seller service does not expose a supported update method")
}

async function resolveSalesChannelId(db: any, marketId: string): Promise<string | null> {
  const row = await db("sales_channel")
    .select("id")
    .whereRaw("metadata->>'gp_market_id' = ?", [marketId])
    .whereNull("deleted_at")
    .first() as { id: string } | undefined

  return row?.id ?? null
}

export async function inactivateStaleMarketSellers(
  sellerModuleService: any,
  db: any,
  salesChannelId: string,
  configuredVendorHandles: Set<string>,
  dryRun: boolean,
  collector?: DryRunCollector
): Promise<{ inactivated: number; skipped: number }> {
  const scopedSellers = await db("seller as seller")
    .distinct("seller.id", "seller.handle", "seller.status")
    .innerJoin("product_product_seller_seller as ppss", "seller.id", "ppss.seller_id")
    .innerJoin("product as product", "ppss.product_id", "product.id")
    .innerJoin("product_sales_channel as psc", "product.id", "psc.product_id")
    .where("psc.sales_channel_id", salesChannelId)
    .whereNull("seller.deleted_at")
    .whereNull("ppss.deleted_at")
    .whereNull("product.deleted_at")
    .whereNull("psc.deleted_at")

  let inactivated = 0
  let skipped = 0

  for (const seller of scopedSellers as MarketScopedSellerRow[]) {
    const handle = seller.handle?.trim() ?? ""

    if (!handle || configuredVendorHandles.has(handle)) {
      continue
    }

    if (seller.status && seller.status !== "open") {
      skipped++
      continue
    }

    if (dryRun) {
      collector?.add({
        entityType: "seller",
        handle,
        action: "update",
        note: "status=suspended (missing from market config)",
      })
    } else {
      await updateSellerRecord(sellerModuleService, seller.id, { status: "suspended" })
    }

    console.log(`Seller '${handle}': set to suspended (missing from market config)`)
    inactivated++
  }

  return { inactivated, skipped }
}

export async function resolveProductByFixture(
  listProducts: (filters: any) => Promise<any[]>,
  fixtureId: string,
  fallbackHandle?: string
): Promise<{ product: any | null; strategy: "fixture" | "handle" | "none"; error?: string }> {
  try {
    const byFixture = (await listProducts({ metadata: { gp: { fixture_id: fixtureId } } })) ?? []
    if (byFixture[0]?.id) {
      return { product: byFixture[0], strategy: "fixture" }
    }
  } catch (e: any) {
    const message = e?.message ?? String(e)
    // Continue to fallback lookup when available.
    if (!fallbackHandle) {
      return { product: null, strategy: "none", error: `fixture lookup failed: ${message}` }
    }
  }

  if (!fallbackHandle) {
    return { product: null, strategy: "none" }
  }

  try {
    const byHandle = (await listProducts({ handle: fallbackHandle })) ?? []
    if (byHandle[0]?.id) {
      return { product: byHandle[0], strategy: "handle" }
    }
    return { product: null, strategy: "none", error: `handle lookup returned 0 rows for '${fallbackHandle}'` }
  } catch (e: any) {
    return {
      product: null,
      strategy: "none",
      error: `handle lookup failed for '${fallbackHandle}': ${e?.message ?? String(e)}`,
    }
  }
}

function vendorStatusToSellerStatus(status: string | undefined): string {
  switch (status) {
    case "pending_approval":
    case "pending":
      return "pending_approval"
    case "open":
    case "onboarded":
    case "active":
      return "open"
    case "suspended":
    case "paused":
    case "inactive":
      return "suspended"
    case "terminated":
    case "archived":
    case "disabled":
      return "terminated"
    default:
      return "open"
  }
}

function normalizeCurrencyCode(currency: string | undefined): string {
  const normalized = currency?.trim().toLowerCase()
  return normalized || "pln"
}

// ---- FR-56 seeded_fields logic ----

type SeedOwnershipResult = {
  value: unknown
  shouldWrite: boolean
  isNewSeed: boolean
  /**
   * true ⟺ zapis był ŻĄDANY (`--overwrite`), ale bramka własności ADR-165 go
   * zablokowała. Sygnał do jawnego zaraportowania — pominięcie NIE może być ciche.
   */
  ownershipProtected: boolean
  /**
   * Przyczyna, dla której pole należy do vendora — ustawiona ZAWSZE gdy bramka
   * uznała pole za vendor-owne, niezależnie od tego, czy je ochroniła
   * (`ownershipProtected`), czy przełamała (`vendorOverwritten`). Zasila
   * preflight `--force`.
   */
  ownershipReason?: OwnershipProtectedReason
  /**
   * true ⟺ pole było vendor-owne (Case 2/4), a kanał `--force` mimo to je
   * nadpisał. To jest ta jedna operacja w całym syncu, która NISZCZY cudzą
   * pracę bez możliwości odtworzenia jej z configu.
   */
  vendorOverwritten: boolean
}

/** Deep equality for primitives and JSON-serialisable values (including arrays). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a === "object" && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b)
  }
  return false
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true
  if (Array.isArray(value)) return value.length === 0
  return false
}

/**
 * Rozstrzyga własność pojedynczego pola `seed_if_empty` zgodnie z ADR-165
 * („treść vendor-owned wygrywa"; gp-config WYŁĄCZNIE seeduje).
 *
 * ## Model po doprecyzowaniu PO (Robert, 2026-07-28) — cykl 4
 *
 * Doprecyzowanie brzmiało: *„musi być możliwość wprowadzenia zmian przy pomocy
 * gp-cli, ale potem powinna być możliwość aktualizacji tych danych przy pomocy
 * admin, storefront powinien czytać dane z bazy"*. Wynikają z niego trzy role,
 * które ta funkcja rozdziela:
 *
 *   - `canonicalValue` — **wartość**. Kolumna encji (`seller.description`,
 *     `seller.name`, `seller.logo`). To ją czyta API i storefront, to ją edytuje
 *     admin/panel vendora, i to do niej pisze seed.
 *   - `seededValue` — **rejestr pochodzenia**. `metadata.gp.<pole>`: zapis „to
 *     pole zasialiśmy my, i wpisaliśmy wtedy TAKĄ wartość". Nigdy nie jest
 *     kandydatem na wartość — służy wyłącznie do rozstrzygnięcia własności.
 *   - `seededFields` — lista pól, które kiedykolwiek zasialiśmy.
 *
 * Do cyklu 3 obie role mieszkały w jednym miejscu: wołający podawał
 * `dbValue = metadata.gp.<pole> ?? kolumna`, czyli **lustro zamiast prawdy**.
 * Skutkowało to dwiema klasami defektów naraz:
 *   - W0 — seed nigdy nie trafiał do kolumny, więc `GET /store/seller/:handle`
 *     zwracał `description: null` przy 402 znakach w lustrze;
 *   - W1 — logo wgrane przez vendora do kolumny było kasowane bez
 *     `--force-vendor-overwrite`, bo porównanie `lustro == config` wychodziło
 *     prawdziwe i bramka własności w ogóle się nie odzywała.
 *
 * ## Cztery przypadki (po rozdzieleniu ról)
 *
 *   - Case 3  — kolumna PUSTA                       → seed (podstawowa funkcja
 *               `seed_if_empty`, działa z flagą i bez niej). Obejmuje też
 *               backfill kolumny, gdy rejestr ma wartość, a kolumna nie.
 *   - Case 2  — seeded ∧ kolumna != rejestr         → vendor edytował → NIE piszemy
 *   - Case 4  — nie-seeded ∧ kolumna niepusta       → vendor-owny od początku → NIE piszemy
 *   - Case 1  — seeded ∧ kolumna == rejestr         → własność nadal po stronie
 *               seeda; ODŚWIEŻENIE wymaga jawnej intencji (`--overwrite`).
 *
 * `overwrite` (`--overwrite` / `GP_OVERWRITE`) dotyczy WYŁĄCZNIE Case 1 i 3.
 * Nie przełamuje Case 2 ani 4 — jedynym kanałem, który je przełamuje, jest
 * `forceVendorOverwrite`.
 *
 * Kolejność sprawdzeń ma znaczenie: pusta kolumna jest rozstrzygana PRZED
 * predykatem `vendorOwned`. Inaczej stan „zasialiśmy do lustra, kolumna NULL"
 * (realny stan 4 sellerów bazy dev sprzed tego fixu) wyglądałby jak Case 2
 * i sam siebie zablokował — a przecież pusta kolumna nie zawiera niczyjej treści.
 */
function resolveSeedOwnership(
  fieldName: string,
  configValue: unknown,
  canonicalValue: unknown,
  seededValue: unknown,
  seededFields: string[],
  overwrite = false,
  forceVendorOverwrite = false
): SeedOwnershipResult {
  const isSeeded = seededFields.includes(fieldName)

  // Case 3 (+ backfill) — w kolumnie nie ma niczyjej treści, więc nie ma czego
  // chronić. Seedujemy bez flagi; to jest sens `seed_if_empty`.
  if (isEmptyValue(canonicalValue)) {
    return {
      value: configValue,
      shouldWrite: true,
      isNewSeed: !isSeeded,
      ownershipProtected: false,
      vendorOverwritten: false,
    }
  }

  // Case 2 (seeded, kolumna rozjechana z rejestrem) i Case 4 (nigdy nie
  // seedowane, kolumna niepusta) to semantycznie to samo: „pole należy do vendora".
  const vendorOwned = isSeeded ? !deepEqual(canonicalValue, seededValue) : true
  const ownershipReason: OwnershipProtectedReason = isSeeded
    ? "vendor-edited-seeded-field"
    : "never-seeded-vendor-content"

  if (vendorOwned && !forceVendorOverwrite) {
    return {
      value: canonicalValue,
      shouldWrite: false,
      isNewSeed: false,
      // raportujemy tylko gdy ktoś FAKTYCZNIE prosił o nadpisanie — zwykły run
      // bez flagi to normalna praca seeda, nie pominięcie do zgłoszenia
      ownershipProtected: overwrite,
      ownershipReason,
      vendorOverwritten: false,
    }
  }

  if (vendorOwned) {
    // Cykl 5 — jedyna gałąź, w której gp-config kasuje treść, której nie zasiał.
    // Musi być odróżnialna w raporcie od zwykłego odświeżenia seeda (Case 1).
    return {
      value: configValue,
      shouldWrite: true,
      isNewSeed: !isSeeded,
      ownershipProtected: false,
      ownershipReason,
      vendorOverwritten: true,
    }
  }

  // Case 1 — pole już zasiane i nietknięte przez vendora. Odświeżenie seeda
  // wymaga jawnej intencji (`--overwrite` albo silniejszy kanał force).
  if (!overwrite && !forceVendorOverwrite) {
    return {
      value: canonicalValue,
      shouldWrite: false,
      isNewSeed: false,
      // nikt nie prosił o nadpisanie — to nie jest pominięcie do zgłoszenia
      ownershipProtected: false,
      vendorOverwritten: false,
    }
  }

  return {
    value: configValue,
    shouldWrite: true,
    isNewSeed: !isSeeded,
    ownershipProtected: false,
    vendorOverwritten: false,
  }
}

// ---- Core upsert logic ----

export async function upsertSeller(
  sellerModuleService: any,
  vendor: VendorFixture,
  dryRun: boolean,
  marketId: string,
  currencyCode = "pln",
  overwrite = false,
  forceVendorOverwrite = false
): Promise<SellerSyncResult> {
  const handle = vendor.slug.trim()
  const vendorGallery = normalizeVendorGallery(vendor)

  // Look up existing seller by handle
  let existingSellers: any[] = []
  if (typeof sellerModuleService.list === "function") {
    existingSellers = (await sellerModuleService.list({ handle })) ?? []
  } else if (typeof sellerModuleService.listSellers === "function") {
    existingSellers = (await sellerModuleService.listSellers({ handle })) ?? []
  }

  const { match: existingSeller, reason: matchReason } = selectSellerMatch(existingSellers, marketId)
  const sellerStatus = vendorStatusToSellerStatus(vendor.status)

  if (matchReason) {
    return { sellerId: null, action: "skipped", note: matchReason }
  }

  if (!existingSeller) {
    // ---- CREATE: fresh vendor ----
    const seededFields: string[] = []
    const gpMetaSeeded: Record<string, unknown> = {}

    // Rejestr pochodzenia (ADR-165 cykl 4): `metadata.gp.<pole>` zapisuje, CO
    // zasialiśmy — nie jest wartością odczytywaną przez API. Wartość idzie do
    // kolumny encji w `createPayload` poniżej.
    if (vendor.display_name !== undefined && vendor.display_name !== null) {
      gpMetaSeeded.name = vendor.display_name
      seededFields.push("name")
    }
    if (vendor.description !== undefined && vendor.description !== null) {
      gpMetaSeeded.description = vendor.description
      seededFields.push("description")
    }
    if (vendor.photo_url !== undefined && vendor.photo_url !== null) {
      gpMetaSeeded.photo_url = vendor.photo_url
      seededFields.push("photo_url")
    }
    if (vendorGallery !== undefined) {
      gpMetaSeeded.gallery = vendorGallery
      seededFields.push("gallery")
    }

    const gpMeta: Record<string, unknown> = {
      market_id: marketId,
      seeded_fields: seededFields,
      ...(vendor.social_links ? { social_links: vendor.social_links } : {}),
      ...(vendor.seo ? { seo: vendor.seo } : {}),
      ...(vendor.locations ? { locations: vendor.locations } : {}),
      ...(vendor.opening_hours ? { opening_hours: vendor.opening_hours } : {}),
      ...gpMetaSeeded,
    }

    // W0 (review cykl 4): `description` NIE BYŁO tu wymienione, więc opis
    // seedowany przez tę story lądował wyłącznie w `metadata.gp.description`.
    // `GET /store/seller/:handle` czyta kolumnę — zwracał `null` przy 402
    // znakach w lustrze, czyli treść była niewidoczna na storefroncie.
    // Kolumna jest wartością kanoniczną; seed pisze DO NIEJ.
    const createPayload: Record<string, unknown> = {
      handle,
      name: vendor.display_name ?? handle,
      ...(vendor.description !== undefined && vendor.description !== null
        ? { description: vendor.description }
        : {}),
      ...(vendor.photo_url ? { logo: vendor.photo_url } : {}),
      email: vendor.email,
      phone: vendor.phone,
      tax_id: vendor.tax_id,
      currency_code: currencyCode,
      status: sellerStatus,
      metadata: { gp: gpMeta },
    }

    if (dryRun) {
      const note = seededFields.length > 0 ? `seed_if_empty=${seededFields.join(",")}` : undefined
      console.log(formatDryRunNote(`[dry-run] Would CREATE seller handle='${handle}'`, note))
      return { sellerId: `dry-run-${handle}`, action: "created", note }
    }

    const created = await createSellerRecord(sellerModuleService, createPayload)
    return { sellerId: created?.id ?? null, action: "created" }
  }

  // ---- UPDATE: existing seller ----
  const existingMetadata = (existingSeller.metadata ?? {}) as Record<string, unknown>
  const existingGp = (existingMetadata.gp ?? {}) as Record<string, unknown>
  const seededFields = Array.isArray(existingGp.seeded_fields)
    ? (existingGp.seeded_fields as string[])
    : []

  // Kolumny encji zapisywane tym runem. Dwa rozłączne źródła wpisów:
  //   - config_wins (handle/currency/status/email/phone/tax_id) — zawsze,
  //   - seed_if_empty (name/description/logo) — tylko gdy bramka własności
  //     ADR-165 na to pozwoli (`applySeedField` poniżej).
  // Tylko definiowane wartości, żeby nie kasować istniejących danych.
  const updatePayloadColumns: Record<string, unknown> = {
    handle,
    currency_code: currencyCode,
    status: sellerStatus,
  }
  if (vendor.email !== undefined) updatePayloadColumns.email = vendor.email
  if (vendor.phone !== undefined) updatePayloadColumns.phone = vendor.phone
  if (vendor.tax_id !== undefined) updatePayloadColumns.tax_id = vendor.tax_id

  // seed_if_empty fields — check ownership before writing
  const gpMetaUpdate: Record<string, unknown> = {
    market_id: marketId,
    // config_wins metadata fields
    ...(vendor.social_links !== undefined ? { social_links: vendor.social_links } : {}),
    ...(vendor.seo !== undefined ? { seo: vendor.seo } : {}),
    ...(vendor.locations !== undefined ? { locations: vendor.locations } : {}),
  }

  const newlySeededFields: string[] = []
  // ADR-165 — pola, których `--overwrite` nie ruszył, bo należą do vendora.
  const ownershipProtectedFields: string[] = []
  const ownershipProtectedDetails: OwnershipProtectedDetail[] = []
  // ADR-165 §4 (cykl 5) — pola vendor-owned, które `--force` REALNIE nadpisał.
  const vendorOverwrittenFields: string[] = []

  /**
   * @param canonicalValue wartość kanoniczna — kolumna encji (to ją czyta API)
   * @param seededValue    rejestr pochodzenia — `metadata.gp.<pole>`
   * @param onWrite        MUSI zapisać wartość do kolumny ORAZ odświeżyć rejestr
   */
  const applySeedField = (
    fieldName: string,
    configValue: unknown,
    canonicalValue: unknown,
    seededValue: unknown,
    onWrite: (value: unknown) => void
  ): void => {
    const r = resolveSeedOwnership(
      fieldName,
      configValue,
      canonicalValue,
      seededValue,
      seededFields,
      overwrite,
      forceVendorOverwrite
    )
    if (r.ownershipProtected) {
      ownershipProtectedFields.push(fieldName)
      if (r.ownershipReason) {
        ownershipProtectedDetails.push({ field: fieldName, reason: r.ownershipReason })
      }
    }
    if (r.vendorOverwritten) vendorOverwrittenFields.push(fieldName)
    if (r.shouldWrite) {
      onWrite(r.value)
      if (r.isNewSeed) newlySeededFields.push(fieldName)
    }
  }

  // name — kolumna `seller.name`, rejestr `metadata.gp.name`
  if (vendor.display_name !== undefined) {
    applySeedField(
      "name",
      vendor.display_name,
      existingSeller.name,
      existingGp.name,
      (value) => {
        updatePayloadColumns.name = value
        gpMetaUpdate.name = value
      }
    )
  }

  // description — kolumna `seller.description`, rejestr `metadata.gp.description`
  if (vendor.description !== undefined) {
    applySeedField(
      "description",
      vendor.description,
      existingSeller.description,
      existingGp.description,
      (value) => {
        updatePayloadColumns.description = value
        gpMetaUpdate.description = value
      }
    )
  }

  // photo_url — kolumna `seller.logo`, rejestr `metadata.gp.photo_url`
  if (vendor.photo_url !== undefined) {
    applySeedField(
      "photo_url",
      vendor.photo_url,
      existingSeller.logo,
      existingGp.photo_url,
      (value) => {
        updatePayloadColumns.logo = value
        gpMetaUpdate.photo_url = value
      }
    )
  }

  // gallery — jedyne pole seedowane BEZ własnej kolumny encji. Wartość
  // i rejestr dzielą tu `metadata.gp.gallery`, więc Case 2 jest z definicji
  // nieosiągalny: vendor nie ma kanału, którym by tę wartość edytował.
  // Ograniczenie nazwane w ADR-165 §Deferrals, nie przemilczane.
  if (vendorGallery !== undefined) {
    applySeedField(
      "gallery",
      vendorGallery,
      existingGp.gallery,
      existingGp.gallery,
      (value) => {
        gpMetaUpdate.gallery = value
      }
    )
  }

  if (vendor.locations !== undefined) {
    gpMetaUpdate.locations = vendor.locations
  }

  if (vendor.opening_hours !== undefined) {
    gpMetaUpdate.opening_hours = vendor.opening_hours
  }

  const updatedSeededFields = [...seededFields, ...newlySeededFields]
  gpMetaUpdate.seeded_fields = updatedSeededFields

  const updatePayload: Record<string, unknown> = {
    ...updatePayloadColumns,
    metadata: {
      ...existingMetadata,
      gp: {
        ...existingGp,
        ...gpMetaUpdate,
      },
    },
  }

  if (dryRun) {
    const currentSeedValues: Record<string, unknown> = {}
    const incomingSeedValues: Record<string, unknown> = {}

    // Plan pokazuje stan KANONICZNY (kolumny encji) — dokładnie to, co zobaczy
    // storefront. Do cyklu 3 pokazywał `metadata.gp.<pole> ?? kolumna`, więc
    // opisywał lustro, a nie bazę, na której operator planował decyzję.
    if (vendor.display_name !== undefined) {
      currentSeedValues.name = existingSeller.name
      incomingSeedValues.name = vendor.display_name
    }
    if (vendor.description !== undefined) {
      currentSeedValues.description = existingSeller.description
      incomingSeedValues.description = vendor.description
    }
    if (vendor.photo_url !== undefined) {
      currentSeedValues.photo_url = existingSeller.logo
      incomingSeedValues.photo_url = vendor.photo_url
    }
    if (vendorGallery !== undefined) {
      currentSeedValues.gallery = existingGp.gallery
      incomingSeedValues.gallery = vendorGallery
    }

    const note = appendVendorOverwriteNote(
      appendOwnershipProtectedNote(
        formatSeedDiffNote(currentSeedValues, incomingSeedValues),
        ownershipProtectedFields
      ),
      vendorOverwrittenFields
    )
    console.log(
      formatDryRunNote(
        `[dry-run] Would UPDATE seller handle='${handle}' id='${existingSeller.id}'`,
        note
      )
    )
    return {
      sellerId: existingSeller.id,
      action: "updated",
      note,
      ownershipProtectedFields,
      ownershipProtectedDetails,
      vendorOverwrittenFields,
    }
  }

  await updateSellerRecord(sellerModuleService, existingSeller.id, updatePayload)
  const note = appendVendorOverwriteNote(
    appendOwnershipProtectedNote(undefined, ownershipProtectedFields),
    vendorOverwrittenFields
  )
  return {
    sellerId: existingSeller.id,
    action: "updated",
    ...(note ? { note } : {}),
    ownershipProtectedFields,
    ownershipProtectedDetails,
    vendorOverwrittenFields,
  }
}

// ---- Default export: Medusa script entrypoint ----

export default async function gpConfigSyncVendors({ container, args }: ExecArgs) {
  const {
    instanceId,
    marketId,
    configRoot,
    dryRun,
    overwrite,
    forceVendorOverwrite,
    forceVendorOverwriteIgnoredReason,
    prune,
  } = parseArgs(args)
  const collector = dryRun ? new DryRunCollector() : undefined

  if (forceVendorOverwriteIgnoredReason) {
    // Verify-B5 V1 — kanał był ustawiony jednostronnie. Nic nie zniszczyliśmy,
    // ale operator MUSI się dowiedzieć, że jego (lub odziedziczone) ustawienie
    // nie zadziałało. Cichy no-op zostawiałby przekonanie, że force zadziałał.
    console.warn(`[GP_FORCE_VENDOR_OVERWRITE] ${forceVendorOverwriteIgnoredReason}`)
  }

  if (forceVendorOverwrite) {
    // ADR-165 — jedyny kanał, który NADPISUJE treść napisaną przez vendora.
    // Musi krzyczeć: to nieodwracalna utrata cudzej pracy, nie rutynowy seed.
    console.warn(
      "[GP_FORCE_VENDOR_OVERWRITE] UWAGA: pola seed_if_empty należące do vendora " +
        "(seeded+zmienione lub nigdy nie seedowane) ZOSTANĄ nadpisane wartościami z gp-config. " +
        "To świadome zniszczenie treści vendora — ADR-165 §4 dopuszcza to wyłącznie tym kanałem " +
        "(interfejs operatorski: `gp catalog sync <instance> <market> --force`)."
    )
  }

  const marketYamlPath = path.resolve(
    configRoot,
    instanceId,
    "markets",
    marketId,
    "market.yaml"
  )

  const marketConfig = await readYamlFile<MarketConfig>(marketYamlPath)
  if (marketConfig.market_id !== marketId) {
    throw new Error(
      `market_id mismatch in ${marketYamlPath}: expected '${marketId}', got '${marketConfig.market_id}'`
    )
  }
  const currencyCode = normalizeCurrencyCode(marketConfig.currency)

  const marketProductsPath = path.resolve(
    configRoot,
    instanceId,
    "markets",
    marketId,
    "products.yaml"
  )

  const fixtureToHandle = new Map<string, string>()
  try {
    const marketProducts = await readYamlFile<MarketProductsFile>(marketProductsPath)
    for (const p of marketProducts.products ?? []) {
      const fixtureId = (p.product_id ?? "").trim()
      const candidate = (p.slug ?? p.handle ?? "").trim()
      if (fixtureId && candidate) {
        fixtureToHandle.set(fixtureId, candidate)
      }
    }
  } catch {
    // Optional optimization-only mapping. Keep flow running without this file.
  }

  const sellerModuleService = resolveService(container, [
    "seller",
    "sellerModuleService",
    "seller_module",
    "ISellerModuleService",
  ])

  const productModuleService = resolveService(container, [
    "product",
    "productModuleService",
    "product_module",
  ])
  const productListFn = resolveProductListFn(productModuleService)
  const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)

  let splService: any = null
  let splServiceResolveError: string | null = null
  if (!dryRun) {
    try {
      splService = resolveService(container, [
        "sellerProductLink",
        "seller_product", // noqa: mercur15-drift — legacy DI token alias, not a DB table
        "seller_product_link",
        "ISellerProductLinkService",
      ])
    } catch (e: any) {
      splServiceResolveError = e?.message ?? String(e)
    }
  }

  const warnings: string[] = []
  const seenWarnings = new Set<string>()

  if (forceVendorOverwriteIgnoredReason) {
    // stderr znika w logach orchestratora — sygnał musi być też w raporcie.
    pushUniqueWarning(warnings, seenWarnings, forceVendorOverwriteIgnoredReason)
  }

  /** ADR-165 / W2 — jedyna klasa warningu, która eskaluje run do porażki. */
  const ownershipProtected: OwnershipProtectedSkip[] = []
  /** F-1 (review 5.7) — nieudane zapisy `seller_address`; puste = zdrowy run. */
  const addressWriteFailures: Array<{ vendor_id: string; reason: string }> = []
  /** F-5 (review 5.7) — sellerzy bez adresu w configu: ich mail NIE wyjdzie. */
  const sellersWithoutAddress: string[] = []
  /** ADR-165 §4 / cykl 5 — co `--force` faktycznie zniszczył. */
  const vendorOverwritten: VendorContentOverwrite[] = []

  const vendorCounts = { created: 0, updated: 0, skipped: 0 }
  const splCounts = { created: 0, skipped: 0, missing_products: 0, pruned: 0 }
  const staleSellerCounts = { inactivated: 0, skipped: 0 }
  const splDetails: SplDetail[] = []

  const vendors = marketConfig.vendors ?? []
  if (vendors.length === 0) {
    pushUniqueWarning(warnings, seenWarnings, `No vendors found in market config for market_id='${marketId}'`)
  }

  for (const vendor of vendors) {
    if (!vendor.slug) {
      pushUniqueWarning(warnings, seenWarnings, `Vendor '${vendor.vendor_id}': missing slug; skipping`)
      collector?.add({
        entityType: "seller",
        handle: vendor.vendor_id,
        action: "skip",
        note: "missing slug",
      })
      vendorCounts.skipped++
      continue
    }

    try {
      const result = await upsertSeller(
        sellerModuleService,
        vendor,
        dryRun,
        marketId,
        currencyCode,
        overwrite,
        forceVendorOverwrite
      )

      // Story 5.7 — adres salonu z gp-config do `seller_address`. Po upsercie
      // sellera, bo potrzebujemy jego id; przed linkami produktowymi, bo mail
      // potwierdzenia zależy od adresu, a nie od katalogu.
      const primaryLocation = selectPrimaryVendorLocation(vendor)
      if (!dryRun && result.sellerId) {
        if (!primaryLocation) {
          // F-5 (review 5.7): brak adresu = ZERO maila potwierdzenia dla tego
          // salonu, bo `salon_address` jest wymaganą zmienną kontraktu szablonu.
          // Do 5.7 dowiadywaliśmy się o tym dopiero z `failed` w ledgerze PO
          // zakupie. Sync jest jedynym miejscem, które widzi to ZANIM ktoś kupi.
          sellersWithoutAddress.push(vendor.vendor_id)
        } else {
          try {
            await upsertSellerAddressViaDb(
              db,
              result.sellerId,
              vendor.display_name ?? vendor.slug,
              primaryLocation
            )
          } catch (error) {
            // F-1 (review 5.7): błąd zapisu BYŁ degradowany do warningu, który
            // niczego nie zatrzymywał — a jego skutkiem jest mail bez adresu
            // salonu albo brak maila w ogóle. Liczymy go i eskalujemy razem z
            // resztą sygnałów runu, zamiast liczyć na to, że ktoś przeczyta log.
            addressWriteFailures.push({
              vendor_id: vendor.vendor_id,
              reason: error instanceof Error ? error.message : String(error),
            })
            pushUniqueWarning(
              warnings,
              seenWarnings,
              `Vendor '${vendor.vendor_id}': zapis seller_address nieudany: ${
                error instanceof Error ? error.message : String(error)
              }`
            )
          }
        }
      }

      // ADR-165 — pominięcia bramki własności muszą być widoczne w raporcie
      // ORAZ w osobnym, typowanym kanale: to jedyna klasa warningu, która
      // eskaluje run do porażki (W2).
      if (result.ownershipProtectedFields && result.ownershipProtectedFields.length > 0) {
        ownershipProtected.push({
          vendor_id: vendor.vendor_id,
          fields: [...result.ownershipProtectedFields],
          ...(result.ownershipProtectedDetails && result.ownershipProtectedDetails.length > 0
            ? { details: [...result.ownershipProtectedDetails] }
            : {}),
        })
        pushUniqueWarning(
          warnings,
          seenWarnings,
          formatOwnershipProtectedWarning(vendor.vendor_id, result.ownershipProtectedFields)
        )
      }

      // ADR-165 §4 (cykl 5) — drugie zdarzenie tej samej bramki: `--force`
      // przełamał ochronę. To NIE jest porażka runu (operator o to prosił),
      // ale musi być widoczne w raporcie po wykonaniu — inaczej „zniszczyłem
      // cudzą pracę" wygląda dokładnie jak zwykły sukces.
      if (result.vendorOverwrittenFields && result.vendorOverwrittenFields.length > 0) {
        vendorOverwritten.push({
          vendor_id: vendor.vendor_id,
          fields: [...result.vendorOverwrittenFields],
        })
        pushUniqueWarning(
          warnings,
          seenWarnings,
          formatVendorOverwriteWarning(vendor.vendor_id, result.vendorOverwrittenFields)
        )
      }

      if (result.action === "created") vendorCounts.created++
      else if (result.action === "updated") vendorCounts.updated++
      else vendorCounts.skipped++

      if (dryRun && collector) {
        collector.add({
          entityType: "seller",
          handle: vendor.slug.trim(),
          action:
            result.action === "created"
              ? "create"
              : result.action === "updated"
                ? "update"
                : "skip",
          note: result.note,
        })
      }

      // SellerProductLink sync — skip for suspended vendors
      const isSuspended = vendorStatusToSellerStatus(vendor.status) === "suspended"
      if (isSuspended) {
        pushUniqueWarning(
          warnings,
          seenWarnings,
          `Vendor '${vendor.vendor_id}': suspended; skipping seller-product linking`
        )
      }

      if (!result.sellerId) {
        pushUniqueWarning(
          warnings,
          seenWarnings,
          `Vendor '${vendor.vendor_id}': missing sellerId after upsert; skipping seller-product linking`
        )
      }

      if (!isSuspended && result.sellerId) {
        const vendorProductsPath = path.resolve(
          configRoot,
          instanceId,
          "markets",
          marketId,
          "vendors",
          vendor.vendor_id,
          "products.yaml"
        )

        let vendorProducts: VendorProductsFile = {}
        let vendorProductsReadOk = false
        try {
          vendorProducts = await readYamlFile(vendorProductsPath)
          vendorProductsReadOk = true
        } catch (e: any) {
          pushUniqueWarning(
            warnings,
            seenWarnings,
            `Vendor '${vendor.vendor_id}': cannot read products.yaml for linking (${e?.message ?? String(e)})`
          )
          // Keep flow running so other vendors can still sync.
        }

        // --prune keep-set: DB product ids this vendor SHOULD own per config
        // (collected for every successfully-resolved fixture, even ones the
        // single-seller guard skips — the vendor still owns them per config).
        const keepProductIds = new Set<string>()

        for (const vp of vendorProducts.products ?? []) {
          const fixtureId = (vp.product_id ?? "").trim()
          if (!fixtureId) {
            pushUniqueWarning(
              warnings,
              seenWarnings,
              `Vendor '${vendor.vendor_id}': product row with empty product_id; skipping SPL`
            )
            splCounts.skipped++
            splDetails.push({
              vendor_id: vendor.vendor_id,
              fixture_id: "",
              status: "skipped",
              reason: "missing product_id",
            })
            continue
          }

          const fallbackHandle = fixtureToHandle.get(fixtureId)
          const resolved = await resolveProductByFixture(productListFn, fixtureId, fallbackHandle)
          const product = resolved.product
          if (!product?.id) {
            const reason = resolved.error ?? "not found by fixture_id and fallback handle"
            pushUniqueWarning(
              warnings,
              seenWarnings,
              `Vendor '${vendor.vendor_id}': product fixture_id='${fixtureId}' not found in DB; skipping SPL (${reason})`
            )
            splCounts.missing_products++
            splDetails.push({
              vendor_id: vendor.vendor_id,
              fixture_id: fixtureId,
              status: "missing_product",
              reason,
            })
            continue
          }

          // This product is declared by the vendor's config → it must survive a
          // --prune pass for this seller (recorded before the single-seller
          // guard, which may skip the *link* but not the ownership intent).
          keepProductIds.add(product.id)

          if (resolved.strategy === "handle") {
            pushUniqueWarning(
              warnings,
              seenWarnings,
              `Vendor '${vendor.vendor_id}': linked fixture_id='${fixtureId}' using fallback handle='${fallbackHandle}'`
            )
          }

          // Single-seller invariant (orphaned-checkout guard). Mercur completes
          // one order per seller and resolves each cart item's seller via the
          // product↔seller link; a product linked to MORE THAN ONE seller is
          // ambiguous → `/store/shipping-options` returns nothing for it and
          // `/store/carts/:id/complete` fails ("items required to be assigned to
          // a seller but some of them are missing") AFTER the card is charged →
          // orphaned charge. Config that lists the same product_id under several
          // vendors must therefore NOT create a second link: keep the first
          // owner (vendor processing order) and skip + warn for the rest.
          const conflictingLink = await findConflictingSellerLink(
            db,
            product.id,
            result.sellerId
          )
          if (conflictingLink) {
            pushUniqueWarning(
              warnings,
              seenWarnings,
              `Vendor '${vendor.vendor_id}': product fixture_id='${fixtureId}' (db='${product.id}') is already owned by seller '${conflictingLink.seller_id}'; skipping to preserve the single-seller invariant (fix the config: a product_id must appear under only one vendor)`
            )
            splCounts.skipped++
            splDetails.push({
              vendor_id: vendor.vendor_id,
              fixture_id: fixtureId,
              status: "skipped",
              product_db_id: product.id,
              reason: `single-seller-conflict:owned-by=${conflictingLink.seller_id}`,
            })
            continue
          }

          // Upsert SellerProductLink
          if (dryRun) {
            collector?.add({
              entityType: "seller-product-link",
              handle: fixtureId,
              action: "create",
              note: `seller=${result.sellerId}; product=${product.id}`,
            })
            splCounts.created++
            splDetails.push({
              vendor_id: vendor.vendor_id,
              fixture_id: fixtureId,
              status: "created",
              product_db_id: product.id,
              reason: resolved.strategy === "handle" ? "fallback handle" : "fixture_id",
            })
            continue
          }

          if (splServiceResolveError || !splService) {
            const reason = `seller-product-link service unavailable: ${splServiceResolveError ?? "unknown"}`
            try {
              const outcome = await upsertSellerProductLinkViaDb(db, result.sellerId, product.id)
              splCounts.created++
              splDetails.push({
                vendor_id: vendor.vendor_id,
                fixture_id: fixtureId,
                status: "created",
                product_db_id: product.id,
                reason: `db-fallback:${outcome}`,
              })
              pushUniqueWarning(
                warnings,
                seenWarnings,
                `Vendor '${vendor.vendor_id}': ${reason}; linked via DB fallback (${outcome})`
              )
            } catch (dbError: any) {
              const dbReason = dbError?.message ?? String(dbError)
              pushUniqueWarning(
                warnings,
                seenWarnings,
                `Vendor '${vendor.vendor_id}': ${reason}; DB fallback failed - ${dbReason}`
              )
              splCounts.skipped++
              splDetails.push({
                vendor_id: vendor.vendor_id,
                fixture_id: fixtureId,
                status: "skipped",
                product_db_id: product.id,
                reason: `service-unavailable + db-fallback-failed: ${dbReason}`,
              })
            }
            continue
          }

          try {
            await splService.upsert({ seller_id: result.sellerId, product_id: product.id })
            splCounts.created++
            splDetails.push({
              vendor_id: vendor.vendor_id,
              fixture_id: fixtureId,
              status: "created",
              product_db_id: product.id,
              reason: resolved.strategy === "handle" ? "fallback handle" : "fixture_id",
            })
          } catch (e: any) {
            const reason = e?.message ?? String(e)
            try {
              const outcome = await upsertSellerProductLinkViaDb(db, result.sellerId, product.id)
              splCounts.created++
              splDetails.push({
                vendor_id: vendor.vendor_id,
                fixture_id: fixtureId,
                status: "created",
                product_db_id: product.id,
                reason: `service-upsert-failed + db-fallback:${outcome}`,
              })
              pushUniqueWarning(
                warnings,
                seenWarnings,
                `Vendor '${vendor.vendor_id}': seller-product upsert failed for fixture_id='${fixtureId}' (product='${product.id}') - ${reason}; linked via DB fallback (${outcome})`
              )
            } catch (dbError: any) {
              const dbReason = dbError?.message ?? String(dbError)
              pushUniqueWarning(
                warnings,
                seenWarnings,
                `Vendor '${vendor.vendor_id}': seller-product upsert failed for fixture_id='${fixtureId}' (product='${product.id}') - ${reason}; DB fallback failed - ${dbReason}`
              )
              splCounts.skipped++
              splDetails.push({
                vendor_id: vendor.vendor_id,
                fixture_id: fixtureId,
                status: "skipped",
                product_db_id: product.id,
                reason: `${reason}; db-fallback-failed: ${dbReason}`,
              })
            }
          }
        }

        // --prune: soft-delete this vendor's seller-product links to products no
        // longer in its config. Gated on a successful products.yaml read (never
        // prune on a read error) and on the helper's empty-keep-set fail-safe.
        if (prune && vendorProductsReadOk) {
          try {
            const stale = await pruneStaleSellerProductLinks(
              db,
              result.sellerId,
              keepProductIds
            )
            if (stale.length > 0) {
              if (!dryRun) {
                await db("product_product_seller_seller")
                  .whereIn(
                    "id",
                    stale.map((r) => r.id)
                  )
                  .update({ deleted_at: new Date() })
              }
              splCounts.pruned += stale.length
              pushUniqueWarning(
                warnings,
                seenWarnings,
                `Vendor '${vendor.vendor_id}': ${dryRun ? "[dry-run] would prune" : "pruned"} ${stale.length} stale seller-product link(s) not in config`
              )
              for (const r of stale) {
                splDetails.push({
                  vendor_id: vendor.vendor_id,
                  fixture_id: "",
                  status: "pruned",
                  product_db_id: r.product_id,
                  reason: dryRun ? "prune-dry-run" : "pruned-not-in-config",
                })
              }
            }
          } catch (pruneError: any) {
            pushUniqueWarning(
              warnings,
              seenWarnings,
              `Vendor '${vendor.vendor_id}': prune failed - ${pruneError?.message ?? String(pruneError)}`
            )
          }
        }
      }
    } catch (err: any) {
      pushUniqueWarning(
        warnings,
        seenWarnings,
        `Vendor '${vendor.vendor_id}': ${err?.message ?? String(err)}`
      )
      vendorCounts.skipped++
    }
  }

  const configuredVendorHandles = new Set(
    vendors
      .map((vendor) => vendor.slug?.trim())
      .filter((handle): handle is string => Boolean(handle))
  )

  if (configuredVendorHandles.size > 0) {
    const salesChannelId = await resolveSalesChannelId(db, marketId)

    if (salesChannelId) {
      try {
        const staleSync = await inactivateStaleMarketSellers(
          sellerModuleService,
          db,
          salesChannelId,
          configuredVendorHandles,
          dryRun,
          collector
        )
        staleSellerCounts.inactivated = staleSync.inactivated
        staleSellerCounts.skipped = staleSync.skipped
      } catch (err: any) {
        warnings.push(`Stale seller cleanup failed — ${err?.message ?? String(err)}`)
      }
    }
  }

  const summary: SyncSummary = {
    ok: warnings.length === 0,
    instance_id: instanceId,
    market_id: marketId,
    vendors: vendorCounts,
    spl: splCounts,
    stale_sellers: staleSellerCounts,
    spl_details: splDetails,
    warnings,
    ownership_protected: ownershipProtected,
    vendor_overwritten: vendorOverwritten,
    // F-1/F-5 (review 5.7): oba kanały są TYPOWANE, nie tylko tekstem w
    // `warnings` — konsument (gp-cli, CI) ma je czytać, a nie parsować logi.
    address_write_failures: addressWriteFailures,
    sellers_without_address: sellersWithoutAddress,
  }

  if (dryRun && collector) {
    console.log(collector.renderTable())
  }

  console.log(JSON.stringify(summary, null, 2))

  // W2 (review cykl 4) — ROZRÓŻNIENIE KLAS WARNINGÓW.
  //
  // Do cyklu 3 każdy warning tego etapu ustawiał `exitCode = 1`, a orchestrator
  // (po fixie V4) przestał ten kod połykać. Efekt uboczny: zastane, nieszkodliwe
  // warningi — „vendor suspended; skipping seller-product linking", „missing
  // sellerId", „no vendors in market config" — zamieniały w pełni udany
  // `gp catalog sync` w twardą porażkę całego runu.
  //
  // Intencja ADR-165 §2 była węższa: pominięcie pola vendor-owned nie ma
  // wyglądać na pełny sukces. Eskalujemy więc WYŁĄCZNIE tę klasę; reszta
  // warningów zostaje widoczna w `summary.warnings`, tak jak była przez trzy
  // release'y, i nie zmienia kodu wyjścia.
  if (ownershipProtected.length > 0 && !dryRun) {
    process.exitCode = 1
  }

  return summary
}
