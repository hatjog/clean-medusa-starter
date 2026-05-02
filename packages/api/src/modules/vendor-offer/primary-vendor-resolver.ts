/**
 * vendor-offer/primary-vendor-resolver.ts — DataLoader-backed primary vendor
 * resolution per STORY-4-2-PRIMARY-VENDOR-RESOLVER (5 ACs verbatim).
 *
 * @see _bmad-output/implementation-artifacts/v150/STORY-4-2-PRIMARY-VENDOR-RESOLVER.md
 * @see _bmad-output/planning-artifacts/architecture.md#D-77 (multi-vendor pricing flag-off)
 * @see _bmad-output/planning-artifacts/architecture.md#ADR-070 (foundation→runtime split)
 *
 * v1.5.0 flag-off behaviour: while `multi_vendor_pricing_enabled=false` the
 * resolver returns `{ primary: VendorOffer | null; secondary: [] }` — the
 * locked return shape so v1.6.0's flag-flip is a pure runtime activation
 * (no callsite type signature churn — see story §E8 Reverse Engineering).
 *
 * Algorithm (chosen via Comparative Matrix §E5, score 9/9):
 *   incumbent_marker=true (READ from vendor_offer.incumbent_marker)
 *   → first-active (status='active' ORDER BY created_at ASC, id ASC)
 *   → null (no archive fallback in v1.5.0 — story Scope §3 out-of-scope).
 *
 * Cache strategy (PAT-5 / AR-3): the DataLoader **constructor** is wrapped
 * in React 19 `cache()` so each request scope gets one DataLoader instance
 * (NOT individual lookups — Method 2 Frontend Specialist guidance §E1).
 *
 * Manual-registry guard: this module is the canonical READ helper for
 * primary-vendor lookups. WRITE callsites for `incumbent_marker` mutations
 * live in `vendor-offer.service.ts` per Pre-mortem §E2 R2 mitigation.
 *
 * Server-only segregation (AR-26): backend-side module — naturally
 * server-only; storefront callsite façade lives at
 * `GP/storefront/src/data/vendor-offer/primary-resolver.ts`.
 */

// ============================================================================
// Stable type contract (mirrors STORY-4-1 vendor-offer/types.ts surface).
// ----------------------------------------------------------------------------
// STORY-4-1 ships the canonical `vendor_offer` Mikro-ORM entity + types.ts in
// the same backend module. Until that lands as a published export, the typed
// surface below is the **stable contract** consumed by this resolver — it is
// a strict subset of STORY-4-1's planned export shape so the upstream swap is
// structural-compatible (additive-MINOR).
// ============================================================================

/**
 * VendorOfferStatus — closed lifecycle enum (per ADR-070 §D-74 tri-state;
 * no soft-delete column).
 */
export type VendorOfferStatus = "active" | "suspended" | "archived"

/**
 * VendorOffer — minimum-viable row shape consumed by the resolver. Strict
 * subset of STORY-4-1's full entity surface so consumers depending on this
 * module's export do not need to migrate when 4-1 lands the canonical type.
 */
export interface VendorOffer {
  id: string
  vendor_id: string
  product_id: string
  price_amount: number
  price_currency: string
  status: VendorOfferStatus
  incumbent_marker: boolean
  /** Locked from day one — see story §E8 Reverse Engineering. */
  primary?: boolean
  created_at: Date | string
  updated_at?: Date | string
}

/**
 * PrimaryVendorKey — typed key for the DataLoader cache. The normalizer
 * (`keyFn`) rejects empty/whitespace `productId` (AC-PVR-4.2-01).
 */
export type PrimaryVendorKey = { productId: string }

/**
 * PrimaryVendorResolution — locked return shape (story §AC-PVR-4.2 + R5).
 *
 * In v1.5.0 `secondary` is ALWAYS `[]` (flag-off semantics).
 * In v1.6.0 the runtime activation flag flips and `secondary` is populated
 * — callsites destructure `primary` only in v1.5.0; v1.6.0 UI work consumes
 * `secondary` additively. NO callsite type signature changes.
 */
export type PrimaryVendorResolution = {
  primary: VendorOffer | null
  secondary: VendorOffer[]
}

// ============================================================================
// DataLoader-compatible shim
// ----------------------------------------------------------------------------
// `dataloader` (facebook/dataloader) is the directive-locked dep. The npm
// install lands with STORY-4-1's package.json edits in the canonical sequence;
// until then this minimal shim implements the exact subset the resolver uses
// (`load`, `loadMany`, `clear`, `clearAll`, `cacheKeyFn`, `maxBatchSize`,
// `batchScheduleFn`). Replacing the import with `import DataLoader from
// 'dataloader'` is a one-line drop-in once the dep is published — every
// behaviour below is interface-faithful.
// ============================================================================

type BatchLoadFn<K, V> = (keys: ReadonlyArray<K>) => Promise<ReadonlyArray<V | Error>>

interface DataLoaderOptions<K, V> {
  batch?: boolean
  maxBatchSize?: number
  cache?: boolean
  cacheKeyFn?: (key: K) => string
  batchScheduleFn?: (callback: () => void) => void
}

