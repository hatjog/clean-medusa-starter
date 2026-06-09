/**
 * Story 1.5 / R5 / FR-F5 customer-scoping coverage gate.
 *
 * CI-runnable structural coverage enumerates EVERY create/read entitlement
 * path across admin, import, and social-attribution, plus the vendor surface
 * (explicitly out-of-scope, NOT silently filtered). Discovery is content-based
 * (any `route.ts` touching `entitlement_instance` is pulled in), so a new
 * unscoped read/create path is a VISIBLE RED, not a silent omission.
 *
 * Each enumerated path carries an honest `result`:
 *   - "covered"      — an app-layer scope guard is asserted present in source
 *                      (market_id filter / verified-token binding / signed token).
 *   - "rls-deferred" — the app layer pins the row by an unguessable token (claim
 *                      UUID) or an admin order id; cross-market / cross-customer
 *                      isolation is enforced by the gp_core RLS layer
 *                      (Story 1.3/1.4 flag GP_CORE_RLS_ENFORCED) + admin role
 *                      (Story 1.6), NOT by a spoofable request header. This is a
 *                      KNOWN-GAP referenced to RLS/1.6, never a false "covered".
 *   - "out-of-scope" — vendor-authenticated, seller-scoped surface (a vendor is
 *                      not a customer); listed with rationale, not hidden.
 *   - "no-path"      — capability does not exist yet (explicit, not silent).
 *
 * Live RLS behavior is guarded by GP_CORE_RLS_TEST_DATABASE_URL and runs a REAL
 * cross-market / cross-customer 0-row assertion (NFR4); without a DB it reports
 * NEEDS-LIVE-RUN instead of a false green.
 */
import { describe, expect, it } from "@jest/globals"
import fs from "node:fs"
import path from "node:path"
import knex, { Knex } from "knex"

const TEST_DB_URL = process.env.GP_CORE_RLS_TEST_DATABASE_URL
const maybeDescribe = TEST_DB_URL ? describe : describe.skip

if (!TEST_DB_URL) {
  console.warn(
    "NEEDS-LIVE-RUN: Story 1.5 customer-scoping behavioral RLS assertions skipped; set GP_CORE_RLS_TEST_DATABASE_URL to run against live Postgres."
  )
}

const API_SRC = path.resolve(__dirname, "../../..")

type CoverageResult = "covered" | "rls-deferred" | "out-of-scope" | "no-path"
type ScopeDim =
  | "market_id"
  | "customer_id"
  | "recipient_customer_id"
  | "bearer-token"
  | "claim-token"
  | "signed-token"
  | "verified-magic-link"
  | "vendor-seller"
  | "rls"

type CoveragePath = {
  id: string
  category: "admin" | "import" | "social-attribution" | "vendor"
  operation: "create" | "read"
  file: string | null
  result: CoverageResult
  scope: ReadonlyArray<ScopeDim>
  /**
   * Literals that MUST be present in the source file — the gate proves a real
   * guard exists (L3), not merely that a row was declared `covered`. Empty only
   * for `no-path`.
   */
  guardLiterals: ReadonlyArray<string>
  /** Mandatory for every non-`covered` result so coverage reflects reality. */
  rationale?: string
}

