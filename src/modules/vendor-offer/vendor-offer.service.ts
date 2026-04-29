/**
 * vendor-offer/vendor-offer.service.ts — service-layer guarded CRUD façade.
 *
 * @see ADR-070 — vendor-selection-policy (v1.5.0 schema-only, v1.6.0 runtime).
 * @see _bmad-output/implementation-artifacts/v150/STORY-4-1-MULTI-VENDOR-FOUNDATION-SCHEMA.md
 *
 * # ADR-070 schema-only enforcement
 *
 * v1.5.0 lands the schema (vendor_offer table + cart_item.selected_vendor_offer_id
 * FK) without runtime activation. To prevent silent runtime engagement BEFORE
 * v1.6.0 unlock + STORY-MIG-C3 zero-violations gate, every mutating method
 * here calls `assertRuntimeDisabled()` which throws when the feature flag
 * `multi_vendor_pricing_enabled=true`.
 *
 * The READ side (`getById`, `findByProduct`) is intentionally NOT guarded —
 * the table exists and may be queried for diagnostic purposes; only the WRITE
 * path is locked. v1.6.0 will remove the assertRuntimeDisabled() guards from
 * the write methods (single-line removals — minimal diff).
 *
 * # Optimistic locking
 *
 * Every UPDATE bumps `version` and uses `WHERE version = $expected_version`
 * as a guard. A row-not-found result raises VERSION_CONFLICT. Callers MUST
 * read the current version before mutating; the service does NOT auto-retry.
 *
 * # Persistence
 *
 * v1.5.0 ships the service as an ABSTRACT shape — no Mikro-ORM repository is
 * wired (write path is guarded; read path is documented). v1.6.0 wires the
 * Mikro-ORM repository against the vendor_offer entity.
 */

import { assertCanTransition } from "./lifecycle"
import type {
  VendorOffer,
  VendorOfferDraft,
  VendorOfferLifecycleState,
  VendorOfferUpdate,
} from "./types"
import { VendorOfferError } from "./types"

/**
 * VendorOfferRuntimeFlags — feature-flag bag injected by the module loader.
 *
 * v1.5.0 wires this from market-runtime-config (`multi_vendor_pricing_enabled`
 * default false). Callers SHOULD NOT construct this directly — the module
 * container resolves it.
 */
export interface VendorOfferRuntimeFlags {
  /**
   * v1.5.0 default = false (schema-only enforcement).
   * v1.6.0 flips to true after pre-flag-flip ops gate (per ADR-070 §Decyzja).
   */
  multi_vendor_pricing_enabled: boolean
}

/**
 * VendorOfferRepositoryPort — port interface for the persistence layer.
 *
 * v1.5.0 service uses an in-memory ABSTRACT default (the module is
 * read-only-ish — the SQL table exists, but the Mikro-ORM mapping is wired
 * in v1.6.0). The interface is frozen here so v1.6.0 can swap implementation
 * without touching the service.
 */
export interface VendorOfferRepositoryPort {
  findById(id: string): Promise<VendorOffer | null>
  findByProduct(productId: string): Promise<VendorOffer[]>
  insert(draft: VendorOffer): Promise<VendorOffer>
  /**
   * Conditional UPDATE: applies `patch` only when `WHERE id = $id AND version = $expected_version`.
   * Returns null on version mismatch (caller raises VERSION_CONFLICT).
   */
  conditionalUpdate(
    id: string,
    expectedVersion: number,
    patch: Partial<VendorOffer>
  ): Promise<VendorOffer | null>
}

/** v1.5.0 abstract repo — methods throw NOT_FOUND, allowing wiring tests to assert call shape. */
class AbstractVendorOfferRepository implements VendorOfferRepositoryPort {
  async findById(_id: string): Promise<VendorOffer | null> {
    return null
  }
  async findByProduct(_productId: string): Promise<VendorOffer[]> {
    return []
  }
  async insert(draft: VendorOffer): Promise<VendorOffer> {
    return draft
  }
  async conditionalUpdate(
    _id: string,
    _expectedVersion: number,
    _patch: Partial<VendorOffer>
  ): Promise<VendorOffer | null> {
    return null
  }
}

/**
 * VendorOfferService — façade for vendor_offer lifecycle + CRUD.
 *
 * Construction:
 *   const service = new VendorOfferService({
 *     flags: { multi_vendor_pricing_enabled: false },
 *     repo: vendorOfferRepository,        // optional; defaults to abstract
 *     signatureFn: defaultSignatureFn,    // optional; deterministic default
 *     versionInitial: 0,                  // optional
 *     clock: () => new Date(),            // optional; for deterministic tests
 *   })
 */
export class VendorOfferService {
  private readonly flags: VendorOfferRuntimeFlags
  private readonly repo: VendorOfferRepositoryPort
  private readonly signatureFn: (draft: VendorOfferDraft) => string
  private readonly clock: () => Date

  constructor(args: {
    flags: VendorOfferRuntimeFlags
    repo?: VendorOfferRepositoryPort
    signatureFn?: (draft: VendorOfferDraft) => string
    clock?: () => Date
  }) {
    this.flags = args.flags
    this.repo = args.repo ?? new AbstractVendorOfferRepository()
    this.signatureFn = args.signatureFn ?? defaultSignatureFn
    this.clock = args.clock ?? (() => new Date())
  }