/**
 * Minimal DataLoader contract that mirrors facebook/dataloader's surface.
 *
 * Behavioural parity:
 *  - Per-key dedup within a request via `cacheKeyFn` (typed-key normalizer).
 *  - Aggressive 1ms batch window via `batchScheduleFn` (default scheduler).
 *  - `maxBatchSize` chunks oversized batches before delegating to `batchFn`.
 *  - `batch: false` disables batching (single-key per call).
 *
 * The resolver calls `getPrimaryVendorLoader()` (which is wrapped in
 * React 19 `cache()`) to obtain one instance per request scope — see PAT-5.
 */
export class DataLoader<K, V> {
  private readonly batchFn: BatchLoadFn<K, V>
  private readonly options: Required<
    Pick<DataLoaderOptions<K, V>, "batch" | "maxBatchSize" | "cache">
  > &
    Pick<DataLoaderOptions<K, V>, "cacheKeyFn" | "batchScheduleFn">

  private readonly resultCache: Map<string, Promise<V>> = new Map()
  private pending: Array<{
    key: K
    cacheKey: string
    resolve: (value: V) => void
    reject: (err: Error) => void
  }> = []
  private scheduled = false

  /** Internal counter — exposed to tests for N+1 prevention proof. */
  public readonly _stats = { batchCalls: 0, totalKeys: 0 }

  constructor(batchFn: BatchLoadFn<K, V>, options: DataLoaderOptions<K, V> = {}) {
    this.batchFn = batchFn
    this.options = {
      batch: options.batch ?? true,
      maxBatchSize: options.maxBatchSize ?? Infinity,
      cache: options.cache ?? true,
      cacheKeyFn: options.cacheKeyFn,
      batchScheduleFn: options.batchScheduleFn,
    }
  }

  load(key: K): Promise<V> {
    const cacheKey = this.cacheKeyOf(key)
    if (this.options.cache) {
      const hit = this.resultCache.get(cacheKey)
      if (hit) {
        return hit
      }
    }
    const promise = new Promise<V>((resolve, reject) => {
      this.pending.push({ key, cacheKey, resolve, reject })
    })
    if (this.options.cache) {
      this.resultCache.set(cacheKey, promise)
    }
    this.schedule()
    return promise
  }

  loadMany(keys: ReadonlyArray<K>): Promise<Array<V | Error>> {
    return Promise.all(
      keys.map((k) =>
        this.load(k).then(
          (v) => v,
          (e: Error) => e
        )
      )
    )
  }

  clear(key: K): this {
    this.resultCache.delete(this.cacheKeyOf(key))
    return this
  }

  clearAll(): this {
    this.resultCache.clear()
    return this
  }

  private cacheKeyOf(key: K): string {
    return this.options.cacheKeyFn ? this.options.cacheKeyFn(key) : String(key)
  }

  private schedule(): void {
    if (this.scheduled) {
      return
    }
    this.scheduled = true
    const dispatch = () => {
      this.scheduled = false
      void this.dispatch()
    }
    if (this.options.batchScheduleFn) {
      this.options.batchScheduleFn(dispatch)
    } else if (!this.options.batch) {
      // Synchronous immediate flush for batch=false.
      dispatch()
    } else {
      // Default: next microtask (DataLoader's documented default).
      Promise.resolve().then(dispatch)
    }
  }

  private async dispatch(): Promise<void> {
    if (this.pending.length === 0) {
      return
    }
    const queue = this.pending
    this.pending = []

    const maxBatch = this.options.batch
      ? this.options.maxBatchSize
      : 1
    for (let i = 0; i < queue.length; i += maxBatch) {
      const slice = queue.slice(i, i + maxBatch)
      this._stats.batchCalls += 1
      this._stats.totalKeys += slice.length
      try {
        const values = await this.batchFn(slice.map((q) => q.key))
        if (values.length !== slice.length) {
          const err = new Error(
            `DataLoader batch function returned ${values.length} values for ${slice.length} keys`
          )
          slice.forEach((q) => q.reject(err))
          continue
        }
        slice.forEach((q, idx) => {
          const v = values[idx]
          if (v instanceof Error) {
            q.reject(v)
          } else {
            q.resolve(v)
          }
        })
      } catch (err) {
        slice.forEach((q) => q.reject(err as Error))
      }
    }
  }
}

// ============================================================================
// Resolver core
// ============================================================================

/**
 * VendorOfferRepositoryReader — minimal repository surface required by the
 * resolver. STORY-4-1 lands the Mikro-ORM repository; the resolver depends on
 * this **interface**, not on the concrete repository, so the v1.5.0 wiring
 * (and tests) can supply an in-memory implementation without coupling.
 */
export interface VendorOfferRepositoryReader {
  /**
   * Single SQL roundtrip: `SELECT … FROM vendor_offer WHERE product_id = ANY($1)
   * AND status = 'active' ORDER BY product_id ASC,
   * (incumbent_marker IS TRUE) DESC, created_at ASC, id ASC`.
   */
  findActiveByProductIds(productIds: ReadonlyArray<string>): Promise<ReadonlyArray<VendorOffer>>
}