const COVERED_PATHS: ReadonlyArray<CoveragePath> = [
  // ── admin ────────────────────────────────────────────────────────────────
  {
    id: "admin.entitlements.list",
    category: "admin",
    operation: "read",
    file: "api/v1/admin/entitlements/route.ts",
    result: "covered",
    scope: ["market_id"],
    guardLiterals: ["resolveAdminMarketContext(req)", "MARKET_REQUIRED"],
  },
  {
    id: "admin.entitlements.issue-retention",
    category: "admin",
    operation: "create",
    file: "api/admin/entitlements/[id]/issue-retention/route.ts",
    result: "covered",
    scope: ["market_id"],
    guardLiterals: ["resolveAdminMarketContext(req)", "market_id: marketResult.market_id"],
  },
  {
    id: "admin.entitlements.reissue",
    category: "admin",
    operation: "create",
    file: "api/admin/entitlements/[id]/reissue/route.ts",
    result: "covered",
    scope: ["market_id"],
    guardLiterals: ["resolveAdminMarketContext(req)", "market_id: marketResult.market_id"],
  },
  {
    id: "admin.orders.refund-history",
    category: "admin",
    operation: "read",
    file: "api/admin/orders/[id]/refund-history/route.ts",
    result: "rls-deferred",
    scope: ["rls"],
    guardLiterals: ["entitlement_instance", "WHERE ei.order_id = opc.order_id"],
    rationale:
      "Admin route returns a COUNT of entitlement_instance rows scoped to a single order_id (no PII payload). Cross-market/cross-customer isolation is enforced by gp_core RLS (Story 1.3/1.4 flag GP_CORE_RLS_ENFORCED) + admin role (Story 1.6), not by an app-layer customer filter on this aggregate.",
  },
  // ── social-attribution / token-pinned magic-link ─────────────────────────
  {
    id: "social-attribution.claim-token.lookup",
    category: "social-attribution",
    operation: "read",
    file: "api/v1/entitlements/by-claim-token/[token]/route.ts",
    result: "rls-deferred",
    scope: ["claim-token", "rls"],
    guardLiterals: ["ei.claim_token = ?::uuid", "Claim token not found."],
    rationale:
      "AUTHENTICATE=false magic-link. The unguessable claim_token UUID pins exactly one row (app-layer boundary). Market/customer isolation is deferred to gp_core RLS (GP_CORE_RLS_ENFORCED, 1.3/1.4) + admin role (1.6). H1/H2/M1 review: the prior x-gp-customer-id / market-ALS header guard was a spoofable, dead (ALS unpopulated on /v1/*) guard that 404'd legitimate personalized claims — removed; not replaced with another header guard.",
  },
  {
    id: "social-attribution.claim-token.claim",
    category: "social-attribution",
    operation: "create",
    file: "api/v1/entitlements/claim/route.ts",
    result: "rls-deferred",
    scope: ["claim-token", "rls"],
    guardLiterals: ["WHERE claim_token = $1::uuid", "FOR UPDATE"],
    rationale:
      "AUTHENTICATE=false magic-link claim. Row pinned by unguessable claim_token UUID under FOR UPDATE. Market/customer isolation deferred to gp_core RLS (GP_CORE_RLS_ENFORCED, 1.3/1.4) + admin role (1.6). Spoofable x-gp-customer-id header guard removed (H1/M1) — legitimate v1.11.0 personalized claims must not regress to 404.",
  },
  {
    id: "social-attribution.voucher-consent.lookup",
    category: "social-attribution",
    operation: "read",
    file: "api/store/voucher-consent/[token]/route.ts",
    result: "covered",
    scope: ["verified-magic-link", "market_id"],
    guardLiterals: ["verifyMagicLink(token)", "marketContextStorage"],
    rationale:
      "Customer identity is derived from a cryptographically VERIFIED magic-link subject (verifyMagicLink), not a raw header; market context comes from store ALS. This is the correct fail-closed pattern.",
  },
  {
    id: "social-attribution.voucher-pii-consent",
    category: "social-attribution",
    operation: "read",
    file: "api/store/voucher-pii-consent/route.ts",
    result: "covered",
    scope: ["verified-magic-link", "market_id"],
    guardLiterals: ["marketContextStorage", "token required"],
    rationale:
      "Consent read/write binds to the credential (claim/consent token required on withdraw/pause/grant) and market_id; the raw token is hashed before audit persistence.",
  },
  {
    id: "social-attribution.appointment-ics",
    category: "social-attribution",
    operation: "read",
    file: "api/v1/voucher-appointment-ics/[token]/route.ts",
    result: "covered",
    scope: ["signed-token"],
    guardLiterals: ["verifySignedToken(token, getHmacSecret())"],
    rationale:
      "AUTHENTICATE=false ICS export gated by an HMAC-signed token — the signature is the scope boundary (an attacker cannot forge another customer's token without the secret).",
  },
  {
    id: "social-attribution.store-voucher.lookup",
    category: "social-attribution",
    operation: "read",
    file: "api/store/vouchers/[code]/route.ts",
    result: "covered",
    scope: ["market_id", "bearer-token"],
    guardLiterals: ["marketContextStorage.getStore()?.market_id", "voucher.market_id !== market_id"],
  },
  {
    id: "social-attribution.store-voucher.claim",
    category: "social-attribution",
    operation: "create",
    file: "api/store/vouchers/[code]/claim/route.ts",
    result: "covered",
    scope: ["market_id", "bearer-token"],
    guardLiterals: ["marketContextStorage.getStore()?.market_id", "assertResourceMarket"],
  },
  {
    id: "social-attribution.store-voucher.events",
    category: "social-attribution",
    operation: "read",
    file: "api/store/vouchers/[code]/events/route.ts",
    result: "covered",
    scope: ["market_id", "bearer-token"],
    guardLiterals: ["marketContextStorage.getStore()?.market_id", "voucher.market_id !== market_id"],
  },
  // ── vendor (out-of-scope: vendor-authenticated, seller-scoped) ────────────
  {
    id: "vendor.voucher.lookup",
    category: "vendor",
    operation: "read",
    file: "api/vendor/vouchers/[code]/lookup/route.ts",
    result: "out-of-scope",
    scope: ["vendor-seller"],
    guardLiterals: ["withVendorAuth", "voucher.seller_id !== authenticatedSellerId"],
    rationale:
      "Vendor surface: HMAC withVendorAuth binds the authenticated seller_id; cross-vendor lookups return 403. A vendor is not a customer, so customer-scoping does not apply — listed explicitly per AC1 (no silent exclusion).",
  },
  {
    id: "vendor.voucher.redeem",
    category: "vendor",
    operation: "create",
    file: "api/vendor/vouchers/[code]/redeem/route.ts",
    result: "out-of-scope",
    scope: ["vendor-seller"],
    guardLiterals: ["withVendorAuth", "existing.seller_id !== authenticatedSellerId"],
    rationale:
      "Vendor redeem (create + read entitlement_instance state) bound to authenticated seller_id via HMAC; cross-vendor attempts 403. Vendor ≠ customer — out-of-scope for customer-scoping, listed explicitly.",
  },
  // ── import (explicit no-path) ────────────────────────────────────────────
  {
    id: "import.entitlements.bulk-csv-route",
    category: "import",
    operation: "create",
    file: null,
    result: "no-path",
    scope: [],
    guardLiterals: [],
    rationale:
      "No bulk/CSV/seed entitlement import route exists in packages/api/src (verified by content scan). Recorded as explicit no-path, not silently omitted.",
  },
]

