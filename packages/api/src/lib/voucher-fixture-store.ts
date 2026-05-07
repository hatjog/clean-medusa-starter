/**
 * Story v160-cleanup-13b — In-memory voucher fixture store.
 *
 * Backs the public `GET /store/vouchers/:code` endpoint until Mercur 2 native
 * voucher entity lands (v1.7.0). Stores deterministic voucher fixtures keyed
 * by `code` so E2E (Story 8.8 AC6 Steps 5+6) can render the recipient claim
 * page without persistent DB schema changes.
 *
 * Data shape matches storefront `VoucherPublicView` contract
 * (GP/storefront/src/lib/data/voucher.ts) — AR45 PII allowlist applied
 * defensively at the boundary.
 *
 * v1.7.0 migration path: replace this module with Mercur 2 native voucher
 * service or PG-backed `voucher` table (see specs/releases/v1.7.0/ when
 * authored). Consumers (route handlers) treat this as a port and can swap
 * implementation without touching the response contract.
 */

export type VoucherStatus =
  | "idle"
  | "consent_pending"
  | "claimed"
  | "withdrawn"

export type VoucherAuditEventType =
  | "created"
  | "sent"
  | "opened"
  | "claimed"
  | "withdrawn"

export interface VoucherFixture {
  code: string
  /** story v160-cleanup-27g: market scope for DPIA R-12 cross-market isolation. Optional for backward compat. */
  market_id?: string
  seller_id: string
  seller_name: string
  seller_handle: string
  product_title: string
  value_minor: number
  currency_code: string
  status: VoucherStatus
  expires_at: string | null
  events: Array<{
    id: string
    event_type: VoucherAuditEventType
    occurred_at: string
  }>
}

/**
 * Default deterministic seed — 1 idle voucher + 1 claimed voucher with audit
 * trail so E2E flag-on suite can hit both states without a real claim flow.
 */
const DEFAULT_FIXTURES: ReadonlyArray<VoucherFixture> = [
  {
    code: "E2E-IDLE-VOUCHER-001",
    seller_id: "sel_01CITYBEAUTY00000000000",
    seller_name: "City Beauty",
    seller_handle: "city-beauty",
    product_title: "Peeling kwasami",
    value_minor: 22000,
    currency_code: "PLN",
    status: "idle",
    expires_at: "2027-12-31T23:59:59Z",
    events: [
      {
        id: "evt-idle-001-created",
        event_type: "created",
        occurred_at: "2026-05-04T08:00:00Z",
      },
      {
        id: "evt-idle-001-sent",
        event_type: "sent",
        occurred_at: "2026-05-04T08:01:00Z",
      },
    ],
  },
  {
    code: "E2E-CLAIMED-VOUCHER-002",
    seller_id: "sel_01KREMIDOTYK0000000000",
    seller_name: "Kremidotyk",
    seller_handle: "kremidotyk",
    product_title: "Peeling węglowy",
    value_minor: 24000,
    currency_code: "PLN",
    status: "claimed",
    expires_at: "2027-12-31T23:59:59Z",
    events: [
      {
        id: "evt-claimed-002-created",
        event_type: "created",
        occurred_at: "2026-05-04T09:00:00Z",
      },
      {
        id: "evt-claimed-002-sent",
        event_type: "sent",
        occurred_at: "2026-05-04T09:01:00Z",
      },
      {
        id: "evt-claimed-002-opened",
        event_type: "opened",
        occurred_at: "2026-05-04T10:00:00Z",
      },
      {
        id: "evt-claimed-002-claimed",
        event_type: "claimed",
        occurred_at: "2026-05-04T10:05:00Z",
      },
    ],
  },
]

const _store = new Map<string, VoucherFixture>()

function ensureSeeded(): void {
  if (_store.size > 0) return
  for (const fx of DEFAULT_FIXTURES) {
    _store.set(fx.code, { ...fx, events: [...fx.events] })
  }
}

export function getFixtureByCode(code: string): VoucherFixture | null {
  ensureSeeded()
  return _store.get(code) ?? null
}

export function listFixtureCodes(): string[] {
  ensureSeeded()
  return [...Array.from(_store.keys())]
}

/**
 * Test-only injection — used by /admin/e2e-voucher-fixture endpoint to seed
 * a custom voucher (eg. one matching `E2E_CLAIM_TOKEN` extracted from a real
 * checkout). Idempotent — overwrites existing fixture under same code.
 */
export function upsertFixture(fx: VoucherFixture): void {
  ensureSeeded()
  _store.set(fx.code, { ...fx, events: [...fx.events] })
}

export function clearFixturesForTest(): void {
  _store.clear()
}