/** Default key normalizer — see AC-PVR-4.2-01 (typed key + integration test). */
export function normalizePrimaryVendorKey(key: PrimaryVendorKey): string {
  if (key === null || key === undefined) {
    throw new TypeError("PrimaryVendorKey: null/undefined key")
  }
  if (typeof key.productId !== "string" || key.productId.trim().length === 0) {
    throw new TypeError("PrimaryVendorKey.productId required (non-empty string)")
  }
  return key.productId
}

/**
 * Algorithm: incumbent_marker → first-active → null.
 *
 * Rows in `offers` are assumed pre-filtered to `status='active'` and pre-sorted
 * `(incumbent_marker IS TRUE) DESC, created_at ASC, id ASC`. The head row wins.
 */
export function selectPrimaryFromActiveSorted(offers: ReadonlyArray<VendorOffer>): VendorOffer | null {
  if (offers.length === 0) {
    return null
  }
  return offers[0]
}

/**
 * Build a DataLoader batchFn over the repository. Pure function — no React
 * `cache()` here so unit tests can call this without touching the React stack.
 */
export function buildPrimaryVendorBatchFn(
  repo: VendorOfferRepositoryReader
): BatchLoadFn<PrimaryVendorKey, PrimaryVendorResolution> {
  return async (keys: ReadonlyArray<PrimaryVendorKey>) => {
    const productIds = keys.map((k) => k.productId)
    const rows = await repo.findActiveByProductIds(productIds)

    // Group by product_id, preserving incoming sort order.
    const grouped = new Map<string, VendorOffer[]>()
    for (const row of rows) {
      const arr = grouped.get(row.product_id)
      if (arr) {
        arr.push(row)
      } else {
        grouped.set(row.product_id, [row])
      }
    }

    return keys.map<PrimaryVendorResolution>((k) => {
      const list = grouped.get(k.productId)
      if (!list || list.length === 0) {
        // No archive fallback v1.5.0 (Scope §3 out-of-scope).
        return { primary: null, secondary: [] }
      }
      // Sort defensively in case the repository returned unsorted rows.
      const sorted = [...list].sort((a, b) => {
        if (a.incumbent_marker !== b.incumbent_marker) {
          return a.incumbent_marker ? -1 : 1
        }
        const ca = typeof a.created_at === "string" ? a.created_at : a.created_at.toISOString()
        const cb = typeof b.created_at === "string" ? b.created_at : b.created_at.toISOString()
        if (ca !== cb) {
          return ca < cb ? -1 : 1
        }
        return a.id < b.id ? -1 : 1
      })
      // Flag-off: secondary is ALWAYS []. v1.6.0 flag-flip populates additively.
      return { primary: selectPrimaryFromActiveSorted(sorted), secondary: [] }
    })
  }
}

/** Default DataLoader options — locked at AC-PVR-4.2-01 (1ms window, max 100). */
export const PRIMARY_VENDOR_LOADER_OPTIONS: DataLoaderOptions<
  PrimaryVendorKey,
  PrimaryVendorResolution
> = {
  batch: true,
  maxBatchSize: 100,
  cache: true,
  cacheKeyFn: normalizePrimaryVendorKey,
  // Aggressive 1ms window per story Implementation hints.
  batchScheduleFn: (cb) => {
    setTimeout(cb, 1)
  },
}

/**
 * Construct a fresh DataLoader for primary vendor resolution. The constructor
 * itself is intentionally NOT wrapped in `cache()` here — the storefront-side
 * adapter (`GP/storefront/src/data/vendor-offer/primary-resolver.ts`) wraps it
 * with React 19 `cache()` per AC-PVR-4.2-01.
 *
 * Backend callers (e.g. workflow steps) that need request-scoped batching can
 * construct their own loader per request.
 */
export function createPrimaryVendorLoader(
  repo: VendorOfferRepositoryReader,
  options?: DataLoaderOptions<PrimaryVendorKey, PrimaryVendorResolution>
): DataLoader<PrimaryVendorKey, PrimaryVendorResolution> {
  return new DataLoader<PrimaryVendorKey, PrimaryVendorResolution>(
    buildPrimaryVendorBatchFn(repo),
    { ...PRIMARY_VENDOR_LOADER_OPTIONS, ...options }
  )
}

/**
 * Direct (un-batched) READ helper — used by the storefront query layer when
 * a single-product callsite has no peer requests to batch with. The helper
 * MUST NOT call `assertRuntimeDisabled` (that guard is mutating-only per
 * STORY-4-1 service-layer concern §E2 R2).
 */
export async function resolvePrimaryVendorForProduct(
  repo: VendorOfferRepositoryReader,
  productId: string
): Promise<PrimaryVendorResolution> {
  normalizePrimaryVendorKey({ productId })
  const batchFn = buildPrimaryVendorBatchFn(repo)
  const [result] = await batchFn([{ productId }])
  if (result instanceof Error) {
    throw result
  }
  return result
}