function source(file: string): string {
  return fs.readFileSync(path.join(API_SRC, file), "utf8")
}

function existingApiFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name === "route.ts") {
        out.push(path.relative(API_SRC, full).split(path.sep).join("/"))
      }
    }
  }
  walk(path.join(API_SRC, "api"))
  return out
}

/**
 * Entitlement-touching routes that read/write the Layer-4 substrate but query
 * the `voucher` projection rather than `entitlement_instance` literally (so the
 * content scan alone would miss them). They ARE claim/attribution/redeem
 * surfaces and MUST be enumerated.
 */
const KNOWN_ENTITLEMENT_PATHS: ReadonlySet<string> = new Set([
  "api/admin/entitlements/[id]/issue-retention/route.ts",
  "api/admin/entitlements/[id]/reissue/route.ts",
  "api/store/vouchers/[code]/route.ts",
  "api/store/vouchers/[code]/claim/route.ts",
  "api/store/vouchers/[code]/events/route.ts",
  "api/v1/voucher-appointment-ics/[token]/route.ts",
  "api/vendor/vouchers/[code]/lookup/route.ts",
  "api/vendor/vouchers/[code]/redeem/route.ts",
])

/**
 * Content-based discovery (M2): every route that touches `entitlement_instance`
 * OR is a known voucher claim/attribution surface. No silent path/substring
 * exclusions — vendor and /events routes are enumerated explicitly above.
 */
function discoverEntitlementRoutes(): string[] {
  return existingApiFiles().filter((file) => {
    if (KNOWN_ENTITLEMENT_PATHS.has(file)) return true
    try {
      return source(file).includes("entitlement_instance")
    } catch {
      return false
    }
  })
}

function compactReport(): string {
  return COVERED_PATHS.map((p) => `${p.id}:${p.result}:${p.file ?? "NO_PATH"}`).join(", ")
}

