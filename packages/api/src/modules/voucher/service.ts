/**
 * VoucherService — Medusa 2 module service.
 *
 * Story v160-cleanup-25: replaces in-memory voucher-fixture-store.ts with a
 * PG-backed service. Migrations create `voucher` + `voucher_event` tables.
 *
 * Pattern follows gp-core/service.ts (raw pg Pool, no MedusaService ORM).
 */

import { randomUUID } from "node:crypto"
import { Pool } from "pg"
import type {
  VoucherRow,
  VoucherEventRow,
  VoucherWithEvents,
  UpsertVoucherInput,
  AppendEventInput,
  ClaimResult,
} from "./models/types"

type VoucherModuleOptions = {
  databaseUrl?: string
}

function resolveDatabaseUrl(override?: string): string {
  const url = override ?? process.env.DATABASE_URL
  if (!url) throw new Error("VoucherService: DATABASE_URL not set")
  return url
}

export class VoucherService {
  private readonly moduleOptions_: VoucherModuleOptions
  private pool_: Pool | null = null
  /** @internal — for testing only: inject a mock Pool */
  _testPool?: Pool

  constructor(
    _container: Record<string, unknown> = {},
    moduleOptions: VoucherModuleOptions = {},
    moduleDeclaration: { options?: VoucherModuleOptions } = {}
  ) {
    this.moduleOptions_ = {
      ...(moduleDeclaration?.options ?? {}),
      ...(moduleOptions ?? {}),
    }
  }

  private getPool(): Pool {
    if (this._testPool) return this._testPool
    if (!this.pool_) {
      this.pool_ = new Pool({
        connectionString: resolveDatabaseUrl(this.moduleOptions_.databaseUrl),
      })
    }
    return this.pool_
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private toDate(v: Date | string | null | undefined): Date | null {
    if (v == null) return null
    return v instanceof Date ? v : new Date(v)
  }

  private rowToVoucher(row: Record<string, unknown>): VoucherRow {
    return {
      code: row.code as string,
      market_id: (row.market_id ?? null) as string | null,
      seller_id: row.seller_id as string,
      seller_name: row.seller_name as string,
      seller_handle: row.seller_handle as string,
      product_title: row.product_title as string,
      value_minor: Number(row.value_minor),
      currency_code: row.currency_code as string,
      status: row.status as VoucherRow["status"],
      expires_at: this.toDate(row.expires_at as string | Date | null),
      created_at: new Date(row.created_at as string | Date),
      updated_at: new Date(row.updated_at as string | Date),
    }
  }

  private rowToEvent(row: Record<string, unknown>): VoucherEventRow {
    return {
      id: row.id as string,
      voucher_code: row.voucher_code as string,
      event_type: row.event_type as VoucherEventRow["event_type"],
      occurred_at: new Date(row.occurred_at as string | Date),
      created_at: new Date(row.created_at as string | Date),
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async getByCode(code: string): Promise<VoucherWithEvents | null> {
    const pool = this.getPool()
    const vResult = await pool.query<Record<string, unknown>>(
      `SELECT * FROM voucher WHERE code = $1`,
      [code]
    )
    if (vResult.rows.length === 0) return null
    const voucher = this.rowToVoucher(vResult.rows[0])

    const eResult = await pool.query<Record<string, unknown>>(
      `SELECT * FROM voucher_event WHERE voucher_code = $1 ORDER BY occurred_at ASC`,
      [code]
    )
    return { ...voucher, events: eResult.rows.map((r) => this.rowToEvent(r)) }
  }

  async listCodes(): Promise<string[]> {
    const result = await this.getPool().query<{ code: string }>(
      `SELECT code FROM voucher ORDER BY created_at ASC`
    )
    return result.rows.map((r) => r.code)
  }

  async upsert(input: UpsertVoucherInput): Promise<VoucherWithEvents> {
    const pool = this.getPool()
    const expiresAt = this.toDate(input.expires_at)

    await pool.query(
      `INSERT INTO voucher (code, market_id, seller_id, seller_name, seller_handle, product_title, value_minor, currency_code, status, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
       ON CONFLICT (code) DO UPDATE SET
         market_id = EXCLUDED.market_id,
         seller_id = EXCLUDED.seller_id,
         seller_name = EXCLUDED.seller_name,
         seller_handle = EXCLUDED.seller_handle,
         product_title = EXCLUDED.product_title,
         value_minor = EXCLUDED.value_minor,
         currency_code = EXCLUDED.currency_code,
         status = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at,
         updated_at = NOW()`,
      [
        input.code,
        input.market_id ?? null,
        input.seller_id,
        input.seller_name,
        input.seller_handle,
        input.product_title,
        input.value_minor,
        input.currency_code,
        input.status,
        expiresAt,
      ]
    )

    // Idempotent event insert
    const events = input.events ?? []
    for (const evt of events) {
      await pool.query(
        `INSERT INTO voucher_event (id, voucher_code, event_type, occurred_at, created_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [evt.id, input.code, evt.event_type, this.toDate(evt.occurred_at)]
      )
    }

    const result = await this.getByCode(input.code)
    if (!result) throw new Error(`VoucherService.upsert: failed to read back ${input.code}`)
    return result
  }

  async appendEvent(
    code: string,
    event: AppendEventInput
  ): Promise<VoucherEventRow> {
    const id = randomUUID()
    const occurredAt = event.occurred_at ?? new Date()
    await this.getPool().query(
      `INSERT INTO voucher_event (id, voucher_code, event_type, occurred_at, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [id, code, event.event_type, occurredAt]
    )
    return {
      id,
      voucher_code: code,
      event_type: event.event_type,
      occurred_at: occurredAt,
      created_at: new Date(),
    }
  }

  async claim(
    code: string,
    opts: { now?: Date } = {}
  ): Promise<ClaimResult> {
    const pool = this.getPool()
    const now = opts.now ?? new Date()

    const voucher = await this.getByCode(code)
    if (!voucher) return { status: "not_found", voucher: null }

    if (voucher.status === "claimed") {
      return { status: "already_claimed", voucher }
    }

    if (voucher.expires_at && voucher.expires_at < now) {
      return { status: "expired", voucher }
    }

    // Atomic status transition + event append in a transaction
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query(
        `UPDATE voucher SET status = 'claimed', updated_at = NOW() WHERE code = $1`,
        [code]
      )
      const eventId = randomUUID()
      await client.query(
        `INSERT INTO voucher_event (id, voucher_code, event_type, occurred_at, created_at)
         VALUES ($1, $2, 'claimed', $3, NOW())`,
        [eventId, code, now]
      )
      await client.query("COMMIT")
    } catch (err) {
      await client.query("ROLLBACK")
      throw err
    } finally {
      client.release()
    }

    const updated = await this.getByCode(code)
    if (!updated) throw new Error(`VoucherService.claim: failed to read back ${code}`)
    return { status: "claimed", voucher: updated }
  }
}

export default VoucherService
