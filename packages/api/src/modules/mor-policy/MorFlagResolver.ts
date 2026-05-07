/**
 * MorFlagResolver — TS application service that resolves the composite
 * tri-state per ADR-074 precedence:
 *
 *   1. global flag wins        → `vendor_mor_enabled = false` ⇒ `terminated` effective override
 *   2. per-vendor suspension   → `seller.status = 'suspended'` ⇒ `suspended` (runtime-mutable)
 *   3. no auto-resume on deploy/flag flip — the persisted `seller.status` is authoritative
 *
 * @see _bmad-output/planning-artifacts/architecture.md §D-69 (L450-464)
 * @see specs/adr/2026-04-28-adr-074-tri-state-flag-semantics.md
 *
 * Caching strategy (PAT-5 Hexagonal-light + AR-23 RSC):
 *
 *   - Storefront RSC callsites should wrap `resolve(...)` in React 19 `cache()` so that
 *     repeated invocations within the same request reuse the same Promise.
 *   - Backend (Medusa) callsites are short-lived per HTTP request; the service exposes a
 *     `withRequestCache()` factory that returns a per-request memoized resolver. Outside
 *     a request scope, the service is uncached (each call hits the data ports).
 *
 * Boundary:
 *   - This service depends on two narrow ports — {@link FlagFlagsPort} and
 *     {@link SellerStatusPort} — not on any concrete DB client. Tests inject in-memory
 *     fakes; runtime wiring (Medusa container) is the responsibility of the module
 *     loader, not this file.
 */

export type MorFlagStatus = "open" | "suspended" | "terminated" | "pending_approval"

export type MorFlagPrecedence = {
  /** True when global `vendor_mor_enabled` decided the outcome (`terminated`). */
  globalFlag: boolean
  /** True when per-vendor `seller.status='suspended'` decided the outcome. */
  perVendorPause: boolean
  /** True when D-74 archive fallback contributed (caller flag, surfaced for audit). */
  archiveFallback: boolean
}

export type MorFlagResolution = {
  status: MorFlagStatus
  precedence: MorFlagPrecedence
  /** Wall-clock timestamp at the time the resolver consumed source data. */
  sourceTimestamp: Date
}

/**
 * Port exposing the global feature flag for `vendor_mor_enabled` per market.
 * Concrete impl (Medusa runtime) reads from `market_runtime_config` (see D-40);
 * fakes return a fixed value.
 */
export interface FlagFlagsPort {
  /**
   * @returns `true` when `vendor_mor_enabled` is on for the given market.
   *          ADR-074 row 5: `false` collapses any seller to `terminated`.
   */
  isVendorMorEnabled(marketId: string): Promise<boolean>
}

/**
 * Port exposing the persisted `seller.status` per (market, seller).
 * Concrete impl reads `seller` row (RLS-scoped); fakes return a fixed value.
 */
export interface SellerStatusPort {
  /**
   * @returns the current `seller.status` for the given seller in the given market.
   *          Returns `null` when seller not found in market scope (resolver maps to `pending_approval`).
   */
  getSellerStatus(marketId: string, sellerId: string): Promise<MorFlagStatus | null>
}

/**
 * Per-request memoization key. Keying on `(marketId, sellerId)` is sufficient because
 * the resolver is read-only within a request — concurrent admin pause writes are not
 * visible until the next request (race tested in AC-FLAG-1.3-04).
 */
const cacheKey = (marketId: string, sellerId: string): string =>
  `${marketId}::${sellerId}`

export class MorFlagResolver {
  constructor(
    private readonly flagsPort: FlagFlagsPort,
    private readonly sellerPort: SellerStatusPort
  ) {}

  /**
   * Resolve the composite tri-state per ADR-074 precedence.
   *
   * @throws Error when `marketId` or `sellerId` is empty (invalid input — caller bug).
   */
  async resolve(marketId: string, sellerId: string): Promise<MorFlagResolution> {
    if (!marketId) {
      throw new Error("MorFlagResolver: marketId is required")
    }
    if (!sellerId) {
      throw new Error("MorFlagResolver: sellerId is required")
    }

    const sourceTimestamp = new Date()

    // Precedence step 1: global flag wins.
    const globalFlag = await this.flagsPort.isVendorMorEnabled(marketId)
    if (!globalFlag) {
      return {
        status: "terminated",
        precedence: { globalFlag: true, perVendorPause: false, archiveFallback: false },
        sourceTimestamp,
      }
    }

    // Precedence step 2: per-vendor `seller.status` wins among remaining states.
    const sellerStatus = await this.sellerPort.getSellerStatus(marketId, sellerId)
    if (sellerStatus === null) {
      // Unknown seller in market — treat as `pending_approval`.
      return {
        status: "pending_approval",
        precedence: { globalFlag: false, perVendorPause: false, archiveFallback: false },
        sourceTimestamp,
      }
    }

    if (sellerStatus === "suspended") {
      return {
        status: "suspended",
        precedence: { globalFlag: false, perVendorPause: true, archiveFallback: false },
        sourceTimestamp,
      }
    }

    if (sellerStatus === "terminated" || sellerStatus === "pending_approval") {
      return {
        status: sellerStatus,
        precedence: { globalFlag: false, perVendorPause: false, archiveFallback: false },
        sourceTimestamp,
      }
    }

    // open — happy path.
    return {
      status: "open",
      precedence: { globalFlag: false, perVendorPause: false, archiveFallback: false },
      sourceTimestamp,
    }
  }

  /**
   * Returns a per-request memoized resolver. Re-invoking with the same
   * `(marketId, sellerId)` returns the same Promise, matching React 19 `cache()`
   * semantics for backend callsites that don't run inside an RSC.
   *
   * Storefront RSC callsites should prefer wrapping `resolve` directly with
   * `cache()` from `react`; this factory exists for non-RSC backend contexts.
   */
  withRequestCache(): (marketId: string, sellerId: string) => Promise<MorFlagResolution> {
    const memo = new Map<string, Promise<MorFlagResolution>>()
    return (marketId: string, sellerId: string) => {
      const key = cacheKey(marketId, sellerId)
      const existing = memo.get(key)
      if (existing) return existing
      const fresh = this.resolve(marketId, sellerId)
      memo.set(key, fresh)
      return fresh
    }
  }
}