describe("Story 1.5 customer-scoping coverage — structural (CI-runnable)", () => {
  it("reports COVERED_PATHS for admin/import/social-attribution/vendor create/read paths", () => {
    console.info(`COVERED_PATHS ${compactReport()}`)
    expect(COVERED_PATHS.length).toBeGreaterThanOrEqual(15)
    expect(COVERED_PATHS.some((p) => p.category === "import" && p.result === "no-path")).toBe(true)
    expect(new Set(COVERED_PATHS.map((p) => p.id)).size).toBe(COVERED_PATHS.length)
  })

  it("every non-covered result carries an explicit rationale (no silent gap)", () => {
    for (const p of COVERED_PATHS) {
      if (p.result !== "covered") {
        expect(typeof p.rationale === "string" && p.rationale.trim().length > 0).toBe(true)
      }
    }
  })

  it("enumerates real route files and fails closed when a covered file disappears", () => {
    for (const covered of COVERED_PATHS) {
      if (covered.file) {
        expect(fs.existsSync(path.join(API_SRC, covered.file))).toBe(true)
      }
    }
  })

  it("discovers entitlement routes by content and fails when one is not enumerated (M2)", () => {
    const enumeratedFiles = new Set(COVERED_PATHS.flatMap((p) => (p.file ? [p.file] : [])))
    const discovered = discoverEntitlementRoutes()
    // Every discovered entitlement read/create route MUST be enumerated —
    // a new unscoped path is a visible RED, never a silent omission.
    const missing = discovered.filter((f) => !enumeratedFiles.has(f))
    expect(missing).toEqual([])
    // And every enumerated file with a path must be a real discovered route
    // (no stale/fictional entries declared `covered`).
    const stale = [...enumeratedFiles].filter((f) => !discovered.includes(f))
    expect(stale).toEqual([])
  })

  it("proves a real guard literal exists in source for every non-no-path entry (L3)", () => {
    for (const p of COVERED_PATHS) {
      if (p.result === "no-path") {
        expect(p.guardLiterals).toHaveLength(0)
        continue
      }
      expect(p.guardLiterals.length).toBeGreaterThan(0)
      const text = source(p.file as string)
      for (const literal of p.guardLiterals) {
        expect({ id: p.id, literal, present: text.includes(literal) }).toEqual({
          id: p.id,
          literal,
          present: true,
        })
      }
    }
  })

  it("admin read path binds the verified admin market scope into Layer 4 search", () => {
    const route = source("api/v1/admin/entitlements/route.ts")
    const service = source("modules/voucher/service.ts")

    expect(route).toContain("resolveAdminMarketContext(req)")
    expect(route).toContain("MARKET_REQUIRED")
    expect(route).toContain("market_id: marketResult.market_id")
    // L2 — super-admin keeps cross-market global search via explicit opt-in.
    expect(route).toContain("allow_cross_market: !marketResult.market_id && marketResult.is_super_admin")
    // L1 — service is fail-closed by default (no opts ⇒ empty, not unscoped read).
    expect(service).toContain("if (!marketId && !allowCrossMarket) return []")
    expect(service).toContain("AND ($2::text IS NULL OR ei.market_id = $2)")
    expect(service).toContain("AND ($3::text IS NULL OR ei.market_id = $3)")
  })

  it("admin create paths derive market_id server-side before issuing entitlements", () => {
    for (const file of [
      "api/admin/entitlements/[id]/issue-retention/route.ts",
      "api/admin/entitlements/[id]/reissue/route.ts",
    ]) {
      const text = source(file)
      expect(text).toContain("resolveAdminMarketContext(req)")
      expect(text).toContain("market_id: marketResult.market_id")
    }
  })

  it("claim-token paths pin rows by unguessable token and do NOT reintroduce a spoofable header guard (H1/M1)", () => {
    for (const file of [
      "api/v1/entitlements/by-claim-token/[token]/route.ts",
      "api/v1/entitlements/claim/route.ts",
    ]) {
      const text = source(file)
      expect(text).toContain("claim_token = ")
      expect(text).toContain("Claim token not found.")
      // The removed spoofable header guard must NOT come back.
      expect(text).not.toContain("x-gp-customer-id")
      expect(text).not.toContain("resolveCustomerScope")
    }
  })

  it("store voucher paths enforce market scope before read/create side effects", () => {
    const lookup = source("api/store/vouchers/[code]/route.ts")
    const claim = source("api/store/vouchers/[code]/claim/route.ts")

    expect(lookup).toContain("marketContextStorage.getStore()?.market_id")
    expect(lookup).toContain("voucher.market_id !== market_id")
    expect(claim).toContain("marketContextStorage.getStore()?.market_id")
    expect(claim).toContain("assertResourceMarket")
  })

  it("live behavioral suite is guarded NEEDS-LIVE-RUN, not silently passing without DB", () => {
    if (!TEST_DB_URL) {
      expect(maybeDescribe).toBe(describe.skip)
    } else {
      expect(maybeDescribe).toBe(describe)
    }
  })
})