  /**
   * assertRuntimeDisabled — defensive guard ensuring v1.5.0 stays
   * schema-only. v1.6.0 removes this guard from the write methods.
   */
  private assertRuntimeDisabled(method: string): void {
    if (this.flags.multi_vendor_pricing_enabled) {
      throw new VendorOfferError({
        code: "RUNTIME_DISABLED",
        message:
          `VendorOfferService.${method}: runtime path locked in v1.5.0 ` +
          `(ADR-070 schema-only enforcement). multi_vendor_pricing_enabled ` +
          `MUST stay false until v1.6.0 + STORY-MIG-C3 zero-violations gate.`,
        context: { method },
      })
    }
  }

  // ---------- READ side (NOT guarded — diagnostic only in v1.5.0) ----------

  async getById(id: string): Promise<VendorOffer | null> {
    return this.repo.findById(id)
  }

  async findByProduct(productId: string): Promise<VendorOffer[]> {
    return this.repo.findByProduct(productId)
  }

  // ---------- WRITE side (guarded by assertRuntimeDisabled) ----------

  async create(draft: VendorOfferDraft): Promise<VendorOffer> {
    this.assertRuntimeDisabled("create")
    if (!draft.vendor_id || !draft.product_id) {
      throw new VendorOfferError({
        code: "INVALID_DRAFT",
        message: "vendor_id and product_id are required",
        context: { draft },
      })
    }
    if (draft.price < 0) {
      throw new VendorOfferError({
        code: "INVALID_DRAFT",
        message: "price MUST be >= 0",
        context: { price: draft.price },
      })
    }
    if (draft.seat_capacity < 0) {
      throw new VendorOfferError({
        code: "INVALID_DRAFT",
        message: "seat_capacity MUST be >= 0",
        context: { seat_capacity: draft.seat_capacity },
      })
    }
    const now = this.clock()
    const row: VendorOffer = {
      id: cryptoRandomUuid(),
      vendor_id: draft.vendor_id,
      product_id: draft.product_id,
      price: draft.price,
      seat_capacity: draft.seat_capacity,
      status: draft.status ?? "active",
      incumbent_marker: draft.incumbent_marker ?? false,
      signature: draft.signature || this.signatureFn(draft),
      version: 0,
      created_at: now,
      updated_at: now,
      archived_at: null,
    }
    return this.repo.insert(row)
  }

  async update(input: VendorOfferUpdate): Promise<VendorOffer> {
    this.assertRuntimeDisabled("update")
    const current = await this.repo.findById(input.id)
    if (!current) {
      throw new VendorOfferError({
        code: "NOT_FOUND",
        message: `vendor_offer ${input.id} not found`,
        context: { id: input.id },
      })
    }
    if (current.version !== input.expected_version) {
      throw new VendorOfferError({
        code: "VERSION_CONFLICT",
        message:
          `vendor_offer ${input.id}: expected version ${input.expected_version}, ` +
          `actual ${current.version}`,
        context: {
          id: input.id,
          expected: input.expected_version,
          actual: current.version,
        },
      })
    }
    if (input.patch.status && input.patch.status !== current.status) {
      assertCanTransition(current.status, input.patch.status)
    }
    const now = this.clock()
    const patched: Partial<VendorOffer> = {
      ...input.patch,
      version: current.version + 1,
      updated_at: now,
      archived_at:
        input.patch.status === "archived" ? now : current.archived_at,
    }
    const updated = await this.repo.conditionalUpdate(
      input.id,
      input.expected_version,
      patched
    )
    if (!updated) {
      // Race: another writer bumped version between findById + conditionalUpdate.
      throw new VendorOfferError({
        code: "VERSION_CONFLICT",
        message: `vendor_offer ${input.id}: concurrent update detected`,
        context: { id: input.id, expected: input.expected_version },
      })
    }
    return updated
  }

  /**
   * transitionStatus — convenience wrapper for the common case of changing
   * lifecycle state without other field updates.
   */
  async transitionStatus(args: {
    id: string
    expected_version: number
    to: VendorOfferLifecycleState
  }): Promise<VendorOffer> {
    return this.update({
      id: args.id,
      expected_version: args.expected_version,
      patch: { status: args.to },
    })
  }
}

/**
 * defaultSignatureFn — deterministic per-offer signature derivation. Per
 * D-78 (ADR-079 placeholder — referenced via brief), the signature is a
 * hash of (vendor_id, product_id, price, seat_capacity) at creation time.
 *
 * v1.5.0 uses a stable string concat (sufficient for index uniqueness +
 * validator self-test). v1.6.0 may upgrade to SHA-256 once MoR snapshot
 * pipeline is wired.
 */
export function defaultSignatureFn(draft: VendorOfferDraft): string {
  return [
    "vof",
    draft.vendor_id,
    draft.product_id,
    draft.price.toFixed(4),
    String(draft.seat_capacity),
  ].join(":")
}

/**
 * cryptoRandomUuid — locally-scoped UUID factory. Falls back to a Math.random
 * synthetic id if globalThis.crypto is unavailable (tests, older Node).
 */
function cryptoRandomUuid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } }
  if (g.crypto?.randomUUID) {
    return g.crypto.randomUUID()
  }
  // Synthetic fallback — Math.random is sufficient for tests; production
  // path uses the postgres-side gen_random_uuid() per the SQL migration.
  const hex = (n: number) => Math.floor(Math.random() * 0x10000 * n).toString(16).padStart(4, "0")
  return `${hex(1)}${hex(1)}-${hex(1)}-${hex(1)}-${hex(1)}-${hex(1)}${hex(1)}${hex(1)}`
}