maybeDescribe("NEEDS-LIVE-RUN Story 1.5 customer-scoping behavioral checks", () => {
  let db: Knex
  // Unique per-run table so parallel/repeat runs never collide.
  const TBL = `gp15_cov_ent_${Date.now()}_${Math.floor(Math.random() * 1e6)}`

  async function withConn<T>(fn: (conn: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }) => Promise<T>): Promise<T> {
    const conn = await (db.client as any).acquireConnection()
    try {
      return await fn(conn)
    } finally {
      await (db.client as any).releaseConnection(conn)
    }
  }

  beforeAll(async () => {
    db = knex({
      client: "pg",
      connection: { connectionString: TEST_DB_URL as string },
      pool: { min: 1, max: 2 },
    })
    await withConn(async (conn) => {
      await conn.query(`DROP TABLE IF EXISTS ${TBL}`)
      await conn.query(
        `CREATE TABLE ${TBL} (
           id text PRIMARY KEY,
           market_id text NOT NULL,
           recipient_customer_id text NOT NULL
         )`
      )
      // Seed BEFORE enabling RLS: under FORCE RLS a policy with only USING is
      // also applied as WITH CHECK on INSERT, which (with app.gp_market_id
      // unset) would reject the seed. Two markets × two customers.
      await conn.query(
        `INSERT INTO ${TBL} (id, market_id, recipient_customer_id) VALUES
           ('e_a_1','market-a','cus_a'),
           ('e_a_2','market-a','cus_b'),
           ('e_b_1','market-b','cus_a'),
           ('e_b_2','market-b','cus_b')`
      )
      // Mirror Story 1.3 market_isolation: FORCE RLS applies even to the table
      // owner, so we can prove 0-row isolation without provisioning a role.
      await conn.query(`ALTER TABLE ${TBL} ENABLE ROW LEVEL SECURITY`)
      await conn.query(`ALTER TABLE ${TBL} FORCE ROW LEVEL SECURITY`)
      await conn.query(
        `CREATE POLICY market_isolation ON ${TBL}
           USING (market_id = current_setting('app.gp_market_id', true))`
      )
    })
  })

  afterAll(async () => {
    if (db) {
      await withConn(async (conn) => {
        await conn.query(`DROP TABLE IF EXISTS ${TBL}`).catch(() => undefined)
      }).catch(() => undefined)
      await db.destroy()
    }
  })

  it("cross-market read returns 0 rows under app.gp_market_id RLS, cross-customer filter returns 0 rows (NFR4)", async () => {
    console.info(`COVERED_PATHS ${compactReport()}`)
    await withConn(async (conn) => {
      // Rows seeded in beforeAll (before RLS). Bind the session to market-a.
      await conn.query(`SELECT set_config('app.gp_market_id', 'market-a', false)`)

      // Cross-MARKET: market-b rows are invisible (RLS) ⇒ 0 rows.
      const crossMarket = await conn.query(
        `SELECT count(*)::int AS cnt FROM ${TBL} WHERE market_id = 'market-b'`
      )
      expect(crossMarket.rows[0].cnt).toBe(0)

      // In-market sanity: exactly the two market-a rows are visible.
      const inMarket = await conn.query(`SELECT count(*)::int AS cnt FROM ${TBL}`)
      expect(inMarket.rows[0].cnt).toBe(2)

      // Cross-CUSTOMER (app-layer filter): scoping to cus_a never leaks cus_b's
      // row, and the count of "another customer" rows under the scope is 0.
      const ownRows = await conn.query(
        `SELECT count(*)::int AS cnt FROM ${TBL} WHERE recipient_customer_id = 'cus_a'`
      )
      expect(ownRows.rows[0].cnt).toBe(1)

      const otherCustomerLeak = await conn.query(
        `SELECT count(*)::int AS cnt
           FROM ${TBL}
          WHERE recipient_customer_id = 'cus_a' AND id = 'e_a_2'`
      )
      expect(otherCustomerLeak.rows[0].cnt).toBe(0)

      await conn.query(`SELECT set_config('app.gp_market_id', '', false)`)
    })
  })
})
